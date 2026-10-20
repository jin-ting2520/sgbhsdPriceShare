'use strict';

/** 主账号价格共享：按区服设置/切换、整行回退、税率、历史/趋势/比价/导出、后台清理 */

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
const { getServerMaster, masterViewerIds } = require('../server/master');
const { createAdmin, registerAccount } = require('./helpers');

const SERVER_A = 'M1';
const SERVER_B = 'M2';
const SERVER_EMPTY = 'M3';
const CITY = '桂阳';
const MASTER_A_NAME = '主账号甲';
const VIEWER_A_NAME = '查看者甲';
const MASTER_B_NAME = '主账号乙';
const VIEWER_B_NAME = '查看者乙';

let server;
let base = '';
let admin;
let masterA;
let viewerA;
let masterB;
let viewerB;
let masterAId;
let viewerAId;
let masterBId;
let viewerBId;
let serverAId;
let serverBId;

const setServer = (client, name) => client.put('/api/auth/server', { server: name });

before(async () => {
  await db.ready();
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = createAdmin(base);
  assert.equal((await admin.login()).status, 200);
  masterA = await registerAccount(base, admin, { name: MASTER_A_NAME, password: 'pass-1234' });
  viewerA = await registerAccount(base, admin, { name: VIEWER_A_NAME, password: 'pass-1234' });
  masterB = await registerAccount(base, admin, { name: MASTER_B_NAME, password: 'pass-1234' });
  viewerB = await registerAccount(base, admin, { name: VIEWER_B_NAME, password: 'pass-1234' });
  masterAId = (await db.get('SELECT id FROM accounts WHERE name = ?', [MASTER_A_NAME])).id;
  viewerAId = (await db.get('SELECT id FROM accounts WHERE name = ?', [VIEWER_A_NAME])).id;
  masterBId = (await db.get('SELECT id FROM accounts WHERE name = ?', [MASTER_B_NAME])).id;
  viewerBId = (await db.get('SELECT id FROM accounts WHERE name = ?', [VIEWER_B_NAME])).id;
  assert.equal((await setServer(masterA, SERVER_A)).status, 200);
  assert.equal((await setServer(viewerA, SERVER_A)).status, 200);
  assert.equal((await setServer(masterB, SERVER_B)).status, 200);
  assert.equal((await setServer(viewerB, SERVER_B)).status, 200);
  serverAId = (await db.get('SELECT id FROM servers WHERE name = ?', [SERVER_A])).id;
  serverBId = (await db.get('SELECT id FROM servers WHERE name = ?', [SERVER_B])).id;
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

test('登录后未记录区服：必须设置当前区服，之后可切换并重新解析主账号', async () => {
  const fresh = await registerAccount(base, admin, { name: '待选区服账号', password: 'pass-1234' });
  assert.equal(fresh.registered.currentServer, '', '新账号默认没有当前区服');

  const noServer = await fresh.put('/api/auth/master-prices', { enabled: true });
  assert.equal(noServer.status, 400);
  assert.match(noServer.json.message, /当前所在区服/);

  const blank = await fresh.put('/api/auth/server', { server: '' });
  assert.equal(blank.status, 400);

  const set = await setServer(fresh, SERVER_EMPTY);
  assert.equal(set.status, 200);
  assert.equal(set.json.data.currentServer, SERVER_EMPTY);
  assert.equal(set.json.data.masterAccountId, null);

  let me = await fresh.get('/api/auth/me');
  assert.equal(me.json.data.currentServer, SERVER_EMPTY);
  assert.equal(me.json.data.isMaster, false);
  assert.equal(me.json.data.masterAccountName, '');
  assert.equal(me.json.data.viewMasterPrices, false);
});

test('后台按区服设置主账号：本区普通账号默认开启，其他区服互不影响', async () => {
  let list = await admin.get('/api/admin/servers');
  const rowA = list.json.data.find(s => s.id === serverAId);
  const rowB = list.json.data.find(s => s.id === serverBId);
  assert.ok(rowA.masterCandidates.some(a => a.id === masterAId));
  assert.ok(rowA.masterCandidates.some(a => a.id === viewerAId));
  assert.ok(!rowA.masterCandidates.some(a => a.id === masterBId));

  const setA = await admin.post(`/api/admin/servers/${serverAId}/master`, { accountId: masterAId });
  assert.equal(setA.status, 200, setA.json && setA.json.message);
  assert.equal(setA.json.data.masterAccountName, MASTER_A_NAME);
  const setB = await admin.post(`/api/admin/servers/${serverBId}/master`, { accountId: masterBId });
  assert.equal(setB.status, 200, setB.json && setB.json.message);

  let me = await masterA.get('/api/auth/me');
  assert.equal(me.json.data.isMaster, true);
  assert.equal(me.json.data.masterAccountName, MASTER_A_NAME);

  me = await viewerA.get('/api/auth/me');
  assert.equal(me.json.data.masterAccountName, MASTER_A_NAME);
  assert.equal(me.json.data.isMaster, false);
  assert.equal(me.json.data.masterPricesAllowed, true);
  assert.equal(me.json.data.viewMasterPrices, true, '设置主账号后本区服普通账号应默认开启共享');
  assert.deepEqual(await masterViewerIds(SERVER_A), [viewerAId]);

  me = await viewerB.get('/api/auth/me');
  assert.equal(me.json.data.masterAccountName, MASTER_B_NAME);
  assert.equal(me.json.data.viewMasterPrices, true);
  assert.deepEqual(await masterViewerIds(SERVER_B), [viewerBId]);
  assert.deepEqual(await masterViewerIds(SERVER_EMPTY), []);

  const masterList = await admin.get(`/api/admin/accounts?q=${encodeURIComponent(MASTER_A_NAME)}`);
  assert.equal(masterList.json.data.items[0].isMaster, true);
  assert.deepEqual(masterList.json.data.items[0].masterServers, [SERVER_A]);

  const denied = await masterA.put('/api/auth/master-prices', { enabled: true });
  assert.equal(denied.status, 400);
  assert.match(denied.json.message, /主账号/);

  let viewerList = await admin.get(`/api/admin/accounts?q=${encodeURIComponent(VIEWER_A_NAME)}`);
  assert.equal(viewerList.json.data.items[0].masterPricesAllowed, true);
  assert.equal(viewerList.json.data.items[0].viewMasterPrices, true);

  const disabled = await viewerA.put('/api/auth/master-prices', { enabled: false });
  assert.equal(disabled.status, 200);
  me = await viewerA.get('/api/auth/me');
  assert.equal(me.json.data.masterPricesAllowed, true);
  assert.equal(me.json.data.viewMasterPrices, false);
  assert.deepEqual(await masterViewerIds(SERVER_A), []);

  const reset = await admin.post(`/api/admin/servers/${serverAId}/master`, { accountId: masterAId });
  assert.equal(reset.status, 200);
  me = await viewerA.get('/api/auth/me');
  assert.equal(me.json.data.viewMasterPrices, true, '重新设置区服主账号后本区普通账号应再次默认开启');

  const blocked = await admin.post(`/api/admin/accounts/${viewerAId}/master-prices`, { allowed: false });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.data.masterPricesAllowed, false);
  me = await viewerA.get('/api/auth/me');
  assert.equal(me.json.data.masterPricesAllowed, false);
  assert.equal(me.json.data.viewMasterPrices, false);
  assert.deepEqual(await masterViewerIds(SERVER_A), []);

  viewerList = await admin.get(`/api/admin/accounts?q=${encodeURIComponent(VIEWER_A_NAME)}`);
  assert.equal(viewerList.json.data.items[0].masterPricesAllowed, false);
  assert.equal(viewerList.json.data.items[0].viewMasterPrices, false);

  const blockedToggle = await viewerA.put('/api/auth/master-prices', { enabled: true });
  assert.equal(blockedToggle.status, 403);
  assert.match(blockedToggle.json.message, /管理员已关闭/);

  const resetAgain = await admin.post(`/api/admin/servers/${serverAId}/master`, { accountId: masterAId });
  assert.equal(resetAgain.status, 200);
  me = await viewerA.get('/api/auth/me');
  assert.equal(me.json.data.masterPricesAllowed, false, '重新设置主账号不应覆盖管理员的禁用');
  assert.equal(me.json.data.viewMasterPrices, false);

  const allowed = await admin.post(`/api/admin/accounts/${viewerAId}/master-prices`, { allowed: true });
  assert.equal(allowed.status, 200);
  me = await viewerA.get('/api/auth/me');
  assert.equal(me.json.data.masterPricesAllowed, true);
  assert.equal(me.json.data.viewMasterPrices, true, '管理员重新开启后应默认开启共享');
  assert.deepEqual(await masterViewerIds(SERVER_A), [viewerAId]);

  const masterSelf = await admin.post(`/api/admin/accounts/${masterAId}/master-prices`, { allowed: false });
  assert.equal(masterSelf.status, 400);
  assert.match(masterSelf.json.message, /主账号/);

  const wrongServer = await admin.post(`/api/admin/servers/${serverAId}/master`, { accountId: masterBId });
  assert.equal(wrongServer.status, 400);
  assert.match(wrongServer.json.message, /当前区服/);
});

test('整行回退按区服隔离：只展示当前区服主账号的价格', async () => {
  const saveA = await masterA.post('/api/prices', {
    server: SERVER_A, city: CITY,
    items: [
      { commodity: '谷物', buy: 100, sell: 120 },
      { commodity: '黏土', buy: 50, sell: 60 },
    ],
  });
  assert.equal(saveA.status, 200);
  assert.equal(saveA.json.data.created, 2);

  const saveB = await masterB.post('/api/prices', {
    server: SERVER_B, city: CITY,
    items: [{ commodity: '谷物', buy: 300, sell: 330 }],
  });
  assert.equal(saveB.status, 200);

  let r = await viewerA.get(`/api/prices?server=${SERVER_A}&city=${CITY}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.masterAccountName, MASTER_A_NAME);
  assert.equal(r.json.data.items.find(i => i.commodity === '谷物').source, 'master');
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').buy, 50);
  assert.equal(r.json.data.sharedCount, 2);

  r = await viewerA.get(`/api/prices?server=${SERVER_B}&city=${CITY}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.masterAccountId, null, '查询其他区服不应串用本区服主账号');
  assert.equal(r.json.data.sharedCount, 0);
  assert.equal(r.json.data.items.find(i => i.commodity === '谷物').buy, null);

  r = await viewerB.get(`/api/prices?server=${SERVER_B}&city=${CITY}`);
  assert.equal(r.json.data.items.find(i => i.commodity === '谷物').buy, 300);
  assert.equal(r.json.data.items.find(i => i.commodity === '谷物').source, 'master');

  const own = await viewerA.post('/api/prices', {
    server: SERVER_A, city: CITY,
    items: [{ commodity: '谷物', buy: 200, sell: 220 }],
  });
  assert.equal(own.status, 200);

  r = await viewerA.get(`/api/prices?server=${SERVER_A}&city=${CITY}`);
  const ownGu = r.json.data.items.find(i => i.commodity === '谷物');
  const sharedClay = r.json.data.items.find(i => i.commodity === '黏土');
  assert.equal(ownGu.buy, 200);
  assert.equal(ownGu.source, 'own');
  assert.equal(sharedClay.buy, 50);
  assert.equal(sharedClay.source, 'master');
  assert.equal(r.json.data.sharedCount, 1);

  const switched = await setServer(viewerA, SERVER_B);
  assert.equal(switched.status, 200);
  assert.equal(switched.json.data.masterAccountName, MASTER_B_NAME);
  r = await viewerA.get(`/api/prices?server=${SERVER_B}&city=${CITY}`);
  assert.equal(r.json.data.items.find(i => i.commodity === '谷物').source, 'master');
  r = await viewerA.get(`/api/prices?server=${SERVER_A}&city=${CITY}`);
  assert.equal(r.json.data.sharedCount, 0, '切换区服后旧区服主账号不再生效');

  const back = await setServer(viewerA, SERVER_A);
  assert.equal(back.status, 200);
  assert.equal(back.json.data.masterAccountName, MASTER_A_NAME);

  const masterQuery = await masterA.get(`/api/prices?server=${SERVER_A}&city=${CITY}`);
  assert.equal(masterQuery.json.data.items.find(i => i.commodity === '谷物').buy, 100, '查看者保存不得覆盖主账号');
});

test('历史、趋势、比价、导出均支持本区服主账号回退', async () => {
  const history = await viewerA.get(`/api/prices/history?server=${SERVER_A}&city=${CITY}&limit=50`);
  assert.equal(history.status, 200);
  assert.equal(history.json.data.source, 'own', '本人已有价格行时历史不回退');

  const sharedHistory = await viewerA.get(`/api/prices/history?server=${SERVER_B}&city=CITY-UNKNOWN&limit=50`);
  assert.equal(sharedHistory.status, 200, '未知区服应返回空而不是报错');
  assert.equal(sharedHistory.json.data.total, 0);

  await masterA.post('/api/prices', {
    server: SERVER_A, city: '浈阳',
    items: [{ commodity: '葡萄', buy: 80, sell: 95 }],
  });
  const fallbackHistory = await viewerA.get(`/api/prices/history?server=${SERVER_A}&city=浈阳&limit=50`);
  assert.equal(fallbackHistory.json.data.source, 'master');
  assert.ok(fallbackHistory.json.data.total > 0);
  assert.equal(fallbackHistory.json.data.masterAccountName, MASTER_A_NAME);

  const crossServerHistory = await viewerA.get(`/api/prices/history?server=${SERVER_B}&city=浈阳&limit=50`);
  assert.equal(crossServerHistory.json.data.source, null, '其他区服不应回退本区服主账号历史');

  const trend = await viewerA.get(`/api/prices/trend?server=${SERVER_A}&city=桂阳&commodity=黏土&days=30`);
  assert.equal(trend.status, 200);
  assert.equal(trend.json.data.source, 'master');
  assert.equal(trend.json.data.summary.lastBuy, 50);

  const matrix = await viewerA.get(`/api/prices/matrix?server=${SERVER_A}&commodity=葡萄`);
  assert.equal(matrix.status, 200);
  assert.equal(matrix.json.data.sharedCount, 1);
  const matrixCity = matrix.json.data.items.find(i => i.city === '浈阳');
  assert.equal(matrixCity.source, 'master');
  assert.equal(matrixCity.buy, 80);

  const csv = await viewerA.get(`/api/prices/export?server=${SERVER_A}&city=浈阳`);
  assert.equal(csv.status, 200);
  const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], '区服,城池,商品,负重,买价,卖价,更新时间,更新人,来源');
  const grapeLine = lines.find(l => l.startsWith(`${SERVER_A},浈阳,葡萄,`));
  assert.ok(grapeLine);
  assert.match(grapeLine, /,主账号$/);
});

