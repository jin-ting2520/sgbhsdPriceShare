'use strict';

/** 测试辅助：带 HMAC 签名的 API 客户端 / 管理后台客户端 / 卡密签发 */

const crypto = require('node:crypto');

const ADMIN_PASSWORD = 'test-admin-pass';

function makeDeviceId(prefix = 'dev') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

/** 与 server/sign.js 相同的签名算法 */
function signRequest(token, method, path, payload) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(8).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(payload === undefined ? '' : payload).digest('hex');
  const base = [method.toUpperCase(), encodeURI(path), ts, nonce, bodyHash].join('\n');
  return {
    ts,
    nonce,
    sign: crypto.createHmac('sha256', token).update(base).digest('hex'),
    bodyHash,
  };
}

function createClient(base, { token = '', deviceId, deviceName = '测试设备' } = {}) {
  const client = { token, deviceId: deviceId || makeDeviceId(), deviceName };

  client.request = async (path, { method = 'GET', body, sign = true, skipDevice = false } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (!skipDevice) headers['X-Device-Id'] = client.deviceId;
    if (client.token) {
      headers['X-Account-Token'] = client.token;
      if (sign && path !== '/api/auth/login') {
        const s = signRequest(client.token, method, path, payload);
        headers['X-Timestamp'] = s.ts;
        headers['X-Nonce'] = s.nonce;
        headers['X-Sign'] = s.sign;
      }
    }
    const res = await fetch(base + path, { method, headers, body: payload });
    const buf = Buffer.from(await res.clone().arrayBuffer());
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* csv 等非 JSON 响应 */ }
    return { status: res.status, json, text, buf, headers: res.headers };
  };

  client.get = (path, opts) => client.request(path, opts);
  client.post = (path, body, opts) => client.request(path, { ...opts, method: 'POST', body });
  client.put = (path, body, opts) => client.request(path, { ...opts, method: 'PUT', body });
  client.del = (path, opts) => client.request(path, { ...opts, method: 'DELETE' });

  /** 登录并保存会话（注册时通过 body.key 提供卡密；自动附带设备信息） */
  client.login = async (body) => {
    const payload = { deviceId: client.deviceId, deviceName: client.deviceName, ...body };
    const r = await client.request('/api/auth/login', { method: 'POST', body: payload });
    if (r.json && r.json.data && r.json.data.session) client.token = r.json.data.session;
    return r;
  };

  return client;
}

function createAdmin(base) {
  const admin = { base, token: '' };

  admin.login = async (password = ADMIN_PASSWORD) => {
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const json = await res.json().catch(() => null);
    if (json && json.data && json.data.token) admin.token = json.data.token;
    return { status: res.status, json };
  };

  admin.request = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': admin.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  admin.get = (path, opts) => admin.request(path, opts);
  admin.post = (path, body, opts) => admin.request(path, { ...opts, method: 'POST', body });
  admin.put = (path, body, opts) => admin.request(path, { ...opts, method: 'PUT', body });
  admin.del = (path, opts) => admin.request(path, { ...opts, method: 'DELETE' });

  return admin;
}

/** 通过管理后台签发卡密，返回卡密数组 */
async function issueKeys(admin, type = 'day', count = 1) {
  const r = await admin.post('/api/admin/keys', { type, count });
  if (r.status !== 200) throw new Error(`签发卡密失败: ${r.json && r.json.message}`);
  return r.json.data.codes;
}

/** 注册新账号（自动签发卡密），返回已登录的客户端 */
async function registerAccount(base, admin, { name, password = 'pass-1234', type = 'day', deviceId, deviceName } = {}) {
  const codes = await issueKeys(admin, type, 1);
  const client = createClient(base, { deviceId, deviceName });
  const r = await client.login({ name, password, key: codes[0] });
  if (r.status !== 200) {
    throw new Error(`注册失败(${r.status}): ${r.json && r.json.message}`);
  }
  client.accountId = null;
  client.registered = r.json.data;
  return client;
}

module.exports = {
  ADMIN_PASSWORD,
  makeDeviceId,
  signRequest,
  createClient,
  createAdmin,
  issueKeys,
  registerAccount,
};
