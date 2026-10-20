'use strict';

/** 报表 / 定时设置 / 乐观并发 测试（SQLite 临时库） */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `reports-test-${process.pid}-${Date.now()}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}
const app = require('../server');
const db = require('../server/db');

let server;
let base = '';

async function api(path, { method = 'GET', body, session } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['X-Account-Token'] = session;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const save = (city, items, operator = '甲') =>
  api('/api/prices', { method: 'POST', body: { server: 'R1', city, operator, items } });

before(async () => {
  await db.ready();
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;

  await save('桂阳', [{ commodity: '谷物', buy: 10, sell: 12 }], '甲');
  await save('江陵', [{ commodity: '谷物', buy: 20, sell: 25 }], '甲');
  await save('桂阳', [{ commodity: '谷物', buy: 12, sell: 12 }], '乙');
  await save('江陵', [{ commodity: '香料', buy: 5, sell: 9 }], '乙');
});

after(async () => {
  require('../server/scheduler').stop();
  if (server) await new Promise(res => server.close(res));
  await db.close().catch(() => {});
  try { await require('../server/cache').close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
  }
});

test('涨跌幅榜：返回窗口内涨跌与百分比', async () => {
  const r = await api('/api/reports/movers?server=R1&days=7');
  assert.equal(r.status, 200);
  const item = r.json.data.items.find(i => i.commodity === '谷物' && i.field === 'buy' && i.city === '桂阳');
  assert.ok(item, '应有桂阳谷物买价变动');
  assert.equal(item.start, 10);
  assert.equal(item.end, 12);
  assert.equal(item.changePct, 20);
});

test('套利建议：按负重计算可购件数与毛利', async () => {
  const r = await api('/api/reports/arbitrage?server=R1&load=200');
  assert.equal(r.status, 200);
  const item = r.json.data.items.find(i => i.commodity === '谷物');
  assert.ok(item, '应给出谷物套利路线');
  assert.equal(item.buyCity, '桂阳');
  assert.equal(item.buyPrice, 12);
  assert.equal(item.sellCity, '江陵');
  assert.equal(item.sellPrice, 25);
  assert.equal(item.unitProfit, 13);
  assert.equal(item.units, 20, '200 负重 / 10 负重每件 = 20 件');
  assert.equal(item.gross, 260);
  assert.equal(item.perBurden, 1.3);
  for (const removed of ['energy', 'energyCost', 'net', 'dailyTrips', 'dailyNet']) {
    assert.equal(removed in item, false, `不应再返回 ${removed}`);
  }
});

test('套利建议：载重折算件数随 load 变化', async () => {
  const r = await api('/api/reports/arbitrage?server=R1&load=50');
  const item = r.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(item.units, 5);
  assert.equal(item.gross, 65);
});

test('更新热度：按天聚合改价次数与同步次数', async () => {
  const r = await api('/api/reports/heat?server=R1&days=7&bucket=day');
  assert.equal(r.status, 200);
  assert.ok(r.json.data.totalChanges >= 4);
  assert.ok(r.json.data.buckets.length >= 7);
  const sum = r.json.data.buckets.reduce((s, b) => s + b.changes, 0);
  assert.equal(sum, r.json.data.totalChanges);
});

test('同步设置：cron / token / 区服校验与保存', async () => {
  const init = await api('/api/sync-settings');
  assert.equal(init.status, 200);
  assert.equal(init.json.data.enabled, false);
  assert.equal(init.json.data.energy, undefined, '不再返回体力参数');
  assert.equal(init.json.data.token, undefined, '不返回 token 明文');

  const login = await api('/api/auth/login', { method: 'POST', body: { name: '设置测试', password: 'pass-1234' } });
  assert.equal(login.status, 200);
  const session = login.json.data.session;

  const anon = await api('/api/sync-settings', { method: 'PUT', body: { enabled: false } });
  assert.equal(anon.status, 401);

  const badCron = await api('/api/sync-settings', { method: 'PUT', session, body: { cron: 'not-a-cron' } });
  assert.equal(badCron.status, 400);

  const noToken = await api('/api/sync-settings', { method: 'PUT', session, body: { enabled: true, server: 'R1' } });
  assert.equal(noToken.status, 400);

  const okSave = await api('/api/sync-settings', {
    method: 'PUT',
    session,
    body: { enabled: true, server: 'R1', cron: '0 */6 * * *', token: 'x'.repeat(80) },
  });
  assert.equal(okSave.status, 200);
  assert.equal(okSave.json.data.enabled, true);
  assert.equal(okSave.json.data.hasToken, true);
  assert.equal(okSave.json.data.tokenOwner, '设置测试');
  assert.equal(okSave.json.data.cron, '0 */6 * * *');

  const disable = await api('/api/sync-settings', { method: 'PUT', session, body: { enabled: false } });
  assert.equal(disable.status, 200);
  assert.equal(disable.json.data.enabled, false);

  const logs = await api('/api/sync-settings/logs');
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.json.data.items));
});

test('乐观并发：updatedAt 不一致时拒绝覆盖，force 可强制保存', async () => {
  const query = await api('/api/prices?server=R1&city=桂阳');
  const gu = query.json.data.items.find(i => i.commodity === '谷物');
  assert.ok(gu.updatedAt);

  const conflict = await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'R1', city: '桂阳', operator: '丙',
      items: [{ commodity: '谷物', buy: 99, sell: 99, baseUpdatedAt: '2000-01-01 00:00:00' }],
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 40903);
  assert.equal(conflict.json.data.conflicts[0].commodity, '谷物');
  assert.equal(conflict.json.data.conflicts[0].buy, 12);

  const forced = await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'R1', city: '桂阳', operator: '丙', force: true,
      items: [{ commodity: '谷物', buy: 99, sell: 99, baseUpdatedAt: '2000-01-01 00:00:00' }],
    },
  });
  assert.equal(forced.status, 200);

  const after = await api('/api/prices?server=R1&city=桂阳');
  assert.equal(after.json.data.items.find(i => i.commodity === '谷物').buy, 99);
});

test('健康检查包含驱动与协作状态', async () => {
  const r = await api('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.driver, 'sqlite');
  assert.ok('cache' in r.json.data && 'wsClients' in r.json.data);
});

test('赋税减免：城市税率 + 个人减免共同换算显示价格', async () => {
  const serverId = await db.findServerId('R1');
  const cityId = await db.findDictId('city', '桂阳');
  assert.ok(serverId && cityId, '测试基础数据应存在');
  await db.run(
    'INSERT INTO city_taxes (server_id, city_id, tax, updated_at) VALUES (?, ?, ?, ?)',
    [serverId, cityId, 0.1, db.nowText()]
  );

  const q5 = await api('/api/prices?server=R1&city=桂阳&relief=5');
  assert.equal(q5.status, 200);
  assert.equal(q5.json.data.tax, 0.1);
  const g5 = q5.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(g5.buy, 108.4, '99 × (1 + 0.1×0.95)');
  assert.equal(g5.sell, 89.6, '99 × (1 − 0.1×0.95)');

  const q0 = await api('/api/prices?server=R1&city=桂阳&relief=0');
  const g0 = q0.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(g0.buy, 108.9);
  assert.equal(g0.sell, 89.1);

  const saved = await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'R1', city: '桂阳', operator: '丁', relief: 5,
      items: [{ commodity: '谷物', buy: 10, sell: 10 }],
    },
  });
  assert.equal(saved.status, 200);

  const after = await api('/api/prices?server=R1&city=桂阳&relief=5');
  const ga = after.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(ga.buy, 10, '手工录入按当前减免反推原价后再显示应一致');
  assert.equal(ga.sell, 10);

  const raw = await db.get(
    `SELECT buy_price AS buy, sell_price AS sell FROM prices
      WHERE server_id = ? AND city_id = ?
        AND commodity_id = (SELECT id FROM dict_items WHERE type = ? AND name = ?)`,
    [serverId, cityId, 'commodity', '谷物']
  );
  assert.equal(raw.buy, 9.13);
  assert.equal(raw.sell, 11.05);

  await db.run('DELETE FROM city_taxes WHERE server_id = ? AND city_id = ?', [serverId, cityId]);
});
