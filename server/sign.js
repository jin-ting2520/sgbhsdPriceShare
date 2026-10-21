'use strict';

/**
 * 请求签名校验（HMAC-SHA256）：
 *   X-Sign = HMAC-SHA256(sessionToken, "METHOD\nPATH?QUERY\nTIMESTAMP\nNONCE\nSHA256(rawBody)")
 * 时间窗 ±5 分钟，nonce 10 分钟内不得重复；仅对已登录会话强制。
 */

const crypto = require('node:crypto');
const { fail } = require('./util');

const WINDOW_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const NONCE_RE = /^[a-f0-9]{16,64}$/i;
const SIGN_RE = /^[a-f0-9]{64}$/i;
const nonces = new Map(); // `${scope}:${secret}:${nonce}` -> expiresAt

const CLEAN_TIMER = setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of nonces) if (exp <= now) nonces.delete(k);
}, 60 * 1000);
if (CLEAN_TIMER.unref) CLEAN_TIMER.unref();

function bodyHash(req) {
  const raw = typeof req.rawBody === 'string' ? req.rawBody : '';
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function checkSignatureWithSecret(req, secret, scope) {
  const ts = String(req.get('x-timestamp') || '').trim();
  const nonce = String(req.get('x-nonce') || '').trim();
  const sign = String(req.get('x-sign') || '').trim().toLowerCase();
  if (!ts || !nonce || !sign) return '缺少请求签名（X-Timestamp / X-Nonce / X-Sign）';
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > WINDOW_MS) {
    return '请求时间戳无效或已过期，请校准设备时间后重试';
  }
  if (!NONCE_RE.test(nonce)) return '请求随机数格式非法';
  if (!SIGN_RE.test(sign)) return '请求签名格式非法';
  const nonceKey = `${scope}:${secret}:${nonce}`;
  if (nonces.has(nonceKey)) return '请求已过期，请勿重复提交';
  const base = [
    req.method.toUpperCase(),
    req.originalUrl || req.url || '',
    ts,
    nonce,
    bodyHash(req),
  ].join('\n');
  const expect = crypto.createHmac('sha256', secret).update(base).digest('hex');
  const a = Buffer.from(expect, 'hex');
  const b = Buffer.from(sign, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '请求签名校验失败';
  nonces.set(nonceKey, Date.now() + NONCE_TTL_MS);
  return null;
}

function checkSignature(req) {
  return checkSignatureWithSecret(req, String(req.account && req.account.sessionToken || ''), 'session');
}

function checkAdminSignature(req, adminToken) {
  return checkSignatureWithSecret(req, String(adminToken || ''), 'admin');
}

/** 已登录的请求强制签名；/api/auth/login 不签名（尚无会话密钥） */
function requireSignature(req, res, next) {
  if (!req.account || req.path === '/api/auth/login') return next();
  const err = checkSignature(req);
  if (err) return fail(res, 401, err, 40112);
  next();
}

module.exports = {
  requireSignature, checkSignature, checkAdminSignature, bodyHash, WINDOW_MS,
};
