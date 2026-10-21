'use strict';

/** API 测试：卡密登录 / 签名 / 字典只读 / 价格 / 导入导出 / 数据隔离 */

const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `price-test-${process.pid}-${Date.now()}.db`);
process.env.ADMIN_PASSWORD = 'test-admin-pass';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const app = require('../server');
const db = require('../server/db');
const {
  createClient, createAdmin, registerAccount, issueKeys, signRequest, makeDeviceId,
} = require('./helpers');

const BASE_FILE = process.env.PRICE_DB;
let server;
let base = '';
let admin;
let a;

before(async () => {
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = createAdmin(base);
  const login = await admin.login();
  assert.equal(login.status, 200);
  a = await registerAccount(base, admin, { name: '甲玩家', password: 'pass-1111' });
});

after(async () => {
  require('../server/scheduler').stop();
  await new Promise(res => server.close(res));
  await db.close().catch(() => {});
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(BASE_FILE + suffix); } catch { /* ignore */ }
  }
});

/* ------------------------------ 鉴权与签名 ------------------------------ */

test('未登录无法访问业务接口', async () => {
  const anon = createClient(base);
  for (const path of ['/api/prices?server=T1&city=桂阳', '/api/dict?type=city', '/api/sync-settings', '/api/servers']) {
    const r = await anon.get(path);
    assert.equal(r.status, 401, path);
  }
  const adminAnon = createAdmin(base);
  const r = await adminAnon.get('/api/admin/overview');
  assert.equal(r.status, 401);
});

test('已登录请求必须携带 HMAC 签名，且随机数不可重放', async () => {
  const unsigned = await a.get('/api/auth/me', { sign: false });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.json.code, 40112);

  const s = signRequest(a.token, 'GET', '/api/auth/me', undefined);
  const headers = {
    'X-Account-Token': a.token,
    'X-Device-Id': a.deviceId,
    'X-Timestamp': s.ts,
    'X-Nonce': s.nonce,
    'X-Sign': s.sign,
  };
  const first = await fetch(`${base}/api/auth/me`, { headers });
  assert.equal(first.status, 200);
  const replay = await fetch(`${base}/api/auth/me`, { headers });
  assert.equal(replay.status, 401);
  assert.match((await replay.json()).message, /重复/);

  const wrong = await fetch(`${base}/api/auth/me`, {
    headers: { ...headers, 'X-Nonce': crypto.randomBytes(8).toString('hex'), 'X-Sign': 'f'.repeat(64) },
  });
  assert.equal(wrong.status, 401);
});

test('设备与会话绑定：换设备使用同一会话被拒绝', async () => {
  const cloned = createClient(base, { token: a.token, deviceId: makeDeviceId('other'), deviceName: '另一台' });
  const r = await cloned.get('/api/auth/me');
  assert.equal(r.status, 401);
  assert.match(r.json.message, /设备/);
});

/* ------------------------------ 字典（只读） ------------------------------ */

test('字典只读：种子数据可查，普通账号不能维护', async () => {
  const commodities = await a.get('/api/dict?type=commodity');
  assert.equal(commodities.json.data.total, 25);
  assert.equal(commodities.json.data.items.find(i => i.name === '毛皮').burden, 18);
  const cities = await a.get('/api/dict?type=city');
  assert.equal(cities.json.data.total, 40);

  const create = await a.post('/api/dict', { type: 'commodity', name: '普通账号新增' });
  assert.equal(create.status, 404);
});

test('管理后台可维护字典（新增/重名/修改/删除）', async () => {
  const created = await admin.post('/api/admin/dict', { type: 'commodity', name: '测试宝石', burden: 7.5 });
  assert.equal(created.status, 200);
  const id = created.json.data.id;

  const dup = await admin.post('/api/admin/dict', { type: 'commodity', name: '测试宝石' });
  assert.equal(dup.status, 409);

  const updated = await admin.put(`/api/admin/dict/${id}`, { name: '测试宝石', burden: 9 });
  assert.equal(updated.json.data.burden, 9);

  const removed = await admin.del(`/api/admin/dict/${id}`);
  assert.equal(removed.status, 200);
});

/* ------------------------------ 价格 ------------------------------ */

test('查询：未指定区服且账号未绑定时返回 400', async () => {
  const r = await a.get('/api/prices?city=桂阳');
  assert.equal(r.status, 400);
  assert.match(r.json.message, /区服/);
});

test('保存：默认更新人为账号昵称，并记住当前区服', async () => {
  const save = await a.post('/api/prices', {
    server: 'T1', city: '桂阳',
    items: [
      { commodity: '谷物', buy: 20, sell: 30 },
      { commodity: '兵器', buy: 100, sell: 160 },
    ],
  });
  assert.equal(save.status, 200);
  assert.equal(save.json.data.created, 2);

  const query = await a.get('/api/prices?city=桂阳');
  assert.equal(query.status, 200, '已保存当前区服，可省略 server');
  const gu = query.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(gu.buy, 20);
  assert.equal(gu.operator, '甲玩家');

  const me = await a.get('/api/auth/me');
  assert.equal(me.json.data.currentServer, 'T1');
});

