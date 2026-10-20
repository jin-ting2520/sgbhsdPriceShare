'use strict';

/** 游戏数据同步：纯逻辑单元测试 + 接口校验（不依赖外网） */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `game-test-${process.pid}-${Date.now()}.db`);
process.env.ADMIN_PASSWORD = 'test-admin-pass';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}
const app = require('../server');
const db = require('../server/db');
const { productName, gamePrice, parseProducts, ensureCityId, serverOfLogin, CITY_MAP } = require('../server/game/sync');
const { displayBuy, displaySell, rawBuy, rawSell, clampRelief } = require('../server/tax');
const { createAdmin, registerAccount, createClient } = require('./helpers');

let server;
let base = '';
let admin;
let user;
let accountId;

before(async () => {
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = createAdmin(base);
  assert.equal((await admin.login()).status, 200);
  user = await registerAccount(base, admin, { name: '同步测试' });
  accountId = (await db.get('SELECT id FROM accounts WHERE name = ?', ['同步测试'])).id;
});

after(async () => {
  require('../server/scheduler').stop();
  await new Promise(res => server.close(res));
  await db.close().catch(() => {});
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

test('GET /api/game/meta 需登录，返回城池清单', async () => {
  const anon = createClient(base);
  assert.equal((await anon.get('/api/game/meta')).status, 401);
  const r = await user.get('/api/game/meta');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.cities.length, 175);
});

test('区服识别：优先角色区服，回退角色区服列表与赛季服', () => {
  assert.equal(serverOfLogin({ oServerId: 1336, existRoleServerIds: [1337], serverId: 37795 }), '1336');
  assert.equal(serverOfLogin({ existRoleServerIds: [1337, 1338], serverId: 37795 }), '1337');
  assert.equal(serverOfLogin({ serverId: 37795 }), '37795');
  assert.equal(serverOfLogin({}), '');
  assert.equal(serverOfLogin(null), '');
});

test('POST /api/game/sync 区服参数权限与参数校验', async () => {
  const me = await user.get('/api/auth/me');
  assert.equal(me.json.data.allowSyncServer, false, '默认不允许传区服参数');

  const blocked = await user.post('/api/game/sync', { server: 'S1' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.message, /未开启区服参数权限/);

  const noToken = await user.post('/api/game/sync', {});
  assert.equal(noToken.status, 400);
  assert.match(noToken.json.message, /token/i);

  const shortToken = await user.post('/api/game/sync', { token: 'abc' });
  assert.equal(shortToken.status, 400);

  const allow = await admin.post(`/api/admin/accounts/${accountId}/sync-server`, { allow: true });
  assert.equal(allow.status, 200);
  assert.equal(allow.json.data.allowSyncServer, true);
  assert.equal((await user.get('/api/auth/me')).json.data.allowSyncServer, true);

  const unknownCity = await user.post('/api/game/sync', {
    token: 'x'.repeat(80), server: 'S1', cities: ['不存在城'],
  });
  assert.equal(unknownCity.status, 400);
  assert.match(unknownCity.json.message, /不存在城/);

  const anon = await createClient(base).post('/api/game/sync', { token: 'x'.repeat(80), server: 'S1' });
  assert.equal(anon.status, 401);

  const deny = await admin.post(`/api/admin/accounts/${accountId}/sync-server`, { allow: false });
  assert.equal(deny.status, 200);
  assert.equal(deny.json.data.allowSyncServer, false);
  assert.equal((await user.post('/api/game/sync', { server: 'S1' })).status, 403);

  const badFlag = await admin.post(`/api/admin/accounts/${accountId}/sync-server`, { allow: 'yes' });
  assert.equal(badFlag.status, 400);
  const missing = await admin.post('/api/admin/accounts/999999/sync-server', { allow: true });
  assert.equal(missing.status, 404);

  const noTokenInfo = await user.post('/api/game/token-info', {});
  assert.equal(noTokenInfo.status, 400);
  assert.match(noTokenInfo.json.message, /token/i);
  assert.equal((await createClient(base).post('/api/game/token-info', {})).status, 401);
});

test('城池税率：按账号隔离，每次同步按最新税率覆盖', async () => {
  await db.upsertServer('TAX-T');
  const serverRow = await db.get('SELECT id FROM servers WHERE name = ?', ['TAX-T']);
  const cityId = await db.findDictId('city', '桂阳');
  assert.ok(serverRow && cityId);

  await db.setCityTax(accountId, serverRow.id, cityId, 0.1);
  assert.equal(await db.getCityTax(accountId, serverRow.id, cityId), 0.1);
  await db.setCityTax(accountId, serverRow.id, cityId, 0.2);
  assert.equal(await db.getCityTax(accountId, serverRow.id, cityId), 0.2);
  await db.setCityTax(accountId, serverRow.id, cityId, null);
  assert.equal(await db.getCityTax(accountId, serverRow.id, cityId), 0.2);

  assert.equal(await db.getCityTax(accountId + 999, serverRow.id, cityId), null, '其他账号不可见');
});

test('同步自动登记字典：缺失城池新建，已存在不重复', async () => {
  const first = await ensureCityId('测试新城');
  assert.ok(first.id);
  assert.equal(first.created, true);
  const second = await ensureCityId('测试新城');
  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
  const rows = await db.query("SELECT id FROM dict_items WHERE type = 'city' AND name = ?", ['测试新城']);
  assert.equal(rows.length, 1);
});
