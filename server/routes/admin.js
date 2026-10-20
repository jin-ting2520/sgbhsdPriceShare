'use strict';

/** 管理后台 API：卡密 / 账号 / 字典 / 区服 / 全局设置 / 同步日志
 *  鉴权：POST /login 校验 ADMIN_PASSWORD（环境变量），发放内存 token，
 *  有效期默认 7 天，可用 ADMIN_TOKEN_HOURS 调整；其余接口要求 X-Admin-Token 头。
 *  ADMIN_PASSWORD 未配置时禁用整个后台。 */

const crypto = require('node:crypto');
const express = require('express');
const { ok, fail, asyncHandler, cleanName, isBlank } = require('../util');
const { query, get, run, tx, nowText, formatTime, parseTime, normalizeKeyRequiredAt } = require('../db');
const { createBatch, KEY_TYPES, KEY_TYPE_NAMES, KEY_STATUS_NAMES, normalizeCode, expiresAtFor } = require('../keys');
const { renderMarkdown, MAX_MARKDOWN } = require('../markdown');
const { hashPassword } = require('../auth');
const rateLimit = require('../ratelimit');
const ws = require('../ws');
const { invalidateDict } = require('../dict-cache');

const router = express.Router();
const TTL_DEFAULT_HOURS = 7 * 24;
const TTL_HOURS = Math.min(365 * 24, Math.max(1, Number(process.env.ADMIN_TOKEN_HOURS) || TTL_DEFAULT_HOURS));
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;
const tokens = new Map(); // token -> expiresAt

const CLEAN_TIMER = setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tokens) if (exp <= now) tokens.delete(t);
}, 60 * 1000);
if (CLEAN_TIMER.unref) CLEAN_TIMER.unref();

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

router.post('/login', rateLimit.middleware(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const expected = adminPassword();
  if (!expected) {
    return fail(res, 503, '后台未启用：服务端未配置 ADMIN_PASSWORD 环境变量', 50301);
  }
  const password = String((req.body && req.body.password) || '');
  const a = Buffer.from(password, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return fail(res, 401, '管理密码不正确');
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, Date.now() + TTL_MS);
  return ok(res, { token, expiresAt: formatTime(Date.now() + TTL_MS) });
}));

function requireAdmin(req, res, next) {
  if (!adminPassword()) return fail(res, 503, '后台未启用：服务端未配置 ADMIN_PASSWORD 环境变量', 50301);
  const token = String(req.get('x-admin-token') || '').trim();
  const exp = tokens.get(token);
  if (!token || !exp || exp <= Date.now()) return fail(res, 401, '管理登录已过期，请重新登录', 40101);
  req.adminToken = token;
  next();
}

router.use(requireAdmin);

router.post('/logout', (req, res) => {
  tokens.delete(req.adminToken);
  ok(res, null);
});

/* ------------------------------ 概览 ------------------------------ */

router.get('/overview', asyncHandler(async (req, res) => {
  const row = await get(`SELECT
    (SELECT COUNT(*) FROM accounts) AS accounts,
    (SELECT COUNT(*) FROM accounts WHERE status = 'banned') AS banned,
    (SELECT COUNT(*) FROM accounts WHERE expires_at IS NOT NULL AND expires_at < ?) AS expired,
    (SELECT COUNT(*) FROM sessions) AS sessions,
    (SELECT COUNT(*) FROM invite_keys WHERE status = 'unused') AS keysUnused,
    (SELECT COUNT(*) FROM invite_keys WHERE status = 'used') AS keysUsed,
    (SELECT COUNT(*) FROM prices) AS prices,
    (SELECT COUNT(*) FROM price_history) AS history,
    (SELECT COUNT(*) FROM servers) AS servers`, [nowText()]);
  const sync = await get(`SELECT
    SUM(CASE WHEN status IN ('success', 'partial') THEN 1 ELSE 0 END) AS ok,
    COUNT(*) AS total FROM sync_log`);
  return ok(res, {
    accounts: Number(row.accounts) || 0,
    banned: Number(row.banned) || 0,
    expired: Number(row.expired) || 0,
    sessions: Number(row.sessions) || 0,
    keysUnused: Number(row.keysUnused) || 0,
    keysUsed: Number(row.keysUsed) || 0,
    prices: Number(row.prices) || 0,
    history: Number(row.history) || 0,
    servers: Number(row.servers) || 0,
    syncOk: Number(sync.ok) || 0,
    syncTotal: Number(sync.total) || 0,
    adminTtlHours: TTL_MS / 3600000,
  });
}));

/* ------------------------------ 卡密 ------------------------------ */