test('保存：body.operator 可覆盖更新人；再次保存记为新值', async () => {
  const save = await a.post('/api/prices', {
    server: 'T1', city: '桂阳', operator: '阿兵',
    items: [{ commodity: '谷物', buy: 25, sell: 31 }],
  });
  assert.equal(save.json.data.updated, 1);

  const query = await a.get('/api/prices?server=T1&city=桂阳');
  const gu = query.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(gu.buy, 25);
  assert.equal(gu.operator, '阿兵');
});

test('保存：未知商品 400；非法价格后事务不泄漏', async () => {
  const unknown = await a.post('/api/prices', { server: 'T1', city: '桂阳', items: [{ commodity: '不存在的商品', buy: 1, sell: 2 }] });
  assert.equal(unknown.status, 400);

  const bad = await a.post('/api/prices', { server: 'T1', city: '桂阳', items: [{ commodity: '谷物', buy: 999999999999, sell: 1 }] });
  assert.equal(bad.status, 400);

  const good = await a.post('/api/prices', { server: 'T1', city: '桂阳', items: [{ commodity: '盐', buy: 5, sell: 8 }] });
  assert.equal(good.status, 200);
  assert.equal(good.json.data.created, 1);
});

test('保存：清空价格（两个空值删除记录）', async () => {
  const r = await a.post('/api/prices', { server: 'T1', city: '桂阳', items: [{ commodity: '盐', buy: '', sell: '' }] });
  assert.equal(r.json.data.cleared, 1);
  const query = await a.get('/api/prices?server=T1&city=桂阳');
  assert.equal(query.json.data.items.find(i => i.commodity === '盐').buy, null);
});

/* ------------------------------ 历史 / 趋势 / 比价 / 导出 ------------------------------ */

test('历史：记录变更前后值与操作人', async () => {
  const r = await a.get('/api/prices/history?server=T1&city=桂阳&limit=20');
  assert.equal(r.json.code, 0);
  const change = r.json.data.items.find(
    i => i.commodity === '谷物' && i.field === 'buy_price' && i.oldValue === 20
  );
  assert.ok(change);
  assert.equal(change.newValue, 25);
  assert.equal(change.operator, '阿兵');
  const create = r.json.data.items.find(
    i => i.commodity === '谷物' && i.field === 'buy_price' && i.oldValue === null
  );
  assert.ok(create);
  assert.equal(create.operator, '甲玩家');
});

test('趋势：返回按天的价格点且前向填充', async () => {
  const r = await a.get('/api/prices/trend?server=T1&city=桂阳&commodity=谷物&days=30');
  assert.equal(r.json.code, 0);
  assert.ok(r.json.data.points.length >= 1);
  const last = r.json.data.points[r.json.data.points.length - 1];
  assert.equal(last.buy, 25);
  assert.equal(last.sell, 31);
  for (const p of r.json.data.points) {
    assert.notEqual(p.buy, null, `${p.date} 缺买价`);
    assert.notEqual(p.sell, null, `${p.date} 缺卖价`);
  }
});

test('比价：跨城池价格矩阵含最低买入城', async () => {
  await a.post('/api/prices', { server: 'T1', city: '江陵', items: [{ commodity: '谷物', buy: 18, sell: 28 }] });
  const r = await a.get('/api/prices/matrix?server=T1&commodity=谷物');
  assert.equal(r.json.code, 0);
  assert.equal(r.json.data.items.length, 40);
  assert.equal(r.json.data.summary.minBuy, 18);
  assert.equal(r.json.data.summary.bestBuyCity, '江陵');
});