test('税率回退与保存/导入换算，本人税率优先', async () => {
  const serverRow = await db.get('SELECT id FROM servers WHERE name = ?', [SERVER_A]);
  const cityRow = await db.get("SELECT id FROM dict_items WHERE type = 'city' AND name = ?", [CITY]);
  await db.setCityTax(masterAId, serverRow.id, cityRow.id, 0.2);

  let r = await viewerA.get(`/api/prices?server=${SERVER_A}&city=${CITY}`);
  assert.equal(r.json.data.tax, 0.2, '本人无税率时回退本区服主账号税率');
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').buy, 59.5);
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').sell, 48.6);

  const save = await viewerA.post('/api/prices', {
    server: SERVER_A, city: CITY,
    items: [{ commodity: '葡萄', buy: 119, sell: 81 }],
  });
  assert.equal(save.status, 200);
  let raw = await db.get(
    `SELECT p.buy_price AS buy, p.sell_price AS sell
       FROM prices p JOIN dict_items d ON d.id = p.commodity_id
      WHERE p.account_id = ? AND p.server_id = ? AND p.city_id = ? AND d.name = '葡萄'`,
    [viewerAId, serverRow.id, cityRow.id]
  );
  assert.equal(raw.buy, 100, '保存应按主账号税率还原为税前原价');
  assert.equal(raw.sell, 100);

  const imported = await viewerA.post('/api/prices/import', {
    server: SERVER_A, city: CITY,
    rows: [{ commodity: '药材', buy: 119, sell: 81 }],
  });
  assert.equal(imported.status, 200, imported.json && imported.json.message);
  raw = await db.get(
    `SELECT p.buy_price AS buy, p.sell_price AS sell
       FROM prices p JOIN dict_items d ON d.id = p.commodity_id
      WHERE p.account_id = ? AND p.server_id = ? AND p.city_id = ? AND d.name = '药材'`,
    [viewerAId, serverRow.id, cityRow.id]
  );
  assert.equal(raw.buy, 100);
  assert.equal(raw.sell, 100);

  await db.setCityTax(viewerAId, serverRow.id, cityRow.id, 0.1);
  r = await viewerA.get(`/api/prices?server=${SERVER_A}&city=${CITY}`);
  assert.equal(r.json.data.tax, 0.1, '本人税率应优先于主账号');
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').buy, 54.8);
  assert.equal(r.json.data.items.find(i => i.commodity === '葡萄').buy, 109.5);
});