function keyFilters(q) {
  const where = [];
  const params = [];
  const status = String(q.status || '').trim();
  const type = String(q.type || '').trim();
  const batch = String(q.batch || '').trim();
  const search = String(q.q || '').trim();
  if (KEY_STATUS_NAMES[status]) { where.push('k.status = ?'); params.push(status); }
  if (KEY_TYPES[type]) { where.push('k.type = ?'); params.push(type); }
  if (batch) { where.push('k.batch_id = ?'); params.push(batch); }
  if (search) { where.push('(k.code LIKE ? OR k.note LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/keys', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 500);
  const f = keyFilters(req.query);
  const totalRow = await get(`SELECT COUNT(*) AS n FROM invite_keys k ${f.sql}`, f.params);
  const rows = await query(
    `SELECT k.*, a.name AS accountName FROM invite_keys k
       LEFT JOIN accounts a ON a.id = k.account_id
       ${f.sql} ORDER BY k.id DESC LIMIT ? OFFSET ?`,
    [...f.params, pageSize, (page - 1) * pageSize]
  );
  return ok(res, {
    total: Number(totalRow.n) || 0,
    page,
    pageSize,
    items: rows.map(r => ({
      id: r.id,
      code: r.code,
      type: r.type,
      typeName: KEY_TYPE_NAMES[r.type] || r.type,
      status: r.status,
      statusName: KEY_STATUS_NAMES[r.status] || r.status,
      note: r.note || '',
      batchId: r.batch_id || '',
      accountId: r.account_id || null,
      accountName: r.accountName || '',
      createdAt: r.created_at,
      usedAt: r.used_at || null,
    })),
  });
}));

router.post('/keys', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const type = String(body.type || '').trim();
  if (!KEY_TYPES[type]) return fail(res, 400, '卡密类型必须为 day（1 天）/ month（1 月）/ forever（永久）');
  const note = cleanName(body.note, 100);
  const created = await createBatch({ type, count: body.count, note });
  return ok(res, {
    batchId: created.batchId,
    type: created.type,
    typeName: KEY_TYPE_NAMES[created.type],
    count: created.count,
    codes: created.codes,
  });
}));

