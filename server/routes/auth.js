'use strict';

/** 账号入口：卡密注册 / 密码登录 / 多设备会话 / 游戏 token / 赋税减免 */

const express = require('express');
const { ok, fail, asyncHandler, cleanName, isUniqueConstraintError } = require('../util');
const {
  hashPassword, verifyPassword, requireAccount, accountBlocked,
  getAccountByName, setAccountToken, createSession, countSessions,
  listSessions, removeSession, removeOtherSessions, removeAllSessions,
} = require('../auth');
const { get, run, tx, nowText, parseTime, getAppSettings, claimLegacyData, normalizeKeyRequiredAt } = require('../db');
const { clampRelief } = require('../tax');
const { validateKey, useKey, expiresAtFor, KEY_TYPE_NAMES } = require('../keys');
const rateLimit = require('../ratelimit');

const router = express.Router();

const PASSWORD_MIN = 4;
const PASSWORD_MAX = 64;

function readCredentials(body) {
  const name = cleanName(body && body.name, 20);
  const password = body && typeof body.password === 'string' ? body.password : '';
  return { name, password };
}

function publicAccount(row, created, session, extra = {}) {
  return {
    name: row.name,
    session,
    token: row.token || '',
    relief: clampRelief(row.relief),
    created: !!created,
    currentServer: row.current_server || '',
    allowSyncServer: !!Number(row.allow_sync_server),
    deviceLimit: Math.max(1, Number(row.device_limit) || 3),
    expiresAt: row.expires_at || null,
    hasKey: !!row.key_code,
    trial: !row.key_code,
    keyType: row.key_code ? (extra.keyType || null) : null,
    ...extra,
  };
}

function renewBaseMs(expiresAt) {
  if (!expiresAt) return Date.now();
  const ts = parseTime(expiresAt);
  return Number.isFinite(ts) && ts > Date.now() ? ts : Date.now();
}

/** POST /api/auth/login { name, password, key?, mode?, deviceId, deviceName, kick? }
 *  mode=login：仅允许已注册账号登录，绝不创建账号；
 *  mode=register：仅允许新昵称注册，已有账号返回提示；
 *  未传 mode 时保留旧的自动识别行为。 */
router.post('/login', rateLimit.middleware(40, 5 * 60 * 1000), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { name, password } = readCredentials(body);
  if (!name) return fail(res, 400, '请输入昵称');
  if (password.length < PASSWORD_MIN) return fail(res, 400, `密码至少 ${PASSWORD_MIN} 位`);
  if (password.length > PASSWORD_MAX) return fail(res, 400, `密码最长 ${PASSWORD_MAX} 位`);

  const deviceId = String(body.deviceId || '').trim().slice(0, 64);
  const deviceName = String(body.deviceName || '').trim().slice(0, 80);
  const settings = await getAppSettings();
  const keyCode = String(body.key || '').trim();
  const mode = body.mode === 'login' || body.mode === 'register' ? body.mode : 'auto';

  const existing = await getAccountByName(name);
  if (existing) {
    if (mode === 'register') {
      return fail(res, 400, '该昵称已注册，请直接登录', 40012);
    }
    if (!(await verifyPassword(password, existing.password_hash))) {
      return fail(res, 401, '昵称或密码不正确');
    }
    if (existing.status === 'banned') return fail(res, 403, '账号已被封禁，如有疑问请联系管理员', 40302);

    if (!keyCode) {
      if (!existing.key_code && settings.keyRequired) {
        return fail(res, 403, '试用已结束，请输入卡密继续使用，或联系管理员', 40301);
      }
      const blocked = accountBlocked(existing);
      if (blocked) return fail(res, blocked.status, blocked.message, blocked.code);
    }

    const limit = Math.max(1, Number(existing.device_limit) || 3);
    const used = await countSessions(existing.id);
    if (used >= limit) {
      const kick = body.kick;
      if (kick === 'all') {
        await removeAllSessions(existing.id);
      } else if (Number.isInteger(Number(kick)) && Number(kick) > 0) {
        const okKick = await removeSession(existing.id, Number(kick));
        if (!okKick) return fail(res, 400, '要退出的设备不存在，请刷新设备列表后重试');
      } else {
        const sessions = await listSessions(existing.id);
        return res.status(409).json({
          code: 40910,
          message: `该账号最多同时登录 ${limit} 台设备，请先退出其他设备后再登录`,
          data: { limit, sessions: sessions.map(s => ({ ...s, current: false })) },
        });
      }
    }

    let renewed = null;
    if (keyCode) {
      renewed = await tx(async conn => {
        const valid = await validateKey(conn, keyCode);
        if (valid.error) return { error: valid.error };
        const expiresAt = expiresAtFor(valid.row.type, renewBaseMs(existing.expires_at));
        const usedKey = await useKey(conn, valid.row.id, existing.id);
        if (!usedKey) return { error: '卡密刚刚已被使用，请联系管理员' };
        await conn.run(
          'UPDATE accounts SET key_code = ?, expires_at = ?, updated_at = ? WHERE id = ?',
          [valid.row.code, expiresAt, nowText(), existing.id]
        );
        return { expiresAt, code: valid.row.code, keyType: valid.row.type };
      });
      if (renewed.error) return fail(res, 400, renewed.error, 40011);
      existing.key_code = renewed.code;
      existing.expires_at = renewed.expiresAt;
    }

    const session = await createSession(existing.id, { deviceId, deviceName, ip: req.ip });
    return ok(res, publicAccount(existing, false, session, renewed ? {
      renewed: true,
      keyType: KEY_TYPE_NAMES[renewed.keyType] || renewed.keyType,
    } : {}));
  }

  // ---------- 新账号：卡密注册 / 限时试用 ----------
  if (mode === 'login') return fail(res, 404, '账号不存在，请先注册', 40401);
  if (!settings.registrationEnabled) return fail(res, 403, '注册通道已关闭，请联系管理员', 40303);
  if (settings.keyRequired && !keyCode) {
    return fail(res, 400, '卡密已启用，首次注册需要输入卡密', 40010);
  }

  const passwordHash = await hashPassword(password);
  const t = nowText();
  const created = await tx(async conn => {
    const dup = await conn.get('SELECT id FROM accounts WHERE name = ?', [name]);
    if (dup) return { error: '该昵称刚刚被注册，请直接登录' };
    let code = '';
    let keyType = null;
    let keyId = 0;
    let expiresAt = normalizeKeyRequiredAt(settings.keyRequiredAt);
    if (keyCode) {
      const valid = await validateKey(conn, keyCode);
      if (valid.error) return { error: valid.error };
      code = valid.row.code;
      keyType = valid.row.type;
      keyId = valid.row.id;
      expiresAt = expiresAtFor(valid.row.type);
    }
    const info = await conn.run(
      `INSERT INTO accounts (name, password_hash, relief, status, expires_at, key_code, device_limit, created_at, updated_at)
       VALUES (?, ?, 5, 'active', ?, ?, ?, ?, ?)`,
      [name, passwordHash, expiresAt, code || null, settings.defaultDeviceLimit, t, t]
    );
    if (keyCode) {
      const used = await useKey(conn, keyId, info.insertId);
      if (!used) return { error: '卡密刚刚已被使用，请联系管理员' };
    }
    const row = await conn.get('SELECT * FROM accounts WHERE id = ?', [info.insertId]);
    return { row, keyType };
  });

  if (created.error) return fail(res, 400, created.error, 40011);

  try {
    await claimLegacyData(created.row.id);
  } catch (err) {
    console.warn('[auth] 旧数据接管失败:', err.message);
  }

  const session = await createSession(created.row.id, { deviceId, deviceName, ip: req.ip });
  return ok(res, publicAccount(created.row, true, session, {
    keyType: created.keyType ? (KEY_TYPE_NAMES[created.keyType] || created.keyType) : null,
  }));
}));

