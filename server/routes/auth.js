'use strict';

/** 账号入口：卡密注册 / 密码登录 / 设备记录 / 游戏 token / 赋税减免 */

const express = require('express');
const { ok, fail, asyncHandler, cleanName, isUniqueConstraintError } = require('../util');
const {
  hashPassword, verifyPassword, requireAccount, accountBlocked,
  getAccountByName, setAccountToken, normalizeDeviceMeta, deviceFingerprint,
  resolveDeviceId, listDevices, getDevice, countDevices, ensureDevice,
  createSession, removeSession, removeDevice, removeOtherDevices, removeAllDevices,
} = require('../auth');
const {
  get, run, tx, nowText, parseTime, getAppSettings, claimLegacyData, normalizeKeyRequiredAt,
  upsertServer, setCurrentServer,
} = require('../db');
const { clampRelief } = require('../tax');
const { validateKey, useKey, expiresAtFor, KEY_TYPE_NAMES } = require('../keys');
const { masterMeta } = require('../master');
const { broadcast, closeSessions, issueTicket } = require('../ws');
const rateLimit = require('../ratelimit');

const router = express.Router();

const PASSWORD_MIN = 4;
const PASSWORD_REGISTER_MIN = 8;
const PASSWORD_MAX = 64;

function readCredentials(body) {
  const name = cleanName(body && body.name, 20);
  const password = body && typeof body.password === 'string' ? body.password : '';
  return { name, password };
}

async function publicAccount(row, created, session, extra = {}) {
  const meta = await masterMeta(row);
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
    masterAccountId: meta.masterAccountId,
    masterAccountName: meta.masterAccountName,
    isMaster: meta.isMaster,
    masterPricesAllowed: meta.masterPricesAllowed,
    viewMasterPrices: meta.viewMasterPrices,
    ...extra,
  };
}

function renewBaseMs(expiresAt) {
  if (!expiresAt) return Date.now();
  const ts = parseTime(expiresAt);
  return Number.isFinite(ts) && ts > Date.now() ? ts : Date.now();
}

/** POST /api/auth/login { name, password, key?, mode?, deviceId, deviceName, deviceMeta, kick? }
 *  设备记录达到上限时返回 409；kick=all 或设备记录编号可移除后继续登录。
 *  mode=login：仅允许已注册账号登录，绝不创建账号；
 *  mode=register：仅允许新昵称注册，已有账号返回提示；
 *  未传 mode 时保留旧的自动识别行为。 */