router.get('/keys/export', asyncHandler(async (req, res) => {
  const f = keyFilters(req.query);
  const rows = await query(
    `SELECT k.*, a.name AS accountName FROM invite_keys k
       LEFT JOIN accounts a ON a.id = k.account_id
       ${f.sql} ORDER BY k.id DESC LIMIT 5000`,
    f.params
  );
  const header = '卡密,类型,状态,备注,批次,使用账号,生成时间,使用时间';
  const lines = rows.map(r => [
    r.code, KEY_TYPE_NAMES[r.type] || r.type, KEY_STATUS_NAMES[r.status] || r.status,
    r.note || '', r.batch_id || '', r.accountName || '', r.created_at || '', r.used_at || '',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="invite-keys-${Date.now()}.csv"`);
  res.send(`\uFEFF${[header, ...lines].join('\r\n')}`);
}));

router.post('/keys/revoke', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const batchId = String(body.batchId || '').trim();
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  if (!batchId && !ids.length) return fail(res, 400, '请提供要作废的卡密 id 列表或批次号');
  let info;
  if (batchId) {
    info = await run("UPDATE invite_keys SET status = 'revoked' WHERE batch_id = ? AND status = 'unused'", [batchId]);
  } else {
    const marks = ids.map(() => '?').join(',');
    info = await run(`UPDATE invite_keys SET status = 'revoked' WHERE id IN (${marks}) AND status = 'unused'`, ids);
  }
  return ok(res, { revoked: info.affectedRows });
}));

router.get('/batches', asyncHandler(async (req, res) => {
  const rows = await query(`SELECT batch_id AS batchId, type,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) AS unused,
      SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used,
      SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
      MIN(created_at) AS createdAt, MAX(note) AS note
    FROM invite_keys GROUP BY batch_id, type ORDER BY createdAt DESC LIMIT 200`);
  return ok(res, rows.map(r => ({
    batchId: r.batchId || '（无批次）',
    type: r.type,
    typeName: KEY_TYPE_NAMES[r.type] || r.type,
    total: Number(r.total) || 0,
    unused: Number(r.unused) || 0,
    used: Number(r.used) || 0,
    revoked: Number(r.revoked) || 0,
    createdAt: r.createdAt,
    note: r.note || '',
  })));
}));

/** 直接把未使用卡密绑定到账号；卡密只能消耗一次，到期时间从账号当前有效期顺延，永久账号则从现在重新计时 */
router.post('/keys/:id/bind', asyncHandler(async (req, res) => {
  const keyId = Number(req.params.id);
  if (!Number.isInteger(keyId) || keyId <= 0) return fail(res, 400, '卡密 id 不正确');
  const body = req.body || {};
  const accountId = Number(body.accountId);
  const accountName = cleanName(body.accountName);
  if (!Number.isInteger(accountId) && !accountName) {
    return fail(res, 400, '请选择要绑定的账号');
  }

  const bad = (status, message) => Object.assign(new Error(message), { status });
  try {
    const bound = await tx(async conn => {
      const key = await conn.get('SELECT * FROM invite_keys WHERE id = ?', [keyId]);
      if (!key) throw bad(404, '卡密不存在');
      if (key.status === 'revoked') throw bad(400, '卡密已作废');
      if (key.status !== 'unused') throw bad(400, '卡密已被使用，不能重复绑定');
      if (!KEY_TYPES[key.type]) throw bad(400, '卡密类型无效');

      const account = accountId > 0
        ? await conn.get('SELECT * FROM accounts WHERE id = ?', [accountId])
        : await conn.get('SELECT * FROM accounts WHERE name = ?', [accountName]);
      if (!account) throw bad(404, '账号不存在');

      const currentMs = parseTime(account.expires_at);
      const base = Number.isFinite(currentMs) && currentMs > Date.now() ? currentMs : Date.now();
      const expiresAt = expiresAtFor(key.type, base);
      const info = await conn.run(
        "UPDATE invite_keys SET status = 'used', used_at = ?, account_id = ? WHERE id = ? AND status = 'unused'",
        [nowText(), account.id, key.id]
      );
      if (!info.affectedRows) throw bad(400, '卡密刚刚已被使用，请刷新重试');
      await conn.run(
        'UPDATE accounts SET expires_at = ?, key_code = ?, updated_at = ? WHERE id = ?',
        [expiresAt, key.code, nowText(), account.id]
      );
      return {
        keyId: key.id,
        keyCode: key.code,
        keyType: KEY_TYPE_NAMES[key.type] || key.type,
        accountId: account.id,
        accountName: account.name,
        expiresAt,
      };
    });
    return ok(res, bound);
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    throw err;
  }
}));

/* ------------------------------ 账号 ------------------------------ */

router.get('/accounts', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 500);
  const where = [];
  const params = [];
  const search = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  if (search) { where.push('a.name LIKE ?'); params.push(`%${search}%`); }
  if (status === 'active' || status === 'banned') { where.push('a.status = ?'); params.push(status); }
  if (status === 'expired') { where.push('a.expires_at IS NOT NULL AND a.expires_at < ?'); params.push(nowText()); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await get(`SELECT COUNT(*) AS n FROM accounts a ${whereSql}`, params);
  const masterRows = await query(
    `SELECT sm.account_id AS accountId, s.name AS server
       FROM server_masters sm JOIN servers s ON s.id = sm.server_id`
  );
  const masterServers = new Map();
  for (const row of masterRows) {
    const accountId = Number(row.accountId);
    if (!masterServers.has(accountId)) masterServers.set(accountId, []);
    masterServers.get(accountId).push(row.server);
  }
  const rows = await query(
    `SELECT a.id, a.name, a.status, a.expires_at AS expiresAt, a.key_code AS keyCode,
            a.device_limit AS deviceLimit, a.current_server AS currentServer,
            a.allow_sync_server AS allowSyncServer, a.view_master_prices AS viewMasterPrices,
            a.allow_master_prices AS masterPricesAllowed,
            a.created_at AS createdAt, a.updated_at AS updatedAt, a.relief,
            (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id) AS sessions,
            (SELECT COUNT(*) FROM prices p WHERE p.account_id = a.id) AS prices,
            (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id) AS lastSeenAt,
            (SELECT i.type FROM invite_keys i WHERE i.code = a.key_code) AS keyType
       FROM accounts a ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  const now = nowText();
  return ok(res, {
    total: Number(totalRow.n) || 0,
    page,
    pageSize,
    items: rows.map(r => {
      const servers = masterServers.get(Number(r.id)) || [];
      const currentServer = r.currentServer || '';
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        expiresAt: r.expiresAt || null,
        expired: !!r.expiresAt && r.expiresAt < now,
        keyCode: r.keyCode || '',
        keyType: KEY_TYPE_NAMES[r.keyType] || (r.keyType ? r.keyType : ''),
        deviceLimit: Number(r.deviceLimit) || 3,
        currentServer,
        allowSyncServer: !!Number(r.allowSyncServer),
        isMaster: servers.length > 0,
        isCurrentServerMaster: !!currentServer && servers.includes(currentServer),
        masterServers: servers,
        masterPricesAllowed: !!Number(r.masterPricesAllowed),
        viewMasterPrices: !!Number(r.viewMasterPrices),
        sessions: Number(r.sessions) || 0,
        prices: Number(r.prices) || 0,
        lastSeenAt: r.lastSeenAt || null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }),
  });
}));

async function loadAccount(id) {
  return get('SELECT * FROM accounts WHERE id = ?', [id]);
}

router.post('/accounts/:id/status', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const status = String((req.body && req.body.status) || '').trim();
  if (!['active', 'banned'].includes(status)) return fail(res, 400, 'status 必须为 active / banned');
  const account = await loadAccount(id);
  if (!account) return fail(res, 404, '账号不存在');
  await run('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?', [status, nowText(), id]);
  if (status === 'banned') {
    const { removeAllSessions } = require('../auth');
    await removeAllSessions(id);
  }
  return ok(res, { id, status });
}));

