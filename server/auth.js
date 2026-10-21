'use strict';

/**
 * 账号与会话：
 *  - scrypt 密码哈希
 *  - 每账号最多保存若干设备记录（account_devices），同一设备可有多个会话
 *  - 会话含水印（会话 token 即请求签名密钥）+ 设备绑定（X-Device-Id）
 *  - 卡密到期 / 封禁校验
 */

const crypto = require('node:crypto');
const { get, run, query, nowText } = require('./db');
const { fail } = require('./util');

const HEADER = 'x-account-token';
const DEVICE_HEADER = 'x-device-id';
const SESSION_RE = /^[a-f0-9]{64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
});

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || expected.length !== 64) return false;
  const key = await scrypt(password, salt);
  return crypto.timingSafeEqual(key, expected);
}

const newSession = () => crypto.randomBytes(32).toString('hex');

/** 按会话 token 载入账号（含设备校验所需字段），无则返回 null */
async function loadSession(token) {
  if (!SESSION_RE.test(String(token || ''))) return null;
  const row = await get(
    `SELECT s.id AS sessionId, s.device_id AS deviceId, s.device_ref_id AS deviceRefId,
            s.token AS sessionToken,
            a.id, a.name, a.token, a.relief, a.status, a.expires_at AS expiresAt,
            a.device_limit AS deviceLimit, a.current_server AS currentServer,
            a.allow_sync_server AS allowSyncServer, a.view_master_prices AS viewMasterPrices,
            a.allow_master_prices AS masterPricesAllowed
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ?`,
    [String(token)]
  );
  return row || null;
}

/** 账号可用性校验：封禁 / 到期 */
function accountBlocked(account) {
  if (!account) return null;
  if (account.status === 'banned') {
    return { status: 403, code: 40302, message: '账号已被封禁，如有疑问请联系管理员' };
  }
  const expiresAt = account.expiresAt || account.expires_at;
  if (expiresAt && String(expiresAt) < nowText()) {
    return { status: 403, code: 40301, message: '卡密已到期或试用已结束，请重新登录并输入新卡密，或联系管理员续期' };
  }
  return null;
}

const metaText = (value, max = 40) => String(value == null ? '' : value).trim().slice(0, max);

/** 浏览器上报的设备特征，仅用于无持久设备 ID 时的兜底识别 */
function normalizeDeviceMeta(meta) {
  const src = meta && typeof meta === 'object' ? meta : {};
  return {
    platform: metaText(src.platform, 60),
    screen: metaText(src.screen, 24),
    timezone: metaText(src.timezone, 60),
    language: metaText(src.language, 24),
    cores: metaText(src.cores, 6),
    memory: metaText(src.memory, 8),
    touch: metaText(src.touch, 6),
    standalone: src.standalone ? '1' : '0',
  };
}

