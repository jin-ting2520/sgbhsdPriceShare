'use strict';

/**
 * 工具（SgbhsdTool）→ 价格站 SSO 票据校验。
 *
 * 票据格式（与工具端一致，见 .tmp/analysis/integration/design.md）：
 *   base64url(JSON payload) + "." + hex(HMAC-SHA256(TOOL_SSO_SECRET, base64url(JSON payload)))
 *
 * payload:
 *   { v:1, iss:'sgbhsd-tool', aud:'sgbhsd-price-share', scope:'login'|'ingest',
 *     sub:'<工具用户 ID>', name:'<工具昵称>', accountExpiresAt:'<ISO 或 null>',
 *     iat:<秒>, exp:<秒>, nonce:'<32-64 hex>' }
 *
 * 校验项：签名、版本、签发方/受众、scope、iat/exp 时间窗（60s + 5s 时钟偏移）、nonce 一次性。
 * 密钥只从环境变量 TOOL_SSO_SECRET 读取，不写死秘密；生产未配置时拒绝验签（503），
 * 开发环境回退到文档约定的开发密钥并打印一次告警。
 */

const crypto = require('node:crypto');

const ISSUER = 'sgbhsd-tool';
const AUDIENCE = 'sgbhsd-price-share';
const TICKET_VERSION = 1;
/** 票据最长有效期（秒）：工具端签发 60s，服务端不接受更长的票据 */
const TICKET_TTL_SECONDS = 60;
/** 允许的时钟偏移（秒） */
const CLOCK_SKEW_SECONDS = 5;
const DEFAULT_DEV_SECRET = 'sgbhsd-tool-sso-dev-secret';
const NONCE_RE = /^[a-f0-9]{16,128}$/i;
const SIGN_RE = /^[a-f0-9]{64}$/i;
const MAX_SUBJECT_LEN = 64;
const MAX_NAME_LEN = 64;

const usedNonces = new Map(); // nonce -> 过期时间戳（ms）

const CLEAN_TIMER = setInterval(() => {
  const now = Date.now();
  for (const [nonce, exp] of usedNonces) if (exp <= now) usedNonces.delete(nonce);
}, 60 * 1000);
if (CLEAN_TIMER.unref) CLEAN_TIMER.unref();

let warnedDevSecret = false;

/** 读取密钥：生产必须配置；开发回退开发密钥并告警一次 */
function readSecret() {
  const configured = String(process.env.TOOL_SSO_SECRET || '').trim();
  if (configured) return { secret: configured };
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return { error: { status: 503, code: 50301, message: 'SSO 未配置（缺少环境变量 TOOL_SSO_SECRET）' } };
  }
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn('[sso] 未设置 TOOL_SSO_SECRET，使用开发默认密钥；生产环境必须配置相同密钥');
  }
  return { secret: DEFAULT_DEV_SECRET };
}

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(text) {
  const raw = String(text || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!raw) return null;
  const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
  try {
    return Buffer.from(raw + pad, 'base64');
  } catch {
    return null;
  }
}

function hmacHex(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const failWith = (status, code, message) => ({ error: { status, code, message } });

/**
 * 校验票据。
 * @param {string} ticket 原始票据
 * @param {'login'|'ingest'} expectedScope 期望的 scope
 * @returns {{payload: object} | {error: {status:number, code:number, message:string}}}
 */
function verifyTicket(ticket, expectedScope) {
  const raw = String(ticket || '').trim();
  if (!raw) return failWith(400, 40020, '缺少 SSO 票据');
  if (raw.length > 4096) return failWith(400, 40020, 'SSO 票据格式不正确');

  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return failWith(401, 40120, 'SSO 票据格式不正确');
  const [payloadB64, signature] = parts;
  if (!SIGN_RE.test(signature)) return failWith(401, 40120, 'SSO 票据签名格式不正确');

  const { secret, error: secretError } = readSecret();
  if (secretError) return { error: secretError };

  if (!safeEqualHex(hmacHex(secret, payloadB64), signature)) {
    return failWith(401, 40121, 'SSO 票据签名校验失败');
  }

  const payloadBuf = base64urlDecode(payloadB64);
  if (!payloadBuf) return failWith(401, 40122, 'SSO 票据内容无法解析');
  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return failWith(401, 40122, 'SSO 票据内容无法解析');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return failWith(401, 40122, 'SSO 票据内容无法解析');
  }

  if (Number(payload.v) !== TICKET_VERSION) return failWith(401, 40123, 'SSO 票据版本不受支持');
  if (payload.iss !== ISSUER) return failWith(401, 40124, 'SSO 票据签发方不正确');
  if (payload.aud !== AUDIENCE) return failWith(401, 40125, 'SSO 票据受众不正确');
  if (String(payload.scope || '') !== expectedScope) {
    return failWith(403, 40320, `SSO 票据用途不匹配（需要 ${expectedScope}）`);
  }

  const iat = Number(payload.iat);
  const exp = Number(payload.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || iat <= 0 || exp <= 0) {
    return failWith(401, 40126, 'SSO 票据时间字段不正确');
  }
  if (exp <= iat) return failWith(401, 40126, 'SSO 票据时间字段不正确');
  if (exp - iat > TICKET_TTL_SECONDS + CLOCK_SKEW_SECONDS) {
    return failWith(401, 40127, 'SSO 票据有效期过长');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < iat - CLOCK_SKEW_SECONDS) return failWith(401, 40128, 'SSO 票据尚未生效');
  if (nowSec > exp + CLOCK_SKEW_SECONDS) return failWith(401, 40129, 'SSO 票据已过期，请重新打开价格站');

  const subject = String(payload.sub == null ? '' : payload.sub).trim();
  if (!subject || subject.length > MAX_SUBJECT_LEN) {
    return failWith(401, 40130, 'SSO 票据缺少用户标识');
  }
  const name = String(payload.name == null ? '' : payload.name).trim();
  if (name.length > MAX_NAME_LEN) return failWith(401, 40131, 'SSO 票据昵称过长');

  const nonce = String(payload.nonce || '').trim();
  if (!NONCE_RE.test(nonce)) return failWith(401, 40132, 'SSO 票据随机数格式不正确');
  if (usedNonces.has(nonce)) return failWith(401, 40133, 'SSO 票据已使用，请重新打开价格站');
  // nonce 保留到票据自然过期即可；一次性使用，重复提交直接拒绝
  usedNonces.set(nonce, (exp + CLOCK_SKEW_SECONDS) * 1000);

  return { payload: { ...payload, sub: subject, name, scope: expectedScope } };
}

/** 签发票据（工具端/测试与运维排查用；密钥同样只来自环境变量） */
function buildTicket(payload, { secret, now = Date.now() } = {}) {
  const resolved = secret || readSecret().secret;
  if (!resolved) throw new Error('缺少 SSO 密钥（TOOL_SSO_SECRET）');
  const nowSec = Math.floor(now / 1000);
  const body = {
    v: TICKET_VERSION,
    iss: ISSUER,
    aud: AUDIENCE,
    scope: 'login',
    iat: nowSec,
    exp: nowSec + TICKET_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString('hex'),
    ...payload,
  };
  const encoded = base64urlEncode(Buffer.from(JSON.stringify(body), 'utf8'));
  return `${encoded}.${hmacHex(resolved, encoded)}`;
}

/** 测试用：清空 nonce 记录 */
function resetNonces() {
  usedNonces.clear();
}

module.exports = {
  ISSUER,
  AUDIENCE,
  TICKET_VERSION,
  TICKET_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  DEFAULT_DEV_SECRET,
  verifyTicket,
  buildTicket,
  resetNonces,
};