/** 调整到期：{ expiresAt } 直接覆盖（null=永久）| { extendDays } 顺延 | { keyCode } 绑定未使用卡密（永久账号从现在重新计时） */
router.post('/accounts/:id/expires', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const account = await loadAccount(id);
  if (!account) return fail(res, 404, '账号不存在');
  const body = req.body || {};
  const keyCode = account.key_code || null;

  if ('expiresAt' in body) {
    let expiresAt = null;
    if (body.expiresAt != null && body.expiresAt !== '') {
      const parsed = String(body.expiresAt).trim().replace('T', ' ').slice(0, 19);
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(parsed)) {
        return fail(res, 400, 'expiresAt 格式应为 YYYY-MM-DD HH:MM:SS 或留空（永久）');
      }
      expiresAt = parsed;
    }
    await run(
      'UPDATE accounts SET expires_at = ?, key_code = ?, updated_at = ? WHERE id = ?',
      [expiresAt, keyCode, nowText(), id]
    );
    return ok(res, { id, expiresAt, keyCode });
  }

  if (body.extendDays != null) {
    const days = Number(body.extendDays);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) return fail(res, 400, 'extendDays 应为 1~3650');
    const parsedBase = parseTime(account.expires_at);
    const base = Number.isFinite(parsedBase) && parsedBase > Date.now() ? parsedBase : Date.now();
    const expiresAt = formatTime(base + days * 86400000);
    await run(
      'UPDATE accounts SET expires_at = ?, key_code = ?, updated_at = ? WHERE id = ?',
      [expiresAt, keyCode, nowText(), id]
    );
    return ok(res, { id, expiresAt, keyCode });
  }

  if (body.keyCode) {
    const code = normalizeCode(body.keyCode);
    const bad = (status, message) => Object.assign(new Error(message), { status });
    try {
      const bound = await tx(async conn => {
        const key = await conn.get('SELECT * FROM invite_keys WHERE code = ?', [code]);
        if (!key) throw bad(404, '卡密不存在');
        if (key.status === 'revoked') throw bad(400, '卡密已作废');
        if (key.status !== 'unused') throw bad(400, '卡密已被使用，不能重复绑定');
        if (!KEY_TYPES[key.type]) throw bad(400, '卡密类型无效');
        const current = await conn.get('SELECT expires_at FROM accounts WHERE id = ?', [id]);
        if (!current) throw bad(404, '账号不存在');
        const currentMs = parseTime(current.expires_at);
        const base = Number.isFinite(currentMs) && currentMs > Date.now() ? currentMs : Date.now();
        const expiresAt = expiresAtFor(key.type, base);
        const info = await conn.run(
          "UPDATE invite_keys SET status = 'used', used_at = ?, account_id = ? WHERE id = ? AND status = 'unused'",
          [nowText(), id, key.id]
        );
        if (!info.affectedRows) throw bad(400, '卡密刚刚已被使用，请刷新重试');
        await conn.run(
          'UPDATE accounts SET expires_at = ?, key_code = ?, updated_at = ? WHERE id = ?',
          [expiresAt, key.code, nowText(), id]
        );
        return { id, expiresAt, keyCode: key.code };
      });
      return ok(res, bound);
    } catch (err) {
      if (err.status) return fail(res, err.status, err.message);
      throw err;
    }
  }

  return fail(res, 400, '请提供 expiresAt / extendDays / keyCode 之一');
}));

router.post('/accounts/:id/device-limit', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const limit = Number((req.body && req.body.limit) || 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(res, 400, '设备上限应为 1~50 的整数');
  const account = await loadAccount(id);
  if (!account) return fail(res, 404, '账号不存在');
  await run('UPDATE accounts SET device_limit = ?, updated_at = ? WHERE id = ?', [limit, nowText(), id]);
  return ok(res, { id, limit });
}));

/** 是否允许该账号在同步时提交区服参数覆盖自动识别（默认关闭） */
router.post('/accounts/:id/sync-server', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const allowed = req.body && req.body.allow;
  if (typeof allowed !== 'boolean') return fail(res, 400, 'allow 必须为布尔值');
  const account = await loadAccount(id);
  if (!account) return fail(res, 404, '账号不存在');
  await run(
    'UPDATE accounts SET allow_sync_server = ?, updated_at = ? WHERE id = ?',
    [allowed ? 1 : 0, nowText(), id]
  );
  return ok(res, { id, allowSyncServer: allowed });
}));