function deviceFingerprint(meta, userAgent) {
  const raw = [
    metaText(userAgent, 160),
    meta.platform, meta.screen, meta.timezone, meta.language,
    meta.cores, meta.memory, meta.touch, meta.standalone,
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function resolveDeviceId(rawId, fingerprint) {
  const id = String(rawId || '').trim();
  if (DEVICE_RE.test(id)) return id;
  return fingerprint ? `fp-${fingerprint.slice(0, 32)}` : '';
}

function deviceDisplayName(name, deviceId) {
  const base = metaText(name, 72);
  const suffix = String(deviceId || '').slice(-4).toUpperCase();
  if (!suffix) return base || '未知设备';
  if (base.toUpperCase().includes(suffix)) return base.slice(0, 80);
  return `${base || '设备'} · ${suffix}`.slice(0, 80);
}

const lastTouch = new Map();
async function touchSession(sessionId, deviceRefId) {
  const t = Date.now();
  if ((lastTouch.get(sessionId) || 0) > t - 120000) return;
  lastTouch.set(sessionId, t);
  const seenAt = nowText();
  await run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [seenAt, sessionId]);
  if (deviceRefId) {
    await run('UPDATE account_devices SET last_seen_at = ? WHERE id = ?', [seenAt, deviceRefId]);
  }
}

async function attach(req, res, next) {
  try {
    req.account = null;
    req.session = null;
    req.authError = null;
    const token = String(req.get(HEADER) || '').trim();
    const row = await loadSession(token);
    if (row) {
      const device = String(req.get(DEVICE_HEADER) || '').trim();
      if (row.deviceId && device && row.deviceId !== device) {
        req.authError = { status: 401, message: '设备与登录会话不匹配，请重新登录' };
      } else {
        req.account = row;
        req.session = {
          id: row.sessionId, deviceId: row.deviceId,
          deviceRefId: row.deviceRefId, token: row.sessionToken,
        };
        touchSession(row.sessionId, row.deviceRefId).catch(() => {});
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireAccount(req, res, next) {
  if (!req.account) {
    if (req.authError) return fail(res, req.authError.status, req.authError.message, 40111);
    return fail(res, 401, '请先登录账号');
  }
  const blocked = accountBlocked(req.account);
  if (blocked) return fail(res, blocked.status, blocked.message, blocked.code);
  next();
}

async function getAccountByName(name) {
  return get('SELECT * FROM accounts WHERE name = ?', [name]);
}

async function setAccountToken(accountId, token) {
  await run('UPDATE accounts SET token = ?, updated_at = ? WHERE id = ?', [token || null, nowText(), accountId]);
}

/* ------------------------------ 设备记录与设备会话 ------------------------------ */

/** 唯一设备记录；current 表示是否为当前会话所在设备 */
async function listDevices(accountId, currentSessionId = null) {
  const rows = await query(
    `SELECT d.id, d.device_id AS deviceId, d.device_name AS deviceName,
            d.platform, d.ip, d.created_at AS createdAt, d.last_seen_at AS lastSeenAt,
            (SELECT COUNT(*) FROM sessions s WHERE s.device_ref_id = d.id) AS activeSessions,
            (SELECT COUNT(*) FROM sessions s
              WHERE s.device_ref_id = d.id AND s.id = ?) AS is_current
       FROM account_devices d
      WHERE d.account_id = ?
      ORDER BY d.last_seen_at DESC, d.id DESC`,
    [currentSessionId, accountId]
  );
  return rows.map(row => {
    const activeSessions = Number(row.activeSessions) || 0;
    return {
      ...row,
      activeSessions,
      online: activeSessions > 0,
      current: Number(row.is_current) > 0,
    };
  });
}

async function getDevice(accountId, deviceId) {
  return get(
    'SELECT * FROM account_devices WHERE account_id = ? AND device_id = ?',
    [accountId, deviceId]
  );
}

async function countDevices(accountId) {
  const row = await get('SELECT COUNT(*) AS n FROM account_devices WHERE account_id = ?', [accountId]);
  return Number(row.n) || 0;
}

async function ensureDevice(accountId, {
  deviceId, fingerprint, deviceName, platform, ip,
}) {
  const existing = await getDevice(accountId, deviceId);
  const t = nowText();
  const name = deviceDisplayName(deviceName, deviceId);
  if (existing) {
    await run(
      `UPDATE account_devices
          SET fingerprint = COALESCE(?, fingerprint), device_name = ?,
              platform = COALESCE(?, platform), ip = ?, last_seen_at = ?
        WHERE id = ?`,
      [fingerprint || null, name, platform || null, ip || null, t, existing.id]
    );
    return { ...existing, deviceName: name, fingerprint: fingerprint || existing.fingerprint };
  }
  const info = await run(
    `INSERT INTO account_devices
      (account_id, device_id, fingerprint, device_name, platform, ip, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [accountId, deviceId, fingerprint || null, name,
      platform || null, ip || null, t, t]
  );
  return {
    id: info.insertId, account_id: accountId, device_id: deviceId,
    fingerprint: fingerprint || null, device_name: name,
    platform: platform || null, ip: ip || null,
  };
}

async function createSession(accountId, {
  deviceId, deviceRefId, deviceName, ip,
}) {
  const token = newSession();
  const t = nowText();
  await run(
    `INSERT INTO sessions
      (token, account_id, device_ref_id, device_id, device_name, ip, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [token, accountId, deviceRefId || null, deviceId || null,
      deviceName || null, ip || null, t, t]
  );
  return token;
}

async function removeSession(accountId, sessionId) {
  const info = await run('DELETE FROM sessions WHERE account_id = ? AND id = ?', [accountId, sessionId]);
  return info.affectedRows > 0;
}

async function removeAllSessions(accountId) {
  const info = await run('DELETE FROM sessions WHERE account_id = ?', [accountId]);
  return info.affectedRows;
}

/** 删除设备记录及其全部会话；普通退出登录只删会话，不删设备记录 */
async function removeDevice(accountId, deviceRefId) {
  const device = await get(
    'SELECT id FROM account_devices WHERE account_id = ? AND id = ?',
    [accountId, deviceRefId]
  );
  if (!device) return { removed: false, count: 0, sessionIds: [], sessions: 0 };
  const sessions = await query(
    'SELECT id FROM sessions WHERE account_id = ? AND device_ref_id = ?',
    [accountId, device.id]
  );
  await run('DELETE FROM sessions WHERE account_id = ? AND device_ref_id = ?', [accountId, device.id]);
  await run('DELETE FROM account_devices WHERE account_id = ? AND id = ?', [accountId, device.id]);
  return {
    removed: true, count: 1,
    sessionIds: sessions.map(row => row.id), sessions: sessions.length,
  };
}

async function removeAllDevices(accountId) {
  const devices = await query('SELECT id FROM account_devices WHERE account_id = ?', [accountId]);
  const sessions = await query('SELECT id FROM sessions WHERE account_id = ?', [accountId]);
  await run('DELETE FROM sessions WHERE account_id = ?', [accountId]);
  await run('DELETE FROM account_devices WHERE account_id = ?', [accountId]);
  return {
    count: devices.length, sessionIds: sessions.map(row => row.id), sessions: sessions.length,
  };
}

/** 移除当前设备以外的所有设备记录及会话 */
async function removeOtherDevices(accountId, keepDeviceRefId) {
  if (!keepDeviceRefId) return removeAllDevices(accountId);
  const keep = await get(
    'SELECT id FROM account_devices WHERE account_id = ? AND id = ?',
    [accountId, keepDeviceRefId]
  );
  if (!keep) return removeAllDevices(accountId);
  const devices = await query(
    'SELECT id FROM account_devices WHERE account_id = ? AND id <> ?',
    [accountId, keep.id]
  );
  const sessions = await query(
    `SELECT id FROM sessions
      WHERE account_id = ? AND (device_ref_id IS NULL OR device_ref_id <> ?)`,
    [accountId, keep.id]
  );
  await run(
    `DELETE FROM sessions
      WHERE account_id = ? AND (device_ref_id IS NULL OR device_ref_id <> ?)`,
    [accountId, keep.id]
  );
  await run('DELETE FROM account_devices WHERE account_id = ? AND id <> ?', [accountId, keep.id]);
  return {
    count: devices.length, sessionIds: sessions.map(row => row.id), sessions: sessions.length,
  };
}

module.exports = {
  HEADER,
  DEVICE_HEADER,
  SESSION_RE,
  DEVICE_RE,
  hashPassword,
  verifyPassword,
  newSession,
  loadSession,
  accountBlocked,
  attach,
  requireAccount,
  getAccountByName,
  setAccountToken,
  normalizeDeviceMeta,
  deviceFingerprint,
  resolveDeviceId,
  deviceDisplayName,
  listDevices,
  getDevice,
  countDevices,
  ensureDevice,
  createSession,
  removeSession,
  removeAllSessions,
  removeDevice,
  removeAllDevices,
  removeOtherDevices,
};
