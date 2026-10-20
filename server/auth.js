'use strict';

/** 账号密码与会话：scrypt 哈希、X-Account-Token 会话、游戏 token 隔离 */

const crypto = require('node:crypto');
const { get, run, nowText } = require('./db');
const { fail } = require('./util');

const HEADER = 'x-account-token';
const SESSION_RE = /^[a-f0-9]{64}$/;

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

async function attach(req, res, next) {
  try {
    req.account = null;
    const token = String(req.get(HEADER) || '').trim();
    if (SESSION_RE.test(token)) {
      req.account = await get('SELECT id, name, token FROM accounts WHERE session_token = ?', [token]) || null;
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireAccount(req, res, next) {
  if (!req.account) return fail(res, 401, '请先登录账号');
  next();
}

async function getAccountByName(name) {
  return get('SELECT * FROM accounts WHERE name = ?', [name]);
}

async function setAccountSession(accountId, session) {
  await run('UPDATE accounts SET session_token = ?, updated_at = ? WHERE id = ?', [session, nowText(), accountId]);
}

async function setAccountToken(accountId, token) {
  await run('UPDATE accounts SET token = ?, updated_at = ? WHERE id = ?', [token || null, nowText(), accountId]);
}

module.exports = {
  HEADER,
  hashPassword,
  verifyPassword,
  newSession,
  attach,
  requireAccount,
  getAccountByName,
  setAccountSession,
  setAccountToken,
};
