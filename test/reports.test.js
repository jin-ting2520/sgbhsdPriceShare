'use strict';

/** 报表 / 定时设置 / 乐观并发 / 赋税显示（卡密账号 + 签名） */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `reports-test-${process.pid}-${Date.now()}.db`);
process.env.ADMIN_PASSWORD = 'test-admin-pass';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}

const app = require('../server');
const db = require('../server/db');
const { createAdmin, registerAccount } = require('./helpers');

let server;
let base = '';
let admin;
let user;
let accountId;

const save = (city, items, operator) =>
  user.post('/api/prices', { server: 'R1', city, items, ...(operator ? { operator } : {}) });

before(async () => {
  await db.ready();
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = createAdmin(base);
  assert.equal((await admin.login()).status, 200);
  user = await registerAccount(base, admin, { name: '报表甲', password: 'pass-1234' });
  accountId = (await db.get('SELECT id FROM accounts WHERE name = ?', ['报表甲'])).id;

  await save('桂阳', [{ commodity: '谷物', buy: 10, sell: 12 }]);
  await save('江陵', [{ commodity: '谷物', buy: 20, sell: 25 }]);
  await save('桂阳', [{ commodity: '谷物', buy: 12, sell: 12 }]);
  await save('江陵', [{ commodity: '香料', buy: 5, sell: 9 }]);
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
  const r = await user.get('/api/reports/movers?server=R1&days=7');
  assert.equal(r.status, 200);
  const item = r.json.data.items.find(i => i.commodity === '谷物' && i.field === 'buy' && i.city === '桂阳');
  assert.ok(item);
  assert.equal(item.start, 10);
  assert.equal(item.end, 12);
  assert.equal(item.changePct, 20);
});

test('更新热度：按天聚合改价次数（账号隔离）', async () => {
  const r = await user.get('/api/reports/heat?server=R1&days=7&bucket=day');
  assert.equal(r.status, 200);
  assert.ok(r.json.data.totalChanges >= 4);
  assert.ok(r.json.data.buckets.length >= 7);
  const sum = r.json.data.buckets.reduce((s, b) => s + b.changes, 0);
  assert.equal(sum, r.json.data.totalChanges);
  assert.equal(r.json.data.totalSyncs, 0);
});

test('定时设置：cron / token 校验、区服参数权限与保存（按账号）', async () => {
  const init = await user.get('/api/sync-settings');
  assert.equal(init.status, 200);
  assert.equal(init.json.data.enabled, false);
  assert.equal(init.json.data.token, undefined, '不返回 token 明文');
  assert.equal(init.json.data.hasToken, false);
  assert.equal(init.json.data.allowSyncServer, false, '默认不允许区服参数');

  const anon = await require('./helpers').createClient(base).put('/api/sync-settings', { enabled: false });
  assert.equal(anon.status, 401);

  const badCron = await user.put('/api/sync-settings', { cron: 'not-a-cron' });
  assert.equal(badCron.status, 400);

  const blocked = await user.put('/api/sync-settings', { enabled: true, server: 'R1' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.message, /未开启区服参数权限/);

  const noToken = await user.put('/api/sync-settings', { enabled: true });
  assert.equal(noToken.status, 400);

  const allow = await admin.post(`/api/admin/accounts/${accountId}/sync-server`, { allow: true });
  assert.equal(allow.status, 200);

  const okSave = await user.put('/api/sync-settings', {
    enabled: true, server: '9999', cron: '0 */6 * * *', token: 'x'.repeat(80),
  });
  assert.equal(okSave.status, 200);
  assert.equal(okSave.json.data.enabled, true);
  assert.equal(okSave.json.data.hasToken, true);
  assert.equal(okSave.json.data.server, 'R1', '区服展示仍取当前识别/缓存区服');
  assert.equal(okSave.json.data.serverOverride, '9999', '授权账号可保存区服覆盖');
  assert.equal(okSave.json.data.allowSyncServer, true);
  assert.equal(okSave.json.data.cron, '0 */6 * * *');
  const settingsRow = await db.get(
    'SELECT server_name AS server, server_override AS serverOverride FROM sync_settings WHERE account_id = ?',
    [accountId]
  );
  assert.equal(settingsRow.server, '', '覆盖值不写入展示缓存');
  assert.equal(settingsRow.serverOverride, '9999');

  const disable = await user.put('/api/sync-settings', { enabled: false });
  assert.equal(disable.status, 200);
  assert.equal(disable.json.data.enabled, false);

  const deny = await admin.post(`/api/admin/accounts/${accountId}/sync-server`, { allow: false });
  assert.equal(deny.status, 200);
  const afterDeny = await user.put('/api/sync-settings', { server: '9998' });
  assert.equal(afterDeny.status, 403);

  const logs = await user.get('/api/sync-settings/logs');
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.json.data.items));
});

