'use strict';

/** 主账号价格共享：设置/开关、整行回退、税率、历史/趋势/比价/导出、后台清理 */

const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `master-test-${process.pid}-${Date.now()}.db`);
process.env.ADMIN_PASSWORD = 'test-admin-pass';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');
const db = require('../server/db');
const { masterViewerIds } = require('../server/master');
const { createAdmin, registerAccount } = require('./helpers');

const SERVER = 'M1';
const CITY = '桂阳';
const MASTER_NAME = '主账号维护者';
const VIEWER_NAME = '共享查看者';

let server;
let base = '';
let admin;
let master;
let viewer;
let masterId;
let viewerId;

before(async () => {
  await db.ready();
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = createAdmin(base);
  assert.equal((await admin.login()).status, 200);
  master = await registerAccount(base, admin, { name: MASTER_NAME, password: 'pass-1234' });
  viewer = await registerAccount(base, admin, { name: VIEWER_NAME, password: 'pass-1234' });
  masterId = (await db.get('SELECT id FROM accounts WHERE name = ?', [MASTER_NAME])).id;
  viewerId = (await db.get('SELECT id FROM accounts WHERE name = ?', [VIEWER_NAME])).id;
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

test('后台设置主账号：普通账号默认开启共享，管理员可禁用特定账号', async () => {
  const set = await admin.post(`/api/admin/accounts/${masterId}/master`, { master: true });
  assert.equal(set.status, 200, set.json && set.json.message);
  assert.equal(set.json.data.isMaster, true);

  const masterList = await admin.get(`/api/admin/accounts?q=${encodeURIComponent(MASTER_NAME)}`);
  assert.equal(masterList.json.data.items[0].isMaster, true);

  const denied = await master.put('/api/auth/master-prices', { enabled: true });
  assert.equal(denied.status, 400);
  assert.match(denied.json.message, /主账号/);

  let me = await viewer.get('/api/auth/me');
  assert.equal(me.json.data.masterAccountName, MASTER_NAME);
  assert.equal(me.json.data.isMaster, false);
  assert.equal(me.json.data.masterPricesAllowed, true);
  assert.equal(me.json.data.viewMasterPrices, true, '设置主账号后普通账号应默认开启共享');
  assert.deepEqual(await masterViewerIds(), [viewerId]);

  let viewerList = await admin.get(`/api/admin/accounts?q=${encodeURIComponent(VIEWER_NAME)}`);
  assert.equal(viewerList.json.data.items[0].masterPricesAllowed, true);
  assert.equal(viewerList.json.data.items[0].viewMasterPrices, true);

  const disabled = await viewer.put('/api/auth/master-prices', { enabled: false });
  assert.equal(disabled.status, 200);
  me = await viewer.get('/api/auth/me');
  assert.equal(me.json.data.masterPricesAllowed, true);
  assert.equal(me.json.data.viewMasterPrices, false);
  assert.deepEqual(await masterViewerIds(), []);

  const reset = await admin.post(`/api/admin/accounts/${masterId}/master`, { master: true });
  assert.equal(reset.status, 200);
  me = await viewer.get('/api/auth/me');
  assert.equal(me.json.data.viewMasterPrices, true, '重新设置主账号后普通账号应再次默认开启');

  const blocked = await admin.post(`/api/admin/accounts/${viewerId}/master-prices`, { allowed: false });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.data.masterPricesAllowed, false);
  me = await viewer.get('/api/auth/me');
  assert.equal(me.json.data.masterPricesAllowed, false);
  assert.equal(me.json.data.viewMasterPrices, false);
  assert.deepEqual(await masterViewerIds(), []);
  viewerList = await admin.get(`/api/admin/accounts?q=${encodeURIComponent(VIEWER_NAME)}`);
  assert.equal(viewerList.json.data.items[0].masterPricesAllowed, false);
  assert.equal(viewerList.json.data.items[0].viewMasterPrices, false);

  const blockedToggle = await viewer.put('/api/auth/master-prices', { enabled: true });
  assert.equal(blockedToggle.status, 403);
  assert.match(blockedToggle.json.message, /管理员已关闭/);

  const resetAgain = await admin.post(`/api/admin/accounts/${masterId}/master`, { master: true });
  assert.equal(resetAgain.status, 200);
  me = await viewer.get('/api/auth/me');
  assert.equal(me.json.data.masterPricesAllowed, false, '重新设置主账号不应覆盖管理员的禁用');
  assert.equal(me.json.data.viewMasterPrices, false);

  const allowed = await admin.post(`/api/admin/accounts/${viewerId}/master-prices`, { allowed: true });
  assert.equal(allowed.status, 200);
  me = await viewer.get('/api/auth/me');
  assert.equal(me.json.data.masterPricesAllowed, true);
  assert.equal(me.json.data.viewMasterPrices, true, '管理员重新开启后应默认开启共享');
  assert.deepEqual(await masterViewerIds(), [viewerId]);

  const masterSelf = await admin.post(`/api/admin/accounts/${masterId}/master-prices`, { allowed: false });
  assert.equal(masterSelf.status, 400);
  assert.match(masterSelf.json.message, /主账号/);
});

test('整行回退：本人没有的商品展示主账号价格并标记来源', async () => {
  const save = await master.post('/api/prices', {
    server: SERVER, city: CITY,
    items: [
      { commodity: '谷物', buy: 100, sell: 120 },
      { commodity: '黏土', buy: 50, sell: 60 },
    ],
  });
  assert.equal(save.status, 200);
  assert.equal(save.json.data.created, 2);

  let r = await viewer.get(`/api/prices?server=${SERVER}&city=${CITY}`);
  assert.equal(r.status, 200);
  const gu = r.json.data.items.find(i => i.commodity === '谷物');
  const clay = r.json.data.items.find(i => i.commodity === '黏土');
  assert.equal(gu.buy, 100);
  assert.equal(gu.sell, 120);
  assert.equal(gu.source, 'master');
  assert.equal(clay.source, 'master');
  assert.equal(r.json.data.sharedCount, 2);

  const own = await viewer.post('/api/prices', {
    server: SERVER, city: CITY,
    items: [{ commodity: '谷物', buy: 200, sell: 220 }],
  });
  assert.equal(own.status, 200);

  r = await viewer.get(`/api/prices?server=${SERVER}&city=${CITY}`);
  const ownGu = r.json.data.items.find(i => i.commodity === '谷物');
  const sharedClay = r.json.data.items.find(i => i.commodity === '黏土');
  assert.equal(ownGu.buy, 200);
  assert.equal(ownGu.source, 'own');
  assert.equal(sharedClay.buy, 50);
  assert.equal(sharedClay.source, 'master');
  assert.equal(r.json.data.sharedCount, 1);

  const masterQuery = await master.get(`/api/prices?server=${SERVER}&city=${CITY}`);
  assert.equal(masterQuery.json.data.items.find(i => i.commodity === '谷物').buy, 100, '查看者保存不得覆盖主账号');
});

test('历史、趋势、比价、导出均支持主账号回退', async () => {
  const history = await viewer.get(`/api/prices/history?server=${SERVER}&city=${CITY}&limit=50`);
  assert.equal(history.status, 200);
  assert.equal(history.json.data.source, 'own', '本人已有价格行时历史不回退');

  const sharedHistory = await viewer.get(`/api/prices/history?server=${SERVER}&city=M2&limit=50`);
  assert.equal(sharedHistory.status, 200, '未知区服应返回空而不是报错');
  assert.equal(sharedHistory.json.data.total, 0);

  await master.post('/api/prices', {
    server: SERVER, city: '浈阳',
    items: [{ commodity: '葡萄', buy: 80, sell: 95 }],
  });
  const fallbackHistory = await viewer.get(`/api/prices/history?server=${SERVER}&city=浈阳&limit=50`);
  assert.equal(fallbackHistory.json.data.source, 'master');
  assert.ok(fallbackHistory.json.data.total > 0);
  assert.match(fallbackHistory.json.data.masterAccountName, /主账号维护者/);

  const trend = await viewer.get(`/api/prices/trend?server=${SERVER}&city=桂阳&commodity=黏土&days=30`);
  assert.equal(trend.status, 200);
  assert.equal(trend.json.data.source, 'master');
  assert.equal(trend.json.data.summary.lastBuy, 50);

  const matrix = await viewer.get(`/api/prices/matrix?server=${SERVER}&commodity=葡萄`);
  assert.equal(matrix.status, 200);
  assert.equal(matrix.json.data.sharedCount, 1);
  const matrixCity = matrix.json.data.items.find(i => i.city === '浈阳');
  assert.equal(matrixCity.source, 'master');
  assert.equal(matrixCity.buy, 80);

  const csv = await viewer.get(`/api/prices/export?server=${SERVER}&city=浈阳`);
  assert.equal(csv.status, 200);
  const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], '区服,城池,商品,负重,买价,卖价,更新时间,更新人,来源');
  const grapeLine = lines.find(l => l.startsWith(`${SERVER},浈阳,葡萄,`));
  assert.ok(grapeLine);
  assert.match(grapeLine, /,主账号$/);
});

