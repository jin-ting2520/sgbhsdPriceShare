'use strict';

/**
 * 账号与会话：
 *  - scrypt 密码哈希
 *  - 多设备会话（sessions 表），每账号设备数上限（默认 3，管理员可调）
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
    `SELECT s.id AS sessionId, s.device_id AS deviceId, s.token AS sessionToken,
            a.id, a.name, a.token, a.relief, a.status, a.expires_at AS expiresAt,
            a.device_limit AS deviceLimit, a.current_server AS currentServer,
            a.allow_sync_server AS allowSyncServer, a.view_master_prices AS viewMasterPrices
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

const lastTouch = new Map();
async function touchSession(sessionId) {
  const t = Date.now();
  if ((lastTouch.get(sessionId) || 0) > t - 120000) return;
  lastTouch.set(sessionId, t);
  await run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowText(), sessionId]);
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
        req.session = { id: row.sessionId, deviceId: row.deviceId, token: row.sessionToken };
        touchSession(row.sessionId).catch(() => {});
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

/* ------------------------------ 设备会话 ------------------------------ */

async function listSessions(accountId) {
  return query(
    `SELECT id, device_name AS deviceName, ip, created_at AS createdAt, last_seen_at AS lastSeenAt
       FROM sessions WHERE account_id = ? ORDER BY id DESC`,
    [accountId]
  );
}

async function createSession(accountId, { deviceId, deviceName, ip }) {
  const token = newSession();
  const t = nowText();
  await run(
    'INSERT INTO sessions (token, account_id, device_id, device_name, ip, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [token, accountId, deviceId || null, deviceName || null, ip || null, t, t]
  );
  return token;
}

async function countSessions(accountId) {
  const row = await get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', [accountId]);
  return Number(row.n) || 0;
}

async function removeSession(accountId, sessionId) {
  const info = await run('DELETE FROM sessions WHERE account_id = ? AND id = ?', [accountId, sessionId]);
  return info.affectedRows > 0;
}

async function removeOtherSessions(accountId, keepId) {
  const info = await run('DELETE FROM sessions WHERE account_id = ? AND id <> ?', [accountId, keepId]);
  return info.affectedRows;
}

async function removeAllSessions(accountId) {
  const info = await run('DELETE FROM sessions WHERE account_id = ?', [accountId]);
  return info.affectedRows;
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
  listSessions,
  createSession,
  countSessions,
  removeSession,
  removeOtherSessions,
  removeAllSessions,
};
