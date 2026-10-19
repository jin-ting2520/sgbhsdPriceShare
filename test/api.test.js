'use strict';

/** API 冒烟测试：node:test，无额外依赖。运行：npm test */

const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `price-test-${process.pid}-${Date.now()}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

const BASE_FILE = process.env.PRICE_DB;
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
    try { fs.unlinkSync(BASE_FILE + suffix); } catch (e) { /* ignore */ }
  }
});

/* ------------------------------ 字典 ------------------------------ */

test('字典列表包含种子数据（25 商品 / 40 城池，含毛皮负重）', async () => {
  const commodities = await api('/api/dict?type=commodity');
  assert.equal(commodities.json.data.total, 25);
  const maopi = commodities.json.data.items.find(i => i.name === '毛皮');
  assert.ok(maopi, '应包含新增商品「毛皮」');
  assert.equal(maopi.burden, 18);

  const cities = await api('/api/dict?type=city');
  assert.equal(cities.json.data.total, 40);
});

test('商品负重可维护，名称不可重复', async () => {
  const created = await api('/api/dict', {
    method: 'POST', body: { type: 'commodity', name: '测试宝石', burden: 7.5 },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.data.burden, 7.5);

  const dup = await api('/api/dict', {
    method: 'POST', body: { type: 'commodity', name: '测试宝石', burden: 7.5 },
  });
  assert.equal(dup.status, 409);

  const updated = await api(`/api/dict/${created.json.data.id}`, {
    method: 'PUT', body: { burden: 9 },
  });
  assert.equal(updated.json.data.burden, 9);

  await api(`/api/dict/${created.json.data.id}`, { method: 'DELETE' });
});

/* ------------------------------ 价格 ------------------------------ */

test('查询：初始无数据显示全部商品且价格为空', async () => {
  const r = await api('/api/prices?server=T1&city=桂阳');
  assert.equal(r.json.code, 0);
  assert.equal(r.json.data.items.length, 25);
  const first = r.json.data.items[0];
  assert.equal(first.buy, null);
  assert.equal(first.sell, null);
  assert.equal(first.burden, 10); // 谷物负重
});

test('保存：写入价格并带出负重/更新时间/更新人（昵称）', async () => {
  const save = await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'T1', city: '桂阳', operator: '小关关',
      items: [
        { commodity: '谷物', buy: 20, sell: 30 },
        { commodity: '兵器', buy: 100, sell: 160 },
      ],
    },
  });
  assert.equal(save.status, 200);
  assert.equal(save.json.data.created, 2);

  const query = await api('/api/prices?server=T1&city=桂阳');
  const gu = query.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(gu.buy, 20);
  assert.equal(gu.sell, 30);
  assert.equal(gu.burden, 10);
  assert.equal(gu.profit, undefined, '同城视角不再返回利润字段');
  assert.ok(gu.updatedAt, '应有更新时间');
  assert.equal(gu.operator, '小关关', '更新人应为保存时提交的昵称');
});

test('保存：覆盖更新并记录新的更新人昵称', async () => {
  const save = await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'T1', city: '桂阳', operator: '阿兵',
      items: [{ commodity: '谷物', buy: 25, sell: 31 }],
    },
  });
  assert.equal(save.json.data.updated, 1);

  const query = await api('/api/prices?server=T1&city=桂阳');
  const gu = query.json.data.items.find(i => i.commodity === '谷物');
  assert.equal(gu.buy, 25);
  assert.equal(gu.sell, 31);
  assert.equal(gu.operator, '阿兵', '覆盖保存后更新人应随之更新');
});

test('保存：未带昵称时记录为「匿名」', async () => {
  const save = await api('/api/prices', {
    method: 'POST',
    body: { server: 'T1', city: '桂阳', items: [{ commodity: '盐', buy: 5, sell: 8 }] },
  });
  assert.equal(save.status, 200);

  const query = await api('/api/prices?server=T1&city=桂阳');
  const yan = query.json.data.items.find(i => i.commodity === '盐');
  assert.equal(yan.operator, '匿名');
});

test('保存：清空价格（两个空值删除记录）', async () => {
  const r = await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'T1', city: '桂阳', operator: '阿兵',
      items: [{ commodity: '盐', buy: '', sell: '' }],
    },
  });
  assert.equal(r.json.data.cleared, 1);

  const query = await api('/api/prices?server=T1&city=桂阳');
  const yan = query.json.data.items.find(i => i.commodity === '盐');
  assert.equal(yan.buy, null);
});

test('保存：未知商品返回 400', async () => {
  const r = await api('/api/prices', {
    method: 'POST',
    body: { server: 'T1', city: '桂阳', items: [{ commodity: '不存在的商品', buy: 1, sell: 2 }] },
  });
  assert.equal(r.status, 400);
});

test('保存：非法价格 400 后事务不泄漏，后续保存仍成功', async () => {
  const bad = await api('/api/prices', {
    method: 'POST',
    body: { server: 'T1', city: '桂阳', items: [{ commodity: '谷物', buy: 999999999999, sell: 1 }] },
  });
  assert.equal(bad.status, 400);

  const good = await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'T1', city: '桂阳', operator: '阿兵',
      items: [{ commodity: '谷物', buy: '', sell: '' }],
    },
  });
  assert.equal(good.status, 200, '400 之后的保存不应报「cannot start a transaction within a transaction」');
  assert.equal(good.json.data.cleared, 1, '买价卖价都为空应清空该行');
});

/* ------------------------------ 历史 / 趋势 / 比价 ------------------------------ */

test('历史：记录变更前后值与操作人昵称', async () => {
  const r = await api('/api/prices/history?server=T1&city=桂阳&limit=20');
  assert.equal(r.json.code, 0);

  const change = r.json.data.items.find(
    i => i.commodity === '谷物' && i.field === 'buy_price' && i.oldValue === 20
  );
  assert.ok(change, '应有谷物买价 20 → 25 的变更记录');
  assert.equal(change.newValue, 25);
  assert.equal(change.operator, '阿兵');

  const create = r.json.data.items.find(
    i => i.commodity === '谷物' && i.field === 'buy_price' && i.oldValue === null
  );
  assert.ok(create, '应有谷物首次录入记录');
  assert.equal(create.operator, '小关关');
});

test('趋势：返回按天的价格点', async () => {
  const r = await api('/api/prices/trend?server=T1&city=桂阳&commodity=谷物&days=30');
  assert.equal(r.json.code, 0);
  assert.ok(Array.isArray(r.json.data.points));
  assert.ok(r.json.data.points.length >= 1);
  const last = r.json.data.points[r.json.data.points.length - 1];
  assert.equal(last.buy, 25);
  assert.equal(last.sell, 31);
  // 前向填充：每个数据点买价卖价都应有值，保证图上两条线连续完整
  for (const p of r.json.data.points) {
    assert.notEqual(p.buy, null, `${p.date} 缺买价`);
    assert.notEqual(p.sell, null, `${p.date} 缺卖价`);
  }
});

test('比价：跨城池价格矩阵含最低买入城', async () => {
  await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'T1', city: '江陵', operator: '小关关',
      items: [{ commodity: '谷物', buy: 18, sell: 28 }],
    },
  });
  const r = await api('/api/prices/matrix?server=T1&commodity=谷物');
  assert.equal(r.json.code, 0);
  assert.equal(r.json.data.items.length, 40);
  assert.equal(r.json.data.summary.minBuy, 18);
  assert.equal(r.json.data.summary.bestBuyCity, '江陵');
});

/* ------------------------------ 导入导出 ------------------------------ */

test('导出：CSV 含负重/更新时间/更新人表头与 BOM', async () => {
  const res = await fetch(`${base}/api/prices/export?server=T1&city=桂阳`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf[0], 0xef, 'CSV 应带 UTF-8 BOM');
  const text = buf.toString('utf8');
  const header = text.split('\r\n')[0].replace('\uFEFF', '');
  assert.equal(header, '区服,城池,商品,负重,买价,卖价,更新时间,更新人');
});

test('导入：粘贴多行数据并自动创建新商品（可带负重，记录操作人）', async () => {
  const r = await api('/api/prices/import', {
    method: 'POST',
    body: {
      server: 'T1', city: '桂阳', operator: '导入员',
      text: '香料\t6\t9\n新商品甲\t3\t5\t20',
      createCommodities: true,
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.created, 2);
  assert.equal(r.json.data.newDictCount, 1);

  const dict = await api('/api/dict?type=commodity&keyword=新商品甲');
  const item = dict.json.data.items[0];
  assert.ok(item);
  assert.equal(item.burden, 20);

  const query = await api('/api/prices?server=T1&city=桂阳&commodity=香料');
  assert.equal(query.json.data.items[0].operator, '导入员', '导入的价格也应记录操作人昵称');
});

test('导入：Excel 结构化 rows（合法行导入 + 非法行 400 不落库）', async () => {
  const bad = await api('/api/prices/import', {
    method: 'POST',
    body: {
      server: 'T1', city: '桂阳',
      rows: [{ commodity: '谷物', buy: 'abc', sell: 1 }],
    },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /买价/);

  const okRes = await api('/api/prices/import', {
    method: 'POST',
    body: {
      server: 'T1', city: '桂阳', operator: '表格导入',
      rows: [
        { commodity: '香料', buy: 7, sell: 11 },
        { commodity: '谷物', buy: '', sell: 20 },
        { commodity: '', buy: 1, sell: 2 },
      ],
      createCommodities: false,
    },
  });
  assert.equal(okRes.status, 200);
  // 香料已有价 → 更新；谷物在前序用例中被清空删除 → 重新创建
  assert.equal(okRes.json.data.updated, 1);
  assert.equal(okRes.json.data.created, 1);

  const query = await api('/api/prices?server=T1&city=桂阳&commodity=谷物');
  const gu = query.json.data.items[0];
  assert.equal(gu.buy, null, '空买价应清空原买价');
  assert.equal(gu.sell, 20);
  assert.equal(gu.operator, '表格导入');
});

test('导入：merge 模式单侧导入不清空另一侧价格', async () => {
  // 先造完整双侧价
  const save = await api('/api/prices', {
    method: 'POST',
    body: {
      server: 'T1', city: '零陵', operator: '甲',
      items: [{ commodity: '毛皮', buy: 10.5, sell: 15 }],
    },
  });
  assert.equal(save.status, 200);

  // 只提供卖出价 → merge 应保留买价
  const r = await api('/api/prices/import', {
    method: 'POST',
    body: {
      server: 'T1', city: '零陵', operator: '单侧导入',
      rows: [{ commodity: '毛皮', buy: null, sell: 19.7, burden: 18 }],
      merge: true,
      createCommodities: false,
    },
  });
  assert.equal(r.status, 200);

  const query = await api('/api/prices?server=T1&city=零陵&commodity=毛皮');
  const item = query.json.data.items[0];
  assert.equal(item.buy, 10.5, 'merge 模式 null 买价不应清空原买价');
  assert.equal(item.sell, 19.7, 'merge 模式非空卖价应更新');
  assert.equal(item.operator, '单侧导入');
});

/* ------------------------------ 健康检查 ------------------------------ */

test('健康检查可用', async () => {
  const r = await api('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 0);
});