test('账号管理可设/取消当前区服主账号，取消或删除只影响对应区服', async () => {
  const cleared = await admin.post(`/api/admin/accounts/${masterAId}/master`, { master: false });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.data.changed, true);
  assert.equal(cleared.json.data.name, SERVER_A);
  assert.equal(await getServerMaster(SERVER_A), null);
  assert.equal((await getServerMaster(SERVER_B)).name, MASTER_B_NAME);

  let me = await viewerA.get('/api/auth/me');
  assert.equal(me.json.data.masterAccountId, null);
  assert.equal(me.json.data.viewMasterPrices, false);

  let r = await viewerA.get(`/api/prices?server=${SERVER_A}&city=${CITY}`);
  assert.equal(r.json.data.masterAccountId, null);
  assert.equal(r.json.data.sharedCount, 0);
  assert.equal(r.json.data.items.find(i => i.commodity === '黏土').source, null);

  const denied = await viewerA.put('/api/auth/master-prices', { enabled: true });
  assert.equal(denied.status, 400);
  assert.match(denied.json.message, /尚未指定/);

  me = await viewerB.get('/api/auth/me');
  assert.equal(me.json.data.masterAccountName, MASTER_B_NAME);
  r = await viewerB.get(`/api/prices?server=${SERVER_B}&city=${CITY}`);
  assert.equal(r.json.data.sharedCount, 1, '取消其他区服主账号不应影响本区服');

  const restored = await admin.post(`/api/admin/accounts/${masterAId}/master`, { master: true });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.data.name, SERVER_A);
  assert.equal((await getServerMaster(SERVER_A)).name, MASTER_A_NAME);
  assert.equal((await viewerA.get('/api/auth/me')).json.data.viewMasterPrices, true);
  assert.equal((await viewerA.put('/api/auth/master-prices', { enabled: true })).status, 200);
  const removed = await admin.del(`/api/admin/accounts/${masterAId}?confirm=${encodeURIComponent(MASTER_A_NAME)}`);
  assert.equal(removed.status, 200);

  assert.equal(await getServerMaster(SERVER_A), null);
  assert.equal((await getServerMaster(SERVER_B)).name, MASTER_B_NAME);
  me = await viewerA.get('/api/auth/me');
  assert.equal(me.json.data.masterAccountName, '');
  assert.equal(me.json.data.viewMasterPrices, false);
  assert.deepEqual(await masterViewerIds(SERVER_A), []);
  assert.deepEqual(await masterViewerIds(SERVER_B), [viewerBId]);
});