router.post('/login', rateLimit.middleware(40, 5 * 60 * 1000), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { name, password } = readCredentials(body);
  if (!name) return fail(res, 400, '请输入昵称');
  if (password.length < PASSWORD_MIN) return fail(res, 400, `密码至少 ${PASSWORD_MIN} 位`);
  if (password.length > PASSWORD_MAX) return fail(res, 400, `密码最长 ${PASSWORD_MAX} 位`);

  const deviceMeta = normalizeDeviceMeta(body.deviceMeta);
  const fingerprint = deviceFingerprint(deviceMeta, req.get('user-agent'));
  const deviceId = resolveDeviceId(body.deviceId, fingerprint);
  const deviceName = String(body.deviceName || deviceMeta.platform || '未知设备').trim().slice(0, 80);
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
    const knownDevice = await getDevice(existing.id, deviceId);
    if (!knownDevice) {
      const used = await countDevices(existing.id);
      if (used >= limit) {
        const kick = body.kick;
        if (kick === 'all') {
          const removed = await removeAllDevices(existing.id);
          closeSessions(removed.sessionIds);
        } else if (Number.isInteger(Number(kick)) && Number(kick) > 0) {
          const kicked = await removeDevice(existing.id, Number(kick));
          if (!kicked.removed) return fail(res, 400, '要移除的设备记录不存在，请刷新设备列表后重试');
          closeSessions(kicked.sessionIds);
        } else {
          const devices = await listDevices(existing.id);
          return res.status(409).json({
            code: 40910,
            message: `该账号最多保存 ${limit} 台设备记录，请先移除一台设备后再登录`,
            data: {
              limit,
              devices,
              sessions: devices.map(device => ({ ...device, current: false })),
            },
          });
        }
      }
    }

    let renewed = null;
    if (keyCode) {
      try {
        renewed = await tx(async conn => {
          const valid = await validateKey(conn, keyCode);
          if (valid.error) throw Object.assign(new Error(valid.error), { status: 400 });
          const expiresAt = expiresAtFor(valid.row.type, renewBaseMs(existing.expires_at));
          const usedKey = await useKey(conn, valid.row.id, existing.id);
          if (!usedKey) throw Object.assign(new Error('卡密刚刚已被使用，请联系管理员'), { status: 400 });
          await conn.run(
            'UPDATE accounts SET key_code = ?, expires_at = ?, updated_at = ? WHERE id = ?',
            [valid.row.code, expiresAt, nowText(), existing.id]
          );
          return { expiresAt, code: valid.row.code, keyType: valid.row.type };
        });
      } catch (err) {
        if (err.status) return fail(res, err.status, err.message, 40011);
        throw err;
      }
      existing.key_code = renewed.code;
      existing.expires_at = renewed.expiresAt;
    }

    const device = await ensureDevice(existing.id, {
      deviceId, fingerprint, deviceName, platform: deviceMeta.platform, ip: req.ip,
    });
    const session = await createSession(existing.id, {
      deviceId, deviceRefId: device.id, deviceName: device.deviceName || deviceName, ip: req.ip,
    });
    return ok(res, await publicAccount(existing, false, session, renewed ? {
      renewed: true,
      keyType: KEY_TYPE_NAMES[renewed.keyType] || renewed.keyType,
      deviceId,
    } : { deviceId }));
  }

  // ---------- 新账号：卡密注册 / 限时试用 ----------
  if (mode === 'login') return fail(res, 404, '账号不存在，请先注册', 40401);
  if (!settings.registrationEnabled) return fail(res, 403, '注册通道已关闭，请联系管理员', 40303);
  if (settings.keyRequired && !keyCode) {
    return fail(res, 400, '卡密已启用，首次注册需要输入卡密', 40010);
  }
  if (password.length < PASSWORD_REGISTER_MIN) {
    return fail(res, 400, `注册密码至少 ${PASSWORD_REGISTER_MIN} 位`);
  }

  const passwordHash = await hashPassword(password);
  const t = nowText();
  let created;
  try {
    created = await tx(async conn => {
      const dup = await conn.get('SELECT id FROM accounts WHERE name = ?', [name]);
      if (dup) throw Object.assign(new Error('该昵称刚刚被注册，请直接登录'), { status: 400 });
      let code = '';
      let keyType = null;
      let keyId = 0;
      let expiresAt = normalizeKeyRequiredAt(settings.keyRequiredAt);
      if (keyCode) {
        const valid = await validateKey(conn, keyCode);
        if (valid.error) throw Object.assign(new Error(valid.error), { status: 400 });
        code = valid.row.code;
        keyType = valid.row.type;
        keyId = valid.row.id;
        expiresAt = expiresAtFor(valid.row.type);
      }
      const info = await conn.run(
        `INSERT INTO accounts (name, password_hash, relief, status, expires_at, key_code, device_limit,
                               view_master_prices, created_at, updated_at)
         VALUES (?, ?, 5, 'active', ?, ?, ?, 1, ?, ?)`,
        [name, passwordHash, expiresAt, code || null, settings.defaultDeviceLimit, t, t]
      );
      if (keyCode) {
        const used = await useKey(conn, keyId, info.insertId);
        if (!used) throw Object.assign(new Error('卡密刚刚已被使用，请联系管理员'), { status: 400 });
      }
      const row = await conn.get('SELECT * FROM accounts WHERE id = ?', [info.insertId]);
      return { row, keyType };
    });
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message, 40011);
    if (isUniqueConstraintError(err)) return fail(res, 400, '该昵称刚刚被注册，请直接登录', 40011);
    throw err;
  }

  try {
    await claimLegacyData(created.row.id);
  } catch (err) {
    console.warn('[auth] 旧数据接管失败:', err.message);
  }

  const device = await ensureDevice(created.row.id, {
    deviceId, fingerprint, deviceName, platform: deviceMeta.platform, ip: req.ip,
  });
  const session = await createSession(created.row.id, {
    deviceId, deviceRefId: device.id, deviceName: device.deviceName || deviceName, ip: req.ip,
  });
  return ok(res, await publicAccount(created.row, true, session, {
    keyType: created.keyType ? (KEY_TYPE_NAMES[created.keyType] || created.keyType) : null,
    deviceId,
  }));
}));

/** POST /api/auth/logout 退出当前设备 */
router.post('/logout', requireAccount, asyncHandler(async (req, res) => {
  await removeSession(req.account.id, req.session.id);
  closeSessions([req.session.id]);
  return ok(res, null);
}));

