'use strict';

/** 价格：查询 / 保存 / 历史 / 趋势 / 比价 / 导出 / 导入 */

const express = require('express');
const { db, upsertServer, findServerId, findDictId, createDictItem, calcProfit } = require('../db');
const {
  ok, fail, asyncHandler, cleanName, isBlank, parsePrice,
  isUniqueConstraintError,
} = require('../util');

const router = express.Router();

const MAX_ITEMS = 500;

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 操作人 = 用户进入站点时输入的昵称（客户端随保存请求提交） */
const operatorOf = body => {
  const name = cleanName(body && body.operator, 20);
  return name || '匿名';
};

/** GET /api/prices?server=&city=&commodity= —— 查询价格（商品列固定展示全部商品） */
router.get('/', asyncHandler((req, res) => {
  const server = cleanName(req.query.server, 50);
  const city = cleanName(req.query.city, 20);
  const commodity = cleanName(req.query.commodity, 20);

  if (isBlank(server)) return fail(res, 400, '请先输入区服');
  if (isBlank(city)) return fail(res, 400, '请先选择城池');

  const commoditySql = commodity ? `AND name = ?` : '';
  const commodities = db.prepare(
    `SELECT id, name, burden, sort_order FROM dict_items
      WHERE type = 'commodity' AND status = 1 ${commoditySql}
      ORDER BY sort_order, id`
  ).all(...(commodity ? [commodity] : []));

  if (commodity && commodities.length === 0) {
    return fail(res, 400, `商品「${commodity}」不存在，请先通过商品下拉框新增`);
  }

  const serverId = findServerId(server);
  const cityId = findDictId('city', city);
  let priceMap = {};
  if (serverId && cityId) {
    const rows = db.prepare(
      `SELECT commodity_id AS commodityId, buy_price AS buy, sell_price AS sell,
              operator, updated_at AS updatedAt
         FROM prices WHERE server_id = ? AND city_id = ?`
    ).all(serverId, cityId);
    priceMap = Object.fromEntries(rows.map(r => [r.commodityId, r]));
  }

  const items = commodities.map(c => {
    const p = priceMap[c.id];
    const buy = p ? p.buy : null;
    const sell = p ? p.sell : null;
    return {
      commodityId: c.id,
      commodity: c.name,
      burden: c.burden,
      buy,
      sell,
      profit: calcProfit(buy, sell, c.burden),
      updatedAt: p ? p.updatedAt : null,
      operator: p ? p.operator : null,
    };
  });

  return ok(res, {
    server,
    city,
    serverRegistered: !!serverId,
    cityRegistered: !!cityId,
    items,
  });
}));