/** 允许/禁止指定账号查看主账号价格；禁止后用户端隐藏开关 */
router.post('/accounts/:id/master-prices', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const allowed = req.body && req.body.allowed;
  if (typeof allowed !== 'boolean') return fail(res, 400, 'allowed 必须为布尔值');
  const account = await loadAccount(id);
  if (!account) return fail(res, 404, '账号不存在');

  const masterRow = await get('SELECT 1 AS hit FROM server_masters WHERE account_id = ? LIMIT 1', [id]);
  if (masterRow) return fail(res, 400, '主账号无需设置价格共享');

  await run(
    'UPDATE accounts SET allow_master_prices = ?, view_master_prices = ?, updated_at = ? WHERE id = ?',
    [allowed ? 1 : 0, allowed ? 1 : 0, nowText(), id]
  );
  ws.broadcast('master.preference', { enabled: allowed, allowed }, { accountId: id });
  return ok(res, { id, masterPricesAllowed: allowed, viewMasterPrices: allowed });
}));

router.post('/accounts/:id/password', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const password = String((req.body && req.body.password) || '');
  if (password.length < 4 || password.length > 64) return fail(res, 400, '密码长度应为 4~64 位');
  const account = await loadAccount(id);
  if (!account) return fail(res, 404, '账号不存在');
  const hash = await hashPassword(password);
  await run('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, nowText(), id]);
  const { removeAllSessions } = require('../auth');
  await removeAllSessions(id);
  return ok(res, { id, reset: true });
}));

router.post('/accounts/:id/kick', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { removeAllSessions } = require('../auth');
  const count = await removeAllSessions(id);
  return ok(res, { id, count });
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const account = await loadAccount(id);
  if (!account) return fail(res, 404, '账号不存在');
  if (String(req.query.confirm || '') !== account.name) {
    return fail(res, 400, `删除账号将清空其全部价格数据，请携带 confirm=${account.name} 以确认`);
  }
  const masterRows = await query(
    `SELECT s.name AS server FROM server_masters sm JOIN servers s ON s.id = sm.server_id
      WHERE sm.account_id = ?`,
    [id]
  );
  await tx(async conn => {
    await conn.run('DELETE FROM sessions WHERE account_id = ?', [id]);
    await conn.run('DELETE FROM price_history WHERE account_id = ?', [id]);
    await conn.run('DELETE FROM prices WHERE account_id = ?', [id]);
    await conn.run('DELETE FROM city_taxes WHERE account_id = ?', [id]);
    await conn.run('DELETE FROM sync_settings WHERE account_id = ?', [id]);
    await conn.run('DELETE FROM sync_log WHERE account_id = ?', [id]);
    await conn.run('UPDATE invite_keys SET account_id = NULL WHERE account_id = ?', [id]);
    await conn.run('DELETE FROM server_masters WHERE account_id = ?', [id]);
    for (const row of masterRows) {
      await conn.run('UPDATE accounts SET view_master_prices = 0 WHERE current_server = ?', [row.server]);
    }
    await conn.run('DELETE FROM accounts WHERE id = ?', [id]);
  });
  for (const row of masterRows) {
    ws.broadcast('master.changed', {
      server: row.server,
      masterAccountId: null,
      masterAccountName: '',
    });
  }
  return ok(res, { id, deleted: true });
}));

/* ------------------------------ 区服 ------------------------------ */