/** GET /api/auth/me 当前账号信息 */
router.get('/me', requireAccount, asyncHandler(async (req, res) => {
  const row = await get(
    'SELECT name, token, relief, created_at AS createdAt, current_server AS currentServer, allow_sync_server AS allowSyncServer, status, expires_at AS expiresAt, device_limit AS deviceLimit, key_code AS keyCode, view_master_prices AS viewMasterPrices, allow_master_prices AS masterPricesAllowed FROM accounts WHERE id = ?',
    [req.account.id]
  );
  const meta = await masterMeta({
    id: req.account.id,
    currentServer: row.currentServer,
    viewMasterPrices: row.viewMasterPrices,
    masterPricesAllowed: row.masterPricesAllowed,
  });
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
    masterAccountId: meta.masterAccountId,
    masterAccountName: meta.masterAccountName,
    isMaster: meta.isMaster,
    masterPricesAllowed: meta.masterPricesAllowed,
    viewMasterPrices: meta.viewMasterPrices,
  });
}));

/** POST /api/auth/ws-ticket 签发一次性 WebSocket 连接票据 */
router.post('/ws-ticket', requireAccount, asyncHandler(async (req, res) => {
  return ok(res, { ticket: issueTicket(req.account, req.session), expiresIn: 60 });
}));

/** PUT /api/auth/server { server } 设置当前所在区服 */
router.put('/server', requireAccount, asyncHandler(async (req, res) => {
  const server = cleanName(req.body && req.body.server, 50);
  if (!server) return fail(res, 400, '请输入当前所在区服');
  await upsertServer(server);
  await setCurrentServer(req.account.id, server);
  const meta = await masterMeta({
    id: req.account.id,
    currentServer: server,
    viewMasterPrices: req.account.viewMasterPrices,
    masterPricesAllowed: req.account.masterPricesAllowed,
  });
  return ok(res, {
    currentServer: server,
    masterAccountId: meta.masterAccountId,
    masterAccountName: meta.masterAccountName,
    isMaster: meta.isMaster,
    masterPricesAllowed: meta.masterPricesAllowed,
    viewMasterPrices: meta.viewMasterPrices,
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

/** PUT /api/auth/master-prices { enabled } 开启/关闭查看主账号价格 */
router.put('/master-prices', requireAccount, asyncHandler(async (req, res) => {
  const enabled = req.body && req.body.enabled;
  if (typeof enabled !== 'boolean') return fail(res, 400, 'enabled 必须为布尔值');
  const meta = await masterMeta(req.account);
  if (!meta.server) return fail(res, 400, '请先选择当前所在区服');
  if (meta.isMaster) return fail(res, 400, '主账号无需开启价格共享');
  if (!meta.masterPricesAllowed) return fail(res, 403, '管理员已关闭该账号的主账号价格共享');
  if (enabled && !meta.master) return fail(res, 400, '当前区服尚未指定主账号');
  await run(
    'UPDATE accounts SET view_master_prices = ?, updated_at = ? WHERE id = ?',
    [enabled ? 1 : 0, nowText(), req.account.id]
  );
  broadcast('master.preference', { enabled }, { accountId: req.account.id });
  return ok(res, { enabled });
}));

/** PUT /api/auth/token { token } 仅更新本账号的游戏登录 token */
router.put('/token', requireAccount, asyncHandler(async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (token && token.length < 60) return fail(res, 400, '登录 token 格式不正确，长度过短');
  await setAccountToken(req.account.id, token);
  return ok(res, { token });
}));

/** GET /api/auth/sessions|devices 本账号设备记录（同设备可有多个在线会话） */
router.get(['/sessions', '/devices'], requireAccount, asyncHandler(async (req, res) => {
  const rows = await listDevices(req.account.id, req.session.id);
  return ok(res, {
    limit: Math.max(1, Number(req.account.deviceLimit) || 3),
    items: rows.map(device => ({
      id: device.id,
      deviceId: device.deviceId,
      deviceName: device.deviceName || '未知设备',
      platform: device.platform || '',
      ip: device.ip || '',
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      activeSessions: device.activeSessions,
      online: device.online,
      current: device.current,
    })),
  });
}));

/** DELETE /api/auth/sessions|devices/:id 移除设备记录及其全部会话（可移除自己=注销） */
router.delete(['/sessions/:id', '/devices/:id'], requireAccount, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '设备编号不正确');
  const removed = await removeDevice(req.account.id, id);
  if (!removed.removed) return fail(res, 404, '该设备记录不存在或已移除');
  closeSessions(removed.sessionIds);
  return ok(res, {
    id,
    deleted: true,
    self: id === Number(req.session.deviceRefId),
    sessions: removed.sessions,
  });
}));

/** POST /api/auth/sessions|devices/kick-others 移除其他全部设备及会话 */
router.post(['/sessions/kick-others', '/devices/kick-others'], requireAccount, asyncHandler(async (req, res) => {
  const removed = await removeOtherDevices(req.account.id, req.session.deviceRefId);
  closeSessions(removed.sessionIds);
  return ok(res, { count: removed.count, sessions: removed.sessions });
}));

module.exports = router;
