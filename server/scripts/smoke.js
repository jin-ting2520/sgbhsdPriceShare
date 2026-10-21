'use strict';

/**
 * 冒烟自检：启动 HTTP 服务，验证卡密注册、签名请求、价格写入/查询、乐观并发与清理。
 * 用法：node server/scripts/smoke.js
 *   - SQLite：默认使用临时库（可设置 PRICE_DB 覆盖），不会污染 data/price.db
 *   - MySQL ：DB_DRIVER=mysql MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=...
 *   - Redis ：REDIS_URL=redis://127.0.0.1:6379 时额外验证缓存连接
 */

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const crypto = require('node:crypto');

const DRIVER = (process.env.DB_DRIVER || (process.env.MYSQL_HOST ? 'mysql' : 'sqlite')).toLowerCase();
const TEMP_DB = DRIVER !== 'mysql' && !process.env.PRICE_DB
  ? nodePath.join(os.tmpdir(), `sgbhsd-smoke-${process.pid}-${Date.now()}.db`)
  : '';
if (TEMP_DB) process.env.PRICE_DB = TEMP_DB;
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = 'smoke-admin-pass';

const assert = require('node:assert/strict');
const app = require('..');
const db = require('../db');
const cache = require('../cache');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DEVICE_ID = `smoke-${crypto.randomBytes(8).toString('hex')}`;
const REMOVE_TEMP = suffix => {
  if (!TEMP_DB) return;
  try { fs.unlinkSync(TEMP_DB + suffix); } catch { /* ignore */ }
};

async function main() {
  await db.ready();
  if (cache.REDIS_URL) await cache.connect();

  const server = app.createServer().listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let adminToken = '';
  let session = '';
  let accountId = null;
  let serverId = null;
  let accountName = '';
  const serverName = process.env.SMOKE_SERVER || `SMOKE-${Date.now()}`;

  const request = async (path, { method = 'GET', body, admin = false, signed = true } = {}) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (admin) {
      headers['X-Admin-Token'] = adminToken;
    } else if (signed && session) {
      headers['X-Account-Token'] = session;
      headers['X-Device-Id'] = DEVICE_ID;
    }
    if (admin ? adminToken : (signed && session)) {
      const ts = String(Date.now());
      const nonce = crypto.randomBytes(12).toString('hex');
      const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
      const expect = [method.toUpperCase(), path, ts, nonce, bodyHash].join('\n');
      headers['X-Timestamp'] = ts;
      headers['X-Nonce'] = nonce;
      headers['X-Sign'] = crypto.createHmac('sha256', admin ? adminToken : session).update(expect).digest('hex');
    }
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : raw });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  try {
    const health = await request('/api/health', { signed: false });
    assert.equal(health.status, 200, '健康检查应返回 200');
    assert.equal(health.json.data.driver, db.DRIVER);
    if (cache.REDIS_URL) assert.equal(health.json.data.cache, 'ok', 'Redis 应已连接');

    const adminLogin = await request('/api/admin/login', {
      method: 'POST', body: { password: ADMIN_PASSWORD }, signed: false,
    });
    assert.equal(adminLogin.status, 200, '管理后台应可登录');
    adminToken = adminLogin.json.data.token;

    const keyRes = await request('/api/admin/keys', {
      method: 'POST', body: { type: 'forever', count: 1, note: 'smoke' }, admin: true,
    });
    assert.equal(keyRes.status, 200, '应能生成卡密');
    const key = keyRes.json.data.codes[0];

    accountName = `smoke_${Date.now().toString(36)}`;
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { name: accountName, password: 'smoke-pass', key, deviceId: DEVICE_ID, deviceName: 'smoke' },
      signed: false,
    });
    assert.equal(login.status, 200, '卡密注册应成功');
    session = login.json.data.session;
    accountId = (await db.get('SELECT id FROM accounts WHERE name = ?', [accountName])).id;

    const created = await request('/api/prices', {
      method: 'POST',
      body: {
        server: serverName,
        city: '桂阳',
        operator: 'smoke',
        items: [{ commodity: '谷物', buy: 10, sell: 12 }],
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.data.created, 1);

    const queried = await request(`/api/prices?server=${encodeURIComponent(serverName)}&city=${encodeURIComponent('桂阳')}`);
    assert.equal(queried.status, 200);
    const grain = queried.json.data.items.find(i => i.commodity === '谷物');
    assert.ok(grain, '应能查询到刚写入的谷物价格');
    assert.equal(grain.buy, 10);
    assert.equal(grain.sell, 12);

    const conflicted = await request('/api/prices', {
      method: 'POST',
      body: {
        server: serverName,
        city: '桂阳',
        operator: 'smoke',
        items: [{ commodity: '谷物', buy: 11, sell: 13, baseUpdatedAt: '2000-01-01 00:00:00' }],
      },
    });
    assert.equal(conflicted.status, 409, '过期 baseUpdatedAt 应触发冲突');
    assert.equal(conflicted.json.code, 40903);

    const movers = await request(`/api/reports/movers?server=${encodeURIComponent(serverName)}&days=7`);
    assert.equal(movers.status, 200);

    const list = await request('/api/servers');
    assert.equal(list.status, 200);
    serverId = (list.json.data.items.find(s => s.name === serverName) || {}).id || null;
    assert.ok(serverId, '应能查询到冒烟区服');

    console.log(`[smoke] OK driver=${db.DRIVER} cache=${cache.status()} server=${serverName}`);
  } finally {
    try {
      if (serverId && adminToken) {
        await request(`/api/admin/servers/${serverId}?force=1`, { method: 'DELETE', admin: true });
      }
      if (accountId && adminToken) {
        await request(`/api/admin/accounts/${accountId}?confirm=${encodeURIComponent(accountName)}`, {
          method: 'DELETE', admin: true,
        });
      }
    } catch { /* 清理失败不影响结果 */ }
    await new Promise(resolve => server.close(resolve));
    await cache.close().catch(() => {});
    await db.close().catch(() => {});
    for (const suffix of ['', '-wal', '-shm']) REMOVE_TEMP(suffix);
  }
}

main().catch(err => {
  console.error('[smoke] 失败:', err);
  process.exitCode = 1;
  for (const suffix of ['', '-wal', '-shm']) REMOVE_TEMP(suffix);
  db.close().catch(() => {});
});