test('乐观并发：updatedAt 不一致时拒绝覆盖，force 可强制保存', async () => {
  const query = await user.get('/api/prices?server=R1&city=桂阳');
  const gu = query.json.data.items.find(i => i.commodity === '谷物');
  assert.ok(gu.updatedAt);

  const conflict = await user.post('/api/prices', {
    server: 'R1', city: '桂阳',
    items: [{ commodity: '谷物', buy: 99, sell: 99, baseUpdatedAt: '2000-01-01 00:00:00' }],
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 40903);
  assert.equal(conflict.json.data.conflicts[0].commodity, '谷物');
  assert.equal(conflict.json.data.conflicts[0].buy, 12);

  const forced = await user.post('/api/prices', {
    server: 'R1', city: '桂阳', force: true,
    items: [{ commodity: '谷物', buy: 99, sell: 99, baseUpdatedAt: '2000-01-01 00:00:00' }],
  });
  assert.equal(forced.status, 200);

  const after = await user.get('/api/prices?server=R1&city=桂阳');
  assert.equal(after.json.data.items.find(i => i.commodity === '谷物').buy, 99);
});

test('健康检查包含驱动与协作状态', async () => {
  const r = await user.get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.driver, 'sqlite');
  assert.ok('cache' in r.json.data && 'wsClients' in r.json.data);
});

test('赋税减免：城市税率 + 个人减免共同换算显示价格', async () => {
  const serverId = await db.findServerId('R1');
  const cityId = await db.findDictId('city', '桂阳');
  assert.ok(serverId && cityId);
  await db.setCityTax(accountId, serverId, cityId, 0.1);
  assert.equal(await db.getCityTax(accountId, serverId, cityId), 0.1);

  const q5 = await user.get('/api/prices?server=R1&city=桂阳&relief=5');
  assert.equal(q5.status, 200);
  assert.equal(q5.json.data.tax, 0.1);
  const g5 = q5.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(g5.buy, 108.4, '99 × (1 + 0.1×0.95)');
  assert.equal(g5.sell, 89.6, '99 × (1 − 0.1×0.95)');

  const q0 = await user.get('/api/prices?server=R1&city=桂阳&relief=0');
  const g0 = q0.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(g0.buy, 108.9);
  assert.equal(g0.sell, 89.1);

  const saved = await user.post('/api/prices', {
    server: 'R1', city: '桂阳', relief: 5,
    items: [{ commodity: '谷物', buy: 10, sell: 10 }],
  });
  assert.equal(saved.status, 200);

  const after = await user.get('/api/prices?server=R1&city=桂阳&relief=5');
  const ga = after.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(ga.buy, 10);
  assert.equal(ga.sell, 10);

  const commodityId = await db.findDictId('commodity', '谷物');
  const raw = await db.get(
    'SELECT buy_price AS buy, sell_price AS sell FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
    [accountId, serverId, cityId, commodityId]
  );
  assert.equal(raw.buy, 9.13);
  assert.equal(raw.sell, 11.05);

  await db.run('DELETE FROM city_taxes WHERE account_id = ? AND server_id = ? AND city_id = ?', [accountId, serverId, cityId]);
});