test('大事件：同区服共享标记、过期过滤、重复推送更新', async () => {
  const serverId = await db.upsertServer('T1');
  const cityId = await db.findDictId('city', '桂阳');
  const commodityId = await db.findDictId('commodity', '谷物');
  const now = Date.now();
  const activeEnd = now + 3600000;

  await db.saveCityEvents(serverId, [
    {
      cityId, commodityId, metaId: '1',
      startsAt: db.formatTime(now - 60000), endsAt: db.formatTime(activeEnd),
    },
    {
      cityId, commodityId, metaId: 'news-expired',
      startsAt: db.formatTime(now - 7200000), endsAt: db.formatTime(now - 3600000),
    },
  ]);

  const query = await a.get('/api/prices?server=T1&city=桂阳');
  assert.equal(query.json.data.events.length, 1);
  assert.equal(query.json.data.events[0].metaId, '1');
  assert.equal(query.json.data.events[0].commodity, '谷物');
  assert.equal(query.json.data.events[0].priceCorrection, 0.35);
  assert.equal(query.json.data.events[0].description, '桂阳多地遭黄巾残部劫粮焚仓，粮食储备锐减，谷物价格大涨35%');
  const gu = query.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(gu.events.length, 1);
  assert.equal(gu.events[0].startsAt, db.formatTime(now - 60000));
  assert.equal(gu.buy, 33.8);
  assert.equal(gu.sell, 41.9);

  const matrix = await a.get('/api/prices/matrix?server=T1&commodity=谷物');
  const guiyang = matrix.json.data.items.find(i => i.city === '桂阳');
  assert.equal(guiyang.events.length, 1);
  assert.equal(matrix.json.data.events.length, 1);

  const b = await registerAccount(base, admin, { name: '事件共享玩家', password: 'pass-3333' });
  const shared = await b.get('/api/prices?server=T1&city=桂阳');
  assert.equal(shared.json.data.events.length, 1, '同区服其他账号可见');

  const newEnd = now + 7200000;
  await db.saveCityEvents(serverId, [{
    cityId, commodityId, metaId: '1',
    startsAt: db.formatTime(now - 120000), endsAt: db.formatTime(newEnd),
  }]);
  const updated = await db.getActiveCityEvents(serverId, cityId);
  assert.equal(updated.length, 1, '相同事件只保留一条');
  assert.equal(updated[0].endsAt, db.formatTime(newEnd));

  await db.saveCityEvents(serverId, [{
    cityId, commodityId, metaId: '1',
    startsAt: db.formatTime(now - 7200000), endsAt: db.formatTime(now - 3600000),
  }]);
  assert.equal((await db.getActiveCityEvents(serverId, cityId)).length, 0);
});

test('导出：CSV 含表头与 BOM', async () => {
  const r = await a.get('/api/prices/export?server=T1&city=桂阳');
  assert.equal(r.status, 200);
  assert.deepEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  const header = r.text.replace(/^\uFEFF/, '').split('\r\n')[0];
  assert.equal(header, '区服,城池,商品,负重,买价,卖价,更新时间,更新人,来源');
});

/* ------------------------------ 导入 ------------------------------ */

test('导入：未知商品不再自动创建，需管理员先维护字典', async () => {
  const bad = await a.post('/api/prices/import', { server: 'T1', city: '桂阳', text: '新商品甲\t3\t5\t20' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /新商品甲/);

  const created = await admin.post('/api/admin/dict', { type: 'commodity', name: '新商品甲', burden: 20 });
  assert.equal(created.status, 200);

  const okRes = await a.post('/api/prices/import', { server: 'T1', city: '桂阳', text: '香料\t6\t9\n新商品甲\t3\t5' });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.data.created, 2);

  const query = await a.get('/api/prices?server=T1&city=桂阳&commodity=香料');
  assert.equal(query.json.data.items[0].operator, '甲玩家');
});

test('导入：merge 模式单侧导入不清空另一侧', async () => {
  const save = await a.post('/api/prices', { server: 'T1', city: '零陵', items: [{ commodity: '毛皮', buy: 10.5, sell: 15 }] });
  assert.equal(save.status, 200);

  const r = await a.post('/api/prices/import', {
    server: 'T1', city: '零陵',
    rows: [{ commodity: '毛皮', buy: null, sell: 19.7 }],
    merge: true,
  });
  assert.equal(r.status, 200);

  const query = await a.get('/api/prices?server=T1&city=零陵&commodity=毛皮');
  const item = query.json.data.items[0];
  assert.equal(item.buy, 10.5);
  assert.equal(item.sell, 19.7);
});

/* ------------------------------ 数据隔离 ------------------------------ */

test('数据隔离：新账号看不到他人的价格/历史/区服统计', async () => {
  const b = await registerAccount(base, admin, { name: '乙玩家', password: 'pass-2222' });

  const query = await b.get('/api/prices?server=T1&city=桂阳');
  const gu = query.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(gu.buy, null, '乙账号看不到甲账号的价格');
  assert.equal(gu.sell, null);

  const history = await b.get('/api/prices/history?server=T1&city=桂阳');
  assert.equal(history.json.data.total, 0);

  const matrix = await b.get('/api/prices/matrix?server=T1&commodity=谷物');
  assert.equal(matrix.json.data.summary.pricedCount, 0);

  const servers = await b.get('/api/servers');
  const t1 = servers.json.data.items.find(s => s.name === 'T1');
  assert.ok(!t1 || t1.priceCount === 0);

  const reports = await b.get('/api/reports/movers?server=T1&days=7');
  assert.equal(reports.json.data.totalCandidates, 0);

  // 甲账号数据不受影响
  const again = await a.get('/api/prices?server=T1&city=桂阳');
  assert.equal(again.json.data.items.find(i => i.commodity === '谷物').buy, 25);
});

/* ------------------------------ 健康检查 ------------------------------ */

test('健康检查可用', async () => {
  const r = await createClient(base).get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 0);
});
