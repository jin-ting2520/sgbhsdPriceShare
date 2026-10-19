'use strict';

/**
 * 冒烟自检：启动 HTTP 服务，验证健康检查、价格写入/查询、乐观并发与删除清理。
 * 用法：node server/scripts/smoke.js
 *   - SQLite：默认使用 data/price.db（可用 PRICE_DB 指定临时文件）
 *   - MySQL ：DB_DRIVER=mysql MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=...
 *   - Redis ：REDIS_URL=redis://127.0.0.1:6379 时额外验证缓存连接
 */

const assert = require('node:assert/strict');
const app = require('..');
const db = require('../db');
const cache = require('../cache');

async function main() {
  await db.ready();
  if (cache.REDIS_URL) await cache.connect();

  const server = app.createServer().listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const serverName = process.env.SMOKE_SERVER || `SMOKE-${Date.now()}`;
  let serverId = null;

  try {
    const health = await call('/api/health');
    assert.equal(health.status, 200, '健康检查应返回 200');
    assert.equal(health.json.data.driver, db.DRIVER);
    if (cache.REDIS_URL) assert.equal(health.json.data.cache, 'ok', 'Redis 应已连接');

    const created = await call('/api/prices', {
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

    const queried = await call(`/api/prices?server=${encodeURIComponent(serverName)}&city=${encodeURIComponent('桂阳')}`);
    assert.equal(queried.status, 200);
    const grain = queried.json.data.items.find(i => i.commodity === '谷物');
    assert.ok(grain, '应能查询到刚写入的谷物价格');
    assert.equal(grain.buy, 10);
    assert.equal(grain.sell, 12);

    const conflicted = await call('/api/prices', {
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

    const movers = await call(`/api/reports/movers?server=${encodeURIComponent(serverName)}&days=7`);
    assert.equal(movers.status, 200);

    const list = await call(`/api/servers?keyword=${encodeURIComponent(serverName)}`);
    serverId = (list.json.data.items[0] || {}).id || null;
    assert.ok(serverId, '应能查询到冒烟区服');

    const removed = await call(`/api/servers/${serverId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    serverId = null;

    console.log(`[smoke] OK driver=${db.DRIVER} cache=${cache.status()} server=${serverName}`);
  } finally {
    if (serverId) await call(`/api/servers/${serverId}`, { method: 'DELETE' }).catch(() => {});
    await new Promise(resolve => server.close(resolve));
    await cache.close().catch(() => {});
    await db.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('[smoke] 失败:', err);
  process.exitCode = 1;
  db.close().catch(() => {});
});
