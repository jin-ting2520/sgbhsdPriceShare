'use strict';

/** 游戏数据同步：纯逻辑单元测试 + 接口校验（不依赖外网） */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `game-test-${process.pid}-${Date.now()}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}
const app = require('../server');
const { productName, gamePrice, parseProducts, ensureCityId, CITY_MAP } = require('../server/game/sync');
const { displayBuy, displaySell, rawBuy, rawSell, clampRelief } = require('../server/tax');

let server;
let base = '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

before(async () => {
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(res => server.close(res));
  await require('../server/db').close().catch(() => {});
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
  }
});

test('商品配置 id 映射：1-25 与 201-225 复刻同名', () => {
  assert.equal(productName(1), '谷物');
  assert.equal(productName(25), '金银器');
  assert.equal(productName(201), '谷物');
  assert.equal(productName(225), '金银器');
  assert.equal(productName(26), null);
  assert.equal(productName(0), null);
});

test('游戏价格换算：分 → 两位小数展示价', () => {
  assert.equal(gamePrice(2119), 21.19);
  assert.equal(gamePrice(1310), 13.1);
  assert.equal(gamePrice('100'), 1);
  assert.equal(gamePrice(null), null);
  assert.equal(gamePrice(undefined), null);
});

test('2104 商品解析：type=2 为买入价、type 0/1 为卖出价（税前原价）', () => {
  const rows = parseProducts([
    { id: 1, type: 0, price: 1310, num: 0 },
    { id: 1, type: 2, price: 1250, num: 32085 },
    { id: 9, type: 1, price: 4807, num: 0 },
    { id: 999, type: 0, price: 100 },
  ]);
  assert.deepEqual(rows.get('谷物'), { buy: 12.5, sell: 13.1 });
  assert.deepEqual(rows.get('药材'), { buy: null, sell: 48.07 });
  assert.equal(rows.size, 2);
});

test('赋税换算：原价 ↔ 个人减免后的显示价（默认 5%）', () => {
  assert.equal(displaySell(21.72, 0.1, 5), 19.7);
  assert.equal(displayBuy(21.72, 0.1, 5), 23.8);
  assert.equal(displaySell(10, 0.2, 5), 8.1);
  assert.equal(displayBuy(10, 0.2, 5), 11.9);
  assert.equal(displaySell(10, 0.1, 0), 9);
  assert.equal(displayBuy(10, 0.1, 0), 11);
  assert.equal(displaySell(10, 0.1, 100), 10, '100% 减免等于无税');
  assert.equal(displayBuy(10, 0.1, 100), 10);
  assert.equal(rawSell(19.7, 0.1, 5), 21.77);
  assert.equal(rawBuy(23.8, 0.1, 5), 21.74);
  assert.equal(displaySell(null, 0.1, 5), null);
  assert.equal(rawBuy(null, 0.1, 5), null);
  assert.equal(clampRelief('120'), 100);
  assert.equal(clampRelief(-1), 0);
  assert.equal(clampRelief(null), 5);
});

test('城池映射表：175 城，metaId = 1100000 + nodeNo', () => {
  assert.equal(CITY_MAP.length, 175);
  const seen = new Set();
  for (const c of CITY_MAP) {
    assert.ok(c.name && Number.isInteger(c.nodeNo) && c.nodeNo > 0, c.name);
    assert.equal(c.metaId, 1100000 + c.nodeNo, c.name);
    assert.ok(!seen.has(c.nodeNo), `重复 nodeNo ${c.nodeNo}`);
    seen.add(c.nodeNo);
  }
  const names = new Set(CITY_MAP.map(c => c.name));
  assert.ok(names.has('江陵') && names.has('上庸') && names.has('洛阳'));
  assert.ok(names.has('绵竹') && names.has('成都') && names.has('晋阳'));
});

test('GET /api/game/meta 返回城池清单', async () => {
  const r = await api('/api/game/meta');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.cities.length, 175);
});

test('POST /api/game/sync 参数校验', async () => {
  const noToken = await api('/api/game/sync', { method: 'POST', body: { server: 'S1' } });
  assert.equal(noToken.status, 400);
  assert.match(noToken.json.message, /token/i);

  const shortToken = await api('/api/game/sync', { method: 'POST', body: { token: 'abc', server: 'S1' } });
  assert.equal(shortToken.status, 400);

  const noServer = await api('/api/game/sync', {
    method: 'POST',
    body: { token: 'x'.repeat(80) },
  });
  assert.equal(noServer.status, 400);
  assert.match(noServer.json.message, /区服/);

  const unknownCity = await api('/api/game/sync', {
    method: 'POST',
    body: { token: 'x'.repeat(80), server: 'S1', cities: ['不存在城'] },
  });
  assert.equal(unknownCity.status, 400);
  assert.match(unknownCity.json.message, /不存在城/);
});

test('城池税率：每次同步按最新税率覆盖', async () => {
  const db = require('../server/db');
  await db.upsertServer('TAX-T');
  const serverRow = await db.get('SELECT id FROM servers WHERE name = ?', ['TAX-T']);
  const cityId = await db.findDictId('city', '桂阳');
  assert.ok(serverRow && cityId);
  await db.setCityTax(serverRow.id, cityId, 0.1);
  assert.equal(await db.getCityTax(serverRow.id, cityId), 0.1);
  await db.setCityTax(serverRow.id, cityId, 0.2);
  assert.equal(await db.getCityTax(serverRow.id, cityId), 0.2);
  await db.setCityTax(serverRow.id, cityId, null);
  assert.equal(await db.getCityTax(serverRow.id, cityId), 0.2);
});

test('同步自动登记字典：缺失城池新建，已存在不重复', async () => {
  const db = require('../server/db');
  const first = await ensureCityId('测试新城');
  assert.ok(first.id);
  assert.equal(first.created, true);
  const second = await ensureCityId('测试新城');
  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
  const rows = await db.query("SELECT id FROM dict_items WHERE type = 'city' AND name = ?", ['测试新城']);
  assert.equal(rows.length, 1);
});