test('税率回退与保存/导入换算，本人税率优先', async () => {
  const serverRow = await db.get('SELECT id FROM servers WHERE name = ?', [SERVER]);
  const cityRow = await db.get("SELECT id FROM dict_items WHERE type = 'city' AND name = ?", [CITY]);
  await db.setCityTax(masterId, serverRow.id, cityRow.id, 0.2);

  let r = await viewer.get(`/api/prices?server=${SERVER}&city=${CITY}`);
  assert.equal(r.json.data.tax, 0.2, '本人无税率时回退主账号税率');
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').buy, 59.5);
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').sell, 48.6);

  const save = await viewer.post('/api/prices', {
    server: SERVER, city: CITY,
    items: [{ commodity: '葡萄', buy: 119, sell: 81 }],
  });
  assert.equal(save.status, 200);
  let raw = await db.get(
    `SELECT p.buy_price AS buy, p.sell_price AS sell
       FROM prices p JOIN dict_items d ON d.id = p.commodity_id
      WHERE p.account_id = ? AND p.server_id = ? AND p.city_id = ? AND d.name = '葡萄'`,
    [viewerId, serverRow.id, cityRow.id]
  );
  assert.equal(raw.buy, 100, '保存应按主账号税率还原为税前原价');
  assert.equal(raw.sell, 100);

  const imported = await viewer.post('/api/prices/import', {
    server: SERVER, city: CITY,
    rows: [{ commodity: '药材', buy: 119, sell: 81 }],
  });
  assert.equal(imported.status, 200, imported.json && imported.json.message);
  raw = await db.get(
    `SELECT p.buy_price AS buy, p.sell_price AS sell
       FROM prices p JOIN dict_items d ON d.id = p.commodity_id
      WHERE p.account_id = ? AND p.server_id = ? AND p.city_id = ? AND d.name = '药材'`,
    [viewerId, serverRow.id, cityRow.id]
  );
  assert.equal(raw.buy, 100);
  assert.equal(raw.sell, 100);

  await db.setCityTax(viewerId, serverRow.id, cityRow.id, 0.1);
  r = await viewer.get(`/api/prices?server=${SERVER}&city=${CITY}`);
  assert.equal(r.json.data.tax, 0.1, '本人税率应优先于主账号');
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').buy, 54.8);
  assert.equal(r.json.data.items.find(i => i.commodity === '葡萄').buy, 109.5);
});

