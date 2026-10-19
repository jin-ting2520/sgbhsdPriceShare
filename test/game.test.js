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
const { productName, gamePrice, parseProducts, harvestEnergy, CITY_MAP } = require('../server/game/sync');

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

test('2104 商品解析：type 0/1 为买价，type 2 为卖价', () => {
  const rows = parseProducts([
    { id: 1, type: 0, price: 1310, num: 0 },
    { id: 1, type: 2, price: 1250, num: 32085 },
    { id: 9, type: 1, price: 4807, num: 0 },
    { id: 999, type: 0, price: 100 },
  ]);
  assert.deepEqual(rows.get('谷物'), { buy: 13.1, sell: 12.5 });
  assert.deepEqual(rows.get('药材'), { buy: 48.07, sell: null });
  assert.equal(rows.size, 2);
});

test('体力采集：otherPrices[].energy 记录为城池间路线体力', () => {
  const sink = new Map();
  const base = 37795n * 100000000000n;
  harvestEnergy({ name: '桂阳' }, {
    products: [
      { id: 1, type: 2, price: 1000, otherPrices: [
        { capitalNodeId: base + 21n, energy: 2 },
        { capitalNodeId: base + 142n, energy: 1 },
        { capitalNodeId: base + 21n, energy: 3 },
        { capitalNodeId: 123n, energy: 1 },
        { capitalNodeId: base + 21n, energy: 0 },
      ] },
    ],
  }, sink);
  assert.equal(sink.get('桂阳|江陵'), 2, '同路线取最小体力');
  assert.equal(sink.get('桂阳|上庸'), 1);
  assert.equal(sink.size, 2);
});

test('城池映射表：42 城，metaId = 1100000 + nodeNo', () => {
  assert.equal(CITY_MAP.length, 42);
  for (const c of CITY_MAP) {
    assert.ok(c.name && Number.isInteger(c.nodeNo) && c.nodeNo > 0, c.name);
    assert.equal(c.metaId, 1100000 + c.nodeNo, c.name);
  }
  const names = new Set(CITY_MAP.map(c => c.name));
  assert.ok(names.has('江陵') && names.has('上庸') && names.has('洛阳'));
});

test('GET /api/game/meta 返回城池清单', async () => {
  const r = await api('/api/game/meta');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.cities.length, 42);
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
});