/** POST /api/prices —— 保存价格（覆盖写，仅提交有改动的行） */
router.post('/', asyncHandler((req, res) => {
  const server = cleanName(req.body.server, 50);
  const city = cleanName(req.body.city, 20);
  const items = Array.isArray(req.body.items) ? req.body.items : null;

  if (isBlank(server)) return fail(res, 400, '请先输入区服');
  if (isBlank(city)) return fail(res, 400, '请先选择城池');
  if (!items || items.length === 0) return fail(res, 400, '没有需要保存的价格数据');
  if (items.length > MAX_ITEMS) return fail(res, 400, `单次最多保存 ${MAX_ITEMS} 条`);

  // 城池 / 商品必须已在字典中（新增入口见 /api/dict）
  const unknownCommodities = [...new Set(items.map(i => cleanName(i.commodity, 20)).filter(Boolean))]
    .filter(name => !findDictId('commodity', name));
  if (unknownCommodities.length) {
    return fail(res, 400, `商品 ${unknownCommodities.map(n => `「${n}」`).join('、')} 不在字典中，请先通过商品下拉框新增`);
  }

  const serverId = upsertServer(server);
  const cityId = findDictId('city', city);
  if (!cityId) return fail(res, 400, `城池「${city}」不在字典中，请先通过城池下拉框新增`);

  const operator = operatorOf(req.body);

  const getExisting = db.prepare(
    'SELECT id, buy_price AS buy, sell_price AS sell FROM prices WHERE server_id = ? AND city_id = ? AND commodity_id = ?'
  );
  const upsert = db.prepare(
    `INSERT INTO prices (server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(server_id, city_id, commodity_id)
     DO UPDATE SET buy_price = excluded.buy_price, sell_price = excluded.sell_price,
                   operator = excluded.operator, updated_at = datetime('now','localtime')`
  );
  const remove = db.prepare(
    'DELETE FROM prices WHERE server_id = ? AND city_id = ? AND commodity_id = ?'
  );
  const logHistory = db.prepare(
    `INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value, operator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const summary = { saved: 0, updated: 0, created: 0, cleared: 0 };

  // node:sqlite 事务：失败整体回滚
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const raw of items) {
      const commodity = cleanName(raw && raw.commodity, 20);
      if (isBlank(commodity)) continue;
      const commodityId = findDictId('commodity', commodity);
      if (!commodityId) continue;

      const buy = parsePrice(raw && raw.buy);
      const sell = parsePrice(raw && raw.sell);
      if (!buy.ok) return fail(res, 400, `「${commodity}」买价：${buy.error}`);
      if (!sell.ok) return fail(res, 400, `「${commodity}」卖价：${sell.error}`);

      const existing = getExisting.get(serverId, cityId, commodityId);

      if (buy.value == null && sell.value == null) {
        if (existing) {
          remove.run(serverId, cityId, commodityId);
          if (existing.buy != null) logHistory.run(serverId, cityId, commodityId, 'buy_price', existing.buy, null, operator);
          if (existing.sell != null) logHistory.run(serverId, cityId, commodityId, 'sell_price', existing.sell, null, operator);
          summary.cleared += 1;
        }
        continue;
      }

      upsert.run(serverId, cityId, commodityId, buy.value, sell.value, operator);
      if (existing) {
        summary.updated += 1;
        if (existing.buy !== buy.value) logHistory.run(serverId, cityId, commodityId, 'buy_price', existing.buy, buy.value, operator);
        if (existing.sell !== sell.value) logHistory.run(serverId, cityId, commodityId, 'sell_price', existing.sell, sell.value, operator);
      } else {
        summary.created += 1;
        logHistory.run(serverId, cityId, commodityId, 'buy_price', null, buy.value, operator);
        logHistory.run(serverId, cityId, commodityId, 'sell_price', null, sell.value, operator);
      }
      summary.saved += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (isUniqueConstraintError(err)) return fail(res, 409, '同一区服城池商品的价格记录重复', 40901);
    throw err;
  }

  return ok(res, summary);
}));

/** GET /api/prices/history?server=&city=&limit= —— 最近变更流水 */
router.get('/history', asyncHandler((req, res) => {
  const server = cleanName(req.query.server, 50);
  const city = cleanName(req.query.city, 20);
  if (isBlank(server) || isBlank(city)) return ok(res, { total: 0, items: [] });

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const serverId = findServerId(server);
  const cityId = findDictId('city', city);
  if (!serverId || !cityId) return ok(res, { total: 0, items: [] });

  const rows = db.prepare(
    `SELECT h.id, h.field, h.old_value AS oldValue, h.new_value AS newValue, h.created_at AS createdAt,
            h.operator, s.name AS server, c.name AS city, d.name AS commodity
       FROM price_history h
       JOIN servers s    ON s.id = h.server_id
       JOIN dict_items c ON c.id = h.city_id
       JOIN dict_items d ON d.id = h.commodity_id
      WHERE h.server_id = ? AND h.city_id = ?
      ORDER BY h.id DESC LIMIT ?`
  ).all(serverId, cityId, limit);

  return ok(res, { total: rows.length, items: rows });
}));

/** GET /api/prices/trend?server=&city=&commodity=&days= —— 价格趋势（按天取当日最后值） */
router.get('/trend', asyncHandler((req, res) => {
  const server = cleanName(req.query.server, 50);
  const city = cleanName(req.query.city, 20);
  const commodity = cleanName(req.query.commodity, 20);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

  if (isBlank(server) || isBlank(city) || isBlank(commodity)) {
    return fail(res, 400, '请提供区服、城池和商品');
  }

  const serverId = findServerId(server);
  const cityId = findDictId('city', city);
  const commodityRow = db.prepare("SELECT id, name, burden FROM dict_items WHERE type = 'commodity' AND name = ?").get(commodity);
  if (!commodityRow) return fail(res, 400, `商品「${commodity}」不存在`);

  const rows = [];
  if (serverId && cityId) {
    rows.push(...db.prepare(
      `SELECT h.field, h.new_value AS value, h.created_at AS createdAt
         FROM price_history h
        WHERE h.server_id = ? AND h.city_id = ? AND h.commodity_id = ? AND h.new_value IS NOT NULL
        ORDER BY h.id`
    ).all(serverId, cityId, commodityRow.id));
  }

  // 近 N 天
  const cutoff = new Date(Date.now() - days * 86400000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const byDate = new Map();
  for (const r of rows) {
    const d = String(r.createdAt).slice(0, 10);
    if (d < cutoffStr) continue;
    if (!byDate.has(d)) byDate.set(d, {});
    byDate.get(d)[r.field === 'sell_price' ? 'sell' : 'buy'] = r.value;
  }
  const points = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, buy: v.buy ?? null, sell: v.sell ?? null }));

  const buys = points.map(p => p.buy).filter(v => v != null);
  const sells = points.map(p => p.sell).filter(v => v != null);
  const summary = {
    count: points.length,
    lastBuy: points.length ? points[points.length - 1].buy : null,
    lastSell: points.length ? points[points.length - 1].sell : null,
    minBuy: buys.length ? Math.min(...buys) : null,
    maxBuy: buys.length ? Math.max(...buys) : null,
    minSell: sells.length ? Math.min(...sells) : null,
    maxSell: sells.length ? Math.max(...sells) : null,
    firstBuy: buys.length ? buys[0] : null,
    buyChangePct: (buys.length > 1 && buys[0]) ? Math.round(((buys[buys.length - 1] - buys[0]) / buys[0]) * 10000) / 100 : null,
    sellChangePct: (sells.length > 1 && sells[0]) ? Math.round(((sells[sells.length - 1] - sells[0]) / sells[0]) * 10000) / 100 : null,
  };

  return ok(res, {
    server, city, commodity, burden: commodityRow.burden, days, points, summary,
  });
}));

/** GET /api/prices/matrix?server=&commodity= —— 跨城池比价（同一商品在所有城池的价格） */
router.get('/matrix', asyncHandler((req, res) => {
  const server = cleanName(req.query.server, 50);
  const commodity = cleanName(req.query.commodity, 20);
  if (isBlank(server) || isBlank(commodity)) return fail(res, 400, '请提供区服和商品');

  const serverId = findServerId(server);
  const commodityRow = db.prepare("SELECT id, name, burden FROM dict_items WHERE type = 'commodity' AND name = ?").get(commodity);
  if (!commodityRow) return fail(res, 400, `商品「${commodity}」不存在`);

  const rows = db.prepare(
    `SELECT c.id AS cityId, c.name AS city, c.sort_order AS sortOrder,
            p.buy_price AS buy, p.sell_price AS sell, p.operator, p.updated_at AS updatedAt
       FROM dict_items c
       LEFT JOIN prices p
              ON p.city_id = c.id AND p.commodity_id = ? AND p.server_id = ?
      WHERE c.type = 'city' AND c.status = 1
      ORDER BY (p.buy_price IS NULL), p.buy_price, c.sort_order, c.id`
  ).all(commodityRow.id, serverId || -1);

  const items = rows.map(r => ({
    cityId: r.cityId,
    city: r.city,
    buy: r.buy,
    sell: r.sell,
    burden: commodityRow.burden,
    profit: calcProfit(r.buy, r.sell, commodityRow.burden),
    updatedAt: r.updatedAt,
    operator: r.operator,
  }));

  const priced = items.filter(i => i.buy != null || i.sell != null);
  const buys = priced.map(i => i.buy).filter(v => v != null);
  const sells = priced.map(i => i.sell).filter(v => v != null);
  const summary = {
    cityCount: items.length,
    pricedCount: priced.length,
    minBuy: buys.length ? Math.min(...buys) : null,
    maxBuy: buys.length ? Math.max(...buys) : null,
    maxSell: sells.length ? Math.max(...sells) : null,
    minSell: sells.length ? Math.min(...sells) : null,
    buySpread: (buys.length > 1) ? Math.round((Math.max(...buys) - Math.min(...buys)) * 100) / 100 : 0,
    bestBuyCity: buys.length ? priced.find(i => i.buy === Math.min(...buys)).city : null,
    bestSellCity: sells.length ? priced.find(i => i.sell === Math.max(...sells)).city : null,
  };

  return ok(res, { server, commodity, burden: commodityRow.burden, items, summary });
}));

/** GET /api/prices/export?server=&city= —— CSV 导出（带 BOM，Excel 友好） */
router.get('/export', asyncHandler((req, res) => {
  const server = cleanName(req.query.server, 50);
  const city = cleanName(req.query.city, 20);
  if (isBlank(server) || isBlank(city)) return fail(res, 400, '请先选择区服和城池');

  const serverId = findServerId(server);
  const cityId = findDictId('city', city);
  let rows = [];
  if (serverId && cityId) {
    rows = db.prepare(
      `SELECT d.name AS commodity, d.burden, p.buy_price AS buy, p.sell_price AS sell,
              p.operator, p.updated_at AS updatedAt
         FROM prices p JOIN dict_items d ON d.id = p.commodity_id
        WHERE p.server_id = ? AND p.city_id = ? ORDER BY d.sort_order, d.id`
    ).all(serverId, cityId);
  }
  // 商品列固定展示全部商品：无价格的商品导出空值
  const existed = new Set(rows.map(r => r.commodity));
  const all = db.prepare(
    `SELECT name, burden FROM dict_items WHERE type = 'commodity' AND status = 1 ORDER BY sort_order, id`
  ).all();
  const full = all.map(c => {
    const hit = rows.find(r => r.commodity === c.name);
    const buy = hit ? hit.buy : null;
    const sell = hit ? hit.sell : null;
    return {
      commodity: c.name,
      burden: c.burden,
      buy,
      sell,
      profit: calcProfit(buy, sell, c.burden),
      updatedAt: hit ? hit.updatedAt : null,
      operator: hit ? hit.operator : null,
    };
  });

  const lines = ['区服,城池,商品,负重,买价,卖价,利润,更新时间,更新人'];
  for (const r of full) {
    lines.push([
      server, city, r.commodity, r.burden ?? '', r.buy ?? '', r.sell ?? '', r.profit ?? '',
      r.updatedAt ?? '', r.operator ?? '',
    ].map(csvCell).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${server}-${city}-价格表.csv`)}`);
  return res.send(csv);
}));

/** POST /api/prices/import —— 批量粘贴导入（商品\t买价\t卖价[负重]） */
router.post('/import', asyncHandler((req, res) => {
  const server = cleanName(req.body.server, 50);
  const city = cleanName(req.body.city, 20);
  const createMissing = req.body.createCommodities !== false;
  const text = typeof req.body.text === 'string' ? req.body.text : '';

  if (isBlank(server)) return fail(res, 400, '请先输入区服');
  if (isBlank(city)) return fail(res, 400, '请先选择城池');
  if (text.trim() === '') return fail(res, 400, '请粘贴要导入的数据');

  const serverId = upsertServer(server);
  const cityId = findDictId('city', city);
  if (!cityId) return fail(res, 400, `城池「${city}」不在字典中，请先通过城池下拉框新增`);
  const operator = operatorOf(req.body);

  const errors = [];
  const parsed = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;
    // 兼容 制表符 / 逗号(中英文) / 分号 / 空格 分隔
    const cols = raw.split(/[\t,，;；]|\s+/).map(s => s.trim()).filter(s => s !== '');
    if (cols.length < 2) {
      errors.push(`第 ${idx + 1} 行：「${raw}」格式应为 商品 + 买价 + 卖价`);
      return;
    }
    const [commodity, buy, sell, burden] = [cleanName(cols[0], 20), cols[1], cols[2], cols[3]];
    const pb = parsePrice(buy);
    const ps = parsePrice(sell);
    if (!pb.ok || !ps.ok) {
      errors.push(`第 ${idx + 1} 行：「${commodity}」${!pb.ok ? '买价' : '卖价'}${(!pb.ok ? pb.error : ps.error).replace(/^价格/, '')}`);
      return;
    }
    if (pb.value == null && ps.value == null) return;
    parsed.push({ commodity, buy: pb.value, sell: ps.value, burden });
  });

  if (errors.length) return fail(res, 400, `导入失败：${errors.slice(0, 3).join('；')}${errors.length > 3 ? ' 等' : ''}`);

  const unknown = [...new Set(parsed.map(p => p.commodity))].filter(n => !findDictId('commodity', n));
  if (unknown.length && !createMissing) {
    return fail(res, 400, `商品 ${unknown.map(n => `「${n}」`).join('、')} 不在字典中`);
  }
  for (const p of parsed) {
    if (unknown.includes(p.commodity)) {
      try { createDictItem('commodity', p.commodity, p.burden); } catch (e) { /* 并发冲突忽略 */ }
    } else if (p.burden != null && p.burden !== '') {
      // 导入行可携带负重，更新到字典
      const v = Number(p.burden);
      if (Number.isFinite(v) && v > 0) {
        db.prepare("UPDATE dict_items SET burden = ? WHERE type = 'commodity' AND name = ? AND (burden IS NULL OR burden = 0)").run(v, p.commodity);
      }
    }
  }

  const upsert = db.prepare(
    `INSERT INTO prices (server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(server_id, city_id, commodity_id)
     DO UPDATE SET buy_price = excluded.buy_price, sell_price = excluded.sell_price,
                   operator = excluded.operator, updated_at = datetime('now','localtime')`
  );
  const getExisting = db.prepare(
    'SELECT buy_price AS buy, sell_price AS sell FROM prices WHERE server_id = ? AND city_id = ? AND commodity_id = ?'
  );
  const logHistory = db.prepare(
    `INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value, operator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let created = 0;
  let updated = 0;
  let newDictCount = unknown.length;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of parsed) {
      const commodityId = findDictId('commodity', p.commodity);
      const existing = getExisting.get(serverId, cityId, commodityId);
      upsert.run(serverId, cityId, commodityId, p.buy, p.sell, operator);
      if (existing) {
        updated += 1;
        if (existing.buy !== p.buy) logHistory.run(serverId, cityId, commodityId, 'buy_price', existing.buy, p.buy, operator);
        if (existing.sell !== p.sell) logHistory.run(serverId, cityId, commodityId, 'sell_price', existing.sell, p.sell, operator);
      } else {
        created += 1;
        logHistory.run(serverId, cityId, commodityId, 'buy_price', null, p.buy, operator);
        logHistory.run(serverId, cityId, commodityId, 'sell_price', null, p.sell, operator);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (isUniqueConstraintError(err)) return fail(res, 409, '导入数据存在重复记录', 40901);
    throw err;
  }

  return ok(res, { total: parsed.length, created, updated, newDictCount });
}));

module.exports = router;