router.get('/servers', asyncHandler(async (req, res) => {
  const rows = await query(`SELECT s.id, s.name, s.created_at AS createdAt, s.updated_at AS updatedAt,
      sm.account_id AS masterAccountId, ma.name AS masterAccountName,
      (SELECT COUNT(*) FROM prices p WHERE p.server_id = s.id) AS prices,
      (SELECT COUNT(*) FROM sync_settings ss WHERE ss.server_name = s.name) AS boundAccounts
    FROM servers s
    LEFT JOIN server_masters sm ON sm.server_id = s.id
    LEFT JOIN accounts ma ON ma.id = sm.account_id
    ORDER BY s.id ASC`);
  const accountRows = await query(
    `SELECT id, name, current_server AS currentServer FROM accounts
      WHERE current_server <> '' ORDER BY name ASC`
  );
  const byServer = new Map();
  for (const account of accountRows) {
    if (!byServer.has(account.currentServer)) byServer.set(account.currentServer, []);
    byServer.get(account.currentServer).push({ id: account.id, name: account.name });
  }
  return ok(res, rows.map(r => {
    const masterAccountId = r.masterAccountId == null ? null : Number(r.masterAccountId);
    const candidates = [...(byServer.get(r.name) || [])];
    if (masterAccountId && !candidates.some(a => a.id === masterAccountId)) {
      candidates.unshift({ id: masterAccountId, name: r.masterAccountName || `#${masterAccountId}` });
    }
    return {
      id: r.id,
      name: r.name,
      prices: Number(r.prices) || 0,
      boundAccounts: Number(r.boundAccounts) || 0,
      masterAccountId,
      masterAccountName: r.masterAccountName || '',
      masterCandidates: candidates,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }));
}));

async function applyServerMaster(server, account) {
  await tx(async conn => {
    await conn.run('DELETE FROM server_masters WHERE server_id = ?', [server.id]);
    if (account) {
      await conn.run(
        `INSERT INTO server_masters (server_id, account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        [server.id, account.id, nowText(), nowText()]
      );
      await conn.run(
        `UPDATE accounts SET view_master_prices =
           CASE WHEN allow_master_prices = 1 AND id <> ? THEN 1 ELSE 0 END
         WHERE current_server = ?`,
        [account.id, server.name]
      );
    } else {
      await conn.run('UPDATE accounts SET view_master_prices = 0 WHERE current_server = ?', [server.name]);
    }
  });

  const payload = {
    id: server.id,
    name: server.name,
    masterAccountId: account ? account.id : null,
    masterAccountName: account ? account.name : '',
  };
  ws.broadcast('master.changed', {
    server: server.name,
    masterAccountId: payload.masterAccountId,
    masterAccountName: payload.masterAccountName,
  });
  return payload;
}

/** 账号管理：按账号当前区服设置/取消主账号 */
router.post('/accounts/:id/master', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const master = req.body && req.body.master;
  if (typeof master !== 'boolean') return fail(res, 400, 'master 必须为布尔值');
  const account = await loadAccount(id);
  if (!account) return fail(res, 404, '账号不存在');
  const serverName = cleanName(account.current_server, 50);
  if (!serverName) return fail(res, 400, '该账号尚未设置当前区服，请让用户先选择区服');
  const server = await get('SELECT * FROM servers WHERE name = ?', [serverName]);
  if (!server) return fail(res, 400, `当前区服 ${serverName} 不存在，请先在区服页新增`);

  if (!master) {
    const current = await get('SELECT account_id AS accountId FROM server_masters WHERE server_id = ?', [server.id]);
    if (!current || Number(current.accountId) !== id) {
      return ok(res, { id, name: server.name, masterAccountId: null, masterAccountName: '', changed: false });
    }
  }
  const data = await applyServerMaster(server, master ? account : null);
  return ok(res, { ...data, changed: true });
}));

/** 设置/取消区服主账号；主账号必须属于该区服，设置后本区服普通账号默认开启共享 */
router.post('/servers/:id/master', asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!Number.isInteger(serverId) || serverId <= 0) return fail(res, 400, '区服 id 不正确');
  const server = await get('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!server) return fail(res, 404, '区服不存在');

  const raw = req.body && req.body.accountId;
  const accountId = raw == null || raw === '' ? null : Number(raw);
  if (accountId != null && (!Number.isInteger(accountId) || accountId <= 0)) {
    return fail(res, 400, '账号 id 不正确');
  }

  let account = null;
  if (accountId != null) {
    account = await loadAccount(accountId);
    if (!account) return fail(res, 404, '账号不存在');
    if (account.current_server !== server.name) {
      return fail(res, 400, `账号「${account.name}」当前区服不是 ${server.name}，不能设为本区服主账号`);
    }
  }

  return ok(res, await applyServerMaster(server, account));
}));

router.post('/servers', asyncHandler(async (req, res) => {
  const name = cleanName((req.body && req.body.name) || '', 50);
  if (isBlank(name)) return fail(res, 400, '请输入区服名称');
  const existing = await get('SELECT id FROM servers WHERE name = ?', [name]);
  if (existing) return fail(res, 409, '该区服已存在');
  const t = nowText();
  const info = await run('INSERT INTO servers (name, created_at, updated_at) VALUES (?, ?, ?)', [name, t, t]);
  return ok(res, { id: info.insertId, name });
}));

router.put('/servers/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const name = cleanName((req.body && req.body.name) || '', 50);
  if (isBlank(name)) return fail(res, 400, '请输入区服名称');
  const server = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!server) return fail(res, 404, '区服不存在');
  if (name !== server.name) {
    const dup = await get('SELECT id FROM servers WHERE name = ? AND id <> ?', [name, id]);
    if (dup) return fail(res, 409, '该区服名称已存在');
    await tx(async conn => {
      await conn.run('UPDATE servers SET name = ?, updated_at = ? WHERE id = ?', [name, nowText(), id]);
      await conn.run('UPDATE sync_settings SET server_name = ? WHERE server_name = ?', [name, server.name]);
      await conn.run('UPDATE accounts SET current_server = ? WHERE current_server = ?', [name, server.name]);
    });
  }
  return ok(res, { id, name });
}));

router.delete('/servers/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const server = await get('SELECT * FROM servers WHERE id = ?', [id]);
  if (!server) return fail(res, 404, '区服不存在');
  const refs = await get('SELECT COUNT(*) AS n FROM prices WHERE server_id = ?', [id]);
  if (Number(refs.n) > 0 && req.query.force !== '1') {
    return fail(res, 409, `该区服已有 ${refs.n} 条价格数据，如确认删除请携带 force=1`, 40902);
  }
  await tx(async conn => {
    await conn.run('DELETE FROM prices WHERE server_id = ?', [id]);
    await conn.run('DELETE FROM city_taxes WHERE server_id = ?', [id]);
    await conn.run('DELETE FROM servers WHERE id = ?', [id]);
  });
  return ok(res, { id, deleted: true });
}));

/* ------------------------------ 字典 ------------------------------ */

router.get('/dict', asyncHandler(async (req, res) => {
  const type = String(req.query.type || '').trim();
  const where = type ? 'WHERE type = ?' : '';
  const rows = await query(
    `SELECT id, type, name, sort_order AS sortOrder, burden, created_at AS createdAt, updated_at AS updatedAt
       FROM dict_items ${where} ORDER BY type ASC, sort_order ASC, id ASC`,
    type ? [type] : []
  );
  return ok(res, rows);
}));

router.post('/dict', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const type = String(body.type || '').trim();
  if (!['city', 'commodity'].includes(type)) return fail(res, 400, '字典类型必须为 city / commodity');
  const name = cleanName(body.name, 50);
  if (isBlank(name)) return fail(res, 400, '请输入名称');
  const existing = await get('SELECT id FROM dict_items WHERE type = ? AND name = ?', [type, name]);
  if (existing) return fail(res, 409, '该名称已存在');
  const maxRow = await get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM dict_items WHERE type = ?', [type]);
  const burden = body.burden == null || body.burden === '' ? null : Number(body.burden);
  if (burden != null && (!Number.isFinite(burden) || burden <= 0 || burden > 9999)) {
    return fail(res, 400, '负重应为大于 0 的数字（最多 9999）');
  }
  const t = nowText();
  const info = await run(
    'INSERT INTO dict_items (type, name, sort_order, burden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [type, name, Number(maxRow.m) + 1, burden, t, t]
  );
  const row = await get('SELECT * FROM dict_items WHERE id = ?', [info.insertId]);
  await invalidateDict();
  return ok(res, { id: row.id, type: row.type, name: row.name, burden: row.burden });
}));

router.put('/dict/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const row = await get('SELECT * FROM dict_items WHERE id = ?', [id]);
  if (!row) return fail(res, 404, '字典项不存在');
  const name = isBlank(req.body && req.body.name) ? row.name : cleanName(req.body.name, 50);
  const burden = (req.body && 'burden' in req.body)
    ? (isBlank(req.body.burden) ? null : Number(req.body.burden))
    : row.burden;
  if (burden != null && (!Number.isFinite(burden) || burden <= 0 || burden > 9999)) {
    return fail(res, 400, '负重应为大于 0 的数字（最多 9999）');
  }
  if (name !== row.name) {
    const dup = await get('SELECT id FROM dict_items WHERE type = ? AND name = ? AND id <> ?', [row.type, name, id]);
    if (dup) return fail(res, 409, '该名称已存在');
  }
  await run('UPDATE dict_items SET name = ?, burden = ?, updated_at = ? WHERE id = ?', [name, burden, nowText(), id]);
  await invalidateDict();
  return ok(res, { id, name, burden });
}));

router.delete('/dict/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const row = await get('SELECT * FROM dict_items WHERE id = ?', [id]);
  if (!row) return fail(res, 404, '字典项不存在');
  const refs = row.type === 'commodity'
    ? await get('SELECT COUNT(*) AS n FROM prices WHERE commodity_id = ?', [id])
    : await get('SELECT COUNT(*) AS n FROM prices WHERE city_id = ?', [id]);
  if (Number(refs.n) > 0 && !req.query.force) {
    return fail(res, 409, `该${row.type === 'commodity' ? '商品' : '城池'}已被 ${refs.n} 条价格引用，如确认删除请携带 force=1`, 40901);
  }
  if (req.query.force) {
    if (row.type === 'commodity') {
      await run('DELETE FROM prices WHERE commodity_id = ?', [id]);
    } else {
      await run('DELETE FROM prices WHERE city_id = ?', [id]);
      await run('DELETE FROM city_taxes WHERE city_id = ?', [id]);
      await run('DELETE FROM city_nodes WHERE city_name = ?', [row.name]);
    }
  }
  await run('DELETE FROM dict_items WHERE id = ?', [id]);
  await invalidateDict();
  return ok(res, { id, deleted: true });
}));

/* ------------------------------ 设置 ------------------------------ */

function appSettingsPayload(row) {
  const keyRequiredAt = normalizeKeyRequiredAt(row.key_required_at) || '2026-10-22 00:00:00';
  const keyHelpMd = row.key_help_md || '';
  const tokenHelpMd = row.token_help_md || '';
  return {
    registrationEnabled: !!Number(row.registration_enabled),
    announcement: row.announcement || '',
    keyHelpMd,
    tokenHelpMd,
    keyHelpHtml: renderMarkdown(keyHelpMd),
    tokenHelpHtml: renderMarkdown(tokenHelpMd),
    keyRequiredAt,
    keyRequired: keyRequiredAt <= nowText(),
    defaultDeviceLimit: Math.max(1, Number(row.default_device_limit) || 3),
    updatedAt: row.updated_at,
  };
}

router.get('/settings', asyncHandler(async (req, res) => {
  const row = await get('SELECT * FROM app_settings WHERE id = 1');
  return ok(res, appSettingsPayload(row));
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const row = await get('SELECT * FROM app_settings WHERE id = 1');
  const registrationEnabled = 'registrationEnabled' in body ? (body.registrationEnabled ? 1 : 0) : row.registration_enabled;
  const announcement = 'announcement' in body ? String(body.announcement || '').slice(0, 500) : row.announcement;
  const keyHelpMd = 'keyHelpMd' in body ? String(body.keyHelpMd || '') : (row.key_help_md || '');
  const tokenHelpMd = 'tokenHelpMd' in body ? String(body.tokenHelpMd || '') : (row.token_help_md || '');
  if (keyHelpMd.length > MAX_MARKDOWN || tokenHelpMd.length > MAX_MARKDOWN) {
    return fail(res, 400, `Markdown 内容最多 ${MAX_MARKDOWN} 个字符`);
  }
  let keyRequiredAt = 'keyRequiredAt' in body
    ? normalizeKeyRequiredAt(body.keyRequiredAt)
    : (normalizeKeyRequiredAt(row.key_required_at) || '2026-10-22 00:00:00');
  if (!keyRequiredAt) return fail(res, 400, '卡密启用时间格式应为 YYYY-MM-DD HH:mm:ss');
  let defaultDeviceLimit = 'defaultDeviceLimit' in body ? Number(body.defaultDeviceLimit) : Number(row.default_device_limit);
  if (!Number.isInteger(defaultDeviceLimit) || defaultDeviceLimit < 1 || defaultDeviceLimit > 20) defaultDeviceLimit = 3;
  const oldKeyRequiredAt = normalizeKeyRequiredAt(row.key_required_at) || '2026-10-22 00:00:00';
  const t = nowText();
  await tx(async conn => {
    await conn.run(
      `UPDATE app_settings SET registration_enabled = ?, announcement = ?, key_help_md = ?, token_help_md = ?,
         key_required_at = ?, default_device_limit = ?, updated_at = ? WHERE id = 1`,
      [registrationEnabled, announcement, keyHelpMd, tokenHelpMd, keyRequiredAt, defaultDeviceLimit, t]
    );
    if (keyRequiredAt !== oldKeyRequiredAt) {
      await conn.run(
        "UPDATE accounts SET expires_at = ?, updated_at = ? WHERE key_code IS NULL OR key_code = ''",
        [keyRequiredAt, t]
      );
    }
  });
  ws.broadcast('settings', { announcement, keyRequiredAt, keyRequired: keyRequiredAt <= t });
  const updated = await get('SELECT * FROM app_settings WHERE id = 1');
  return ok(res, appSettingsPayload(updated));
}));

router.post('/markdown/preview', asyncHandler(async (req, res) => {
  const text = String((req.body && req.body.text) || '');
  if (text.length > MAX_MARKDOWN) return fail(res, 400, `Markdown 内容最多 ${MAX_MARKDOWN} 个字符`);
  return ok(res, { html: renderMarkdown(text) });
}));

/* ------------------------------ 同步日志 ------------------------------ */

router.get('/sync-logs', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 500);
  const accountId = Number(req.query.accountId) || 0;
  const where = accountId ? 'WHERE l.account_id = ?' : '';
  const params = accountId ? [accountId] : [];
  const totalRow = await get(`SELECT COUNT(*) AS n FROM sync_log l ${where}`, params);
  const rows = await query(
    `SELECT l.*, l.server_name AS serverName, a.name AS accountName FROM sync_log l
       LEFT JOIN accounts a ON a.id = l.account_id
       ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  return ok(res, { total: Number(totalRow.n) || 0, page, pageSize, items: rows });
}));

router.delete('/sync-logs', asyncHandler(async (req, res) => {
  const id = Number(req.query.beforeId) || 0;
  const info = id > 0
    ? await run('DELETE FROM sync_log WHERE id < ?', [id])
    : await run('DELETE FROM sync_log');
  return ok(res, { deleted: info.affectedRows });
}));

/** 供管理端下拉复用：全量字典 */
router.get('/dict-lookup', asyncHandler(async (req, res) => {
  const cities = await query("SELECT id, name FROM dict_items WHERE type = 'city' ORDER BY sort_order, id");
  const commodities = await query(
    "SELECT id, name, burden FROM dict_items WHERE type = 'commodity' ORDER BY sort_order, id"
  );
  return ok(res, { cities, commodities });
}));

module.exports = router;