test('取消主账号立即停止回退，删除主账号会清理设置与开关', async () => {
  const cleared = await admin.post(`/api/admin/accounts/${masterId}/master`, { master: false });
  assert.equal(cleared.status, 200);
  const settings = await db.get('SELECT master_account_id AS id FROM app_settings WHERE id = 1');
  assert.equal(settings.id, null);

  let me = await viewer.get('/api/auth/me');
  assert.equal(me.json.data.masterAccountId, null);
  assert.equal(me.json.data.viewMasterPrices, false);

  let r = await viewer.get(`/api/prices?server=${SERVER}&city=${CITY}`);
  assert.equal(r.json.data.masterAccountId, null);
  assert.equal(r.json.data.sharedCount, 0);
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').source, null);

  const denied = await viewer.put('/api/auth/master-prices', { enabled: true });
  assert.equal(denied.status, 400);
  assert.match(denied.json.message, /未指定主账号/);

  assert.equal((await admin.post(`/api/admin/accounts/${masterId}/master`, { master: true })).status, 200);
  assert.equal((await viewer.put('/api/auth/master-prices', { enabled: true })).status, 200);
  const removed = await admin.del(`/api/admin/accounts/${masterId}?confirm=${encodeURIComponent(MASTER_NAME)}`);
  assert.equal(removed.status, 200);

  const afterDelete = await db.get('SELECT master_account_id AS id FROM app_settings WHERE id = 1');
  assert.equal(afterDelete.id, null);
  me = await viewer.get('/api/auth/me');
  assert.equal(me.json.data.masterAccountName, '');
  assert.equal(me.json.data.viewMasterPrices, false);
});