/** POST /api/auth/logout 退出当前设备 */
router.post('/logout', requireAccount, asyncHandler(async (req, res) => {
  await removeSession(req.account.id, req.session.id);
  return ok(res, null);
}));

/** GET /api/auth/me 当前账号信息 */
router.get('/me', requireAccount, asyncHandler(async (req, res) => {
  const row = await get(
    'SELECT name, token, relief, created_at AS createdAt, current_server AS currentServer, allow_sync_server AS allowSyncServer, status, expires_at AS expiresAt, device_limit AS deviceLimit, key_code AS keyCode FROM accounts WHERE id = ?',
    [req.account.id]
  );
  return ok(res, {
    name: row.name,
    token: row.token || '',
    relief: clampRelief(row.relief),
    createdAt: row.createdAt,
    currentServer: row.currentServer || '',
    allowSyncServer: !!Number(row.allowSyncServer),
    status: row.status,
    expiresAt: row.expiresAt || null,
    deviceLimit: Math.max(1, Number(row.deviceLimit) || 3),
    hasKey: !!row.keyCode,
  });
}));

/** PUT /api/auth/relief { relief } 仅更新本账号的赋税减免（0~100） */
router.put('/relief', requireAccount, asyncHandler(async (req, res) => {
  const raw = req.body && req.body.relief;
  if (raw == null || raw === '' || !Number.isFinite(Number(raw))) {
    return fail(res, 400, '请提供 0~100 的赋税减免');
  }
  const relief = clampRelief(raw);
  await run('UPDATE accounts SET relief = ?, updated_at = ? WHERE id = ?', [relief, nowText(), req.account.id]);
  return ok(res, { relief });
}));

/** PUT /api/auth/token { token } 仅更新本账号的游戏登录 token */
router.put('/token', requireAccount, asyncHandler(async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (token && token.length < 60) return fail(res, 400, '登录 token 格式不正确，长度过短');
  await setAccountToken(req.account.id, token);
  return ok(res, { token });
}));

/** GET /api/auth/sessions 本账号已登录设备列表 */
router.get('/sessions', requireAccount, asyncHandler(async (req, res) => {
  const rows = await listSessions(req.account.id);
  return ok(res, {
    limit: Math.max(1, Number(req.account.deviceLimit) || 3),
    items: rows.map(s => ({
      id: s.id,
      deviceName: s.deviceName || '未知设备',
      ip: s.ip || '',
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      current: Number(s.id) === Number(req.session.id),
    })),
  });
}));

/** DELETE /api/auth/sessions/:id 退出指定设备（可退出自己=注销） */
router.delete('/sessions/:id', requireAccount, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '设备编号不正确');
  const okDel = await removeSession(req.account.id, id);
  if (!okDel) return fail(res, 404, '该设备会话不存在或已退出');
  return ok(res, { id, deleted: true, self: id === Number(req.session.id) });
}));

/** POST /api/auth/sessions/kick-others 退出其他全部设备 */
router.post('/sessions/kick-others', requireAccount, asyncHandler(async (req, res) => {
  const count = await removeOtherSessions(req.account.id, req.session.id);
  return ok(res, { count });
}));

module.exports = router;
