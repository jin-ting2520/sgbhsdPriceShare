'use strict';

/** 价格：查询 / 保存 / 历史 / 导出 / 导入 */

const express = require('express');
const { db, upsertServer, findServerId, findDictId, createDictItem } = require('../db');
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

/** GET /api/prices?server=&city=&commodity= —— 查询价格（商品列固定展示全部商品） */
router.get('/', asyncHandler((req, res) => {
  const server = cleanName(req.query.server, 50);
  const city = cleanName(req.query.city, 20);
  const commodity = cleanName(req.query.commodity, 20);

  if (isBlank(server)) return fail(res, 400, '请先输入区服');
  if (isBlank(city)) return fail(res, 400, '请先选择城池');

  const commoditySql = commodity
    ? `AND name = ?`
    : '';
  const commodities = db.prepare(
    `SELECT id, name, sort_order FROM dict_items
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
      'SELECT commodity_id AS commodityId, buy_price AS buy, sell_price AS sell, updated_at AS updatedAt FROM prices WHERE server_id = ? AND city_id = ?'
    ).all(serverId, cityId);
    priceMap = Object.fromEntries(rows.map(r => [r.commodityId, r]));
  }

  const items = commodities.map(c => {
    const p = priceMap[c.id];
    return {
      commodityId: c.id,
      commodity: c.name,
      buy: p ? p.buy : null,
      sell: p ? p.sell : null,
      updatedAt: p ? p.updatedAt : null,
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

  const getExisting = db.prepare(
    'SELECT id, buy_price AS buy, sell_price AS sell FROM prices WHERE server_id = ? AND city_id = ? AND commodity_id = ?'
  );
  const upsert = db.prepare(
    `INSERT INTO prices (server_id, city_id, commodity_id, buy_price, sell_price, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(server_id, city_id, commodity_id)
     DO UPDATE SET buy_price = excluded.buy_price, sell_price = excluded.sell_price,
                   updated_at = datetime('now','localtime')`
  );
  const remove = db.prepare(
    'DELETE FROM prices WHERE server_id = ? AND city_id = ? AND commodity_id = ?'
  );
  const logHistory = db.prepare(
    `INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?)`
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
          if (existing.buy != null) logHistory.run(serverId, cityId, commodityId, 'buy_price', existing.buy, null);
          if (existing.sell != null) logHistory.run(serverId, cityId, commodityId, 'sell_price', existing.sell, null);
          summary.cleared += 1;
        }
        continue;
      }

      upsert.run(serverId, cityId, commodityId, buy.value, sell.value);
      if (existing) {
        summary.updated += 1;
        if (existing.buy !== buy.value) logHistory.run(serverId, cityId, commodityId, 'buy_price', existing.buy, buy.value);
        if (existing.sell !== sell.value) logHistory.run(serverId, cityId, commodityId, 'sell_price', existing.sell, sell.value);
      } else {
        summary.created += 1;
        logHistory.run(serverId, cityId, commodityId, 'buy_price', null, buy.value);
        logHistory.run(serverId, cityId, commodityId, 'sell_price', null, sell.value);
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
            s.name AS server, c.name AS city, d.name AS commodity
       FROM price_history h
       JOIN servers s    ON s.id = h.server_id
       JOIN dict_items c ON c.id = h.city_id
       JOIN dict_items d ON d.id = h.commodity_id
      WHERE h.server_id = ? AND h.city_id = ?
      ORDER BY h.id DESC LIMIT ?`
  ).all(serverId, cityId, limit);

  return ok(res, { total: rows.length, items: rows });
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
      `SELECT d.name AS commodity, p.buy_price AS buy, p.sell_price AS sell, p.updated_at AS updatedAt
         FROM prices p JOIN dict_items d ON d.id = p.commodity_id
        WHERE p.server_id = ? AND p.city_id = ? ORDER BY d.sort_order, d.id`
    ).all(serverId, cityId);
  }
  // 商品列固定展示全部商品：无价格的商品导出空值
  const existed = new Set(rows.map(r => r.commodity));
  const all = db.prepare(
    `SELECT name FROM dict_items WHERE type = 'commodity' AND status = 1 ORDER BY sort_order, id`
  ).all();
  const full = all.map(c => existed.has(c.name)
    ? rows.find(r => r.commodity === c.name)
    : { commodity: c.name, buy: '', sell: '', updatedAt: '' });

  const lines = ['区服,城池,商品,买价,卖价,更新时间'];
  for (const r of full) {
    lines.push([server, city, r.commodity, r.buy ?? '', r.sell ?? '', r.updatedAt ?? ''].map(csvCell).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${server}-${city}-价格表.csv`)}`);
  return res.send(csv);
}));

/** POST /api/prices/import —— 批量粘贴导入（商品\t买价\t卖价） */
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
    const [commodity, buy, sell] = [cleanName(cols[0], 20), cols[1], cols[2]];
    const pb = parsePrice(buy);
    const ps = parsePrice(sell);
    if (!pb.ok || !ps.ok) {
      errors.push(`第 ${idx + 1} 行：「${commodity}」${!pb.ok ? '买价' : '卖价'}${(!pb.ok ? pb.error : ps.error).replace(/^价格/, '')}`);
      return;
    }
    if (pb.value == null && ps.value == null) return;
    parsed.push({ commodity, buy: pb.value, sell: ps.value });
  });

  if (errors.length) return fail(res, 400, `导入失败：${errors.slice(0, 3).join('；')}${errors.length > 3 ? ' 等' : ''}`);

  const unknown = [...new Set(parsed.map(p => p.commodity))].filter(n => !findDictId('commodity', n));
  if (unknown.length && !createMissing) {
    return fail(res, 400, `商品 ${unknown.map(n => `「${n}」`).join('、')} 不在字典中`);
  }
  for (const name of unknown) {
    try { createDictItem('commodity', name); } catch (e) { /* 并发冲突忽略 */ }
  }

  const upsert = db.prepare(
    `INSERT INTO prices (server_id, city_id, commodity_id, buy_price, sell_price, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(server_id, city_id, commodity_id)
     DO UPDATE SET buy_price = excluded.buy_price, sell_price = excluded.sell_price,
                   updated_at = datetime('now','localtime')`
  );
  const getExisting = db.prepare(
    'SELECT buy_price AS buy, sell_price AS sell FROM prices WHERE server_id = ? AND city_id = ? AND commodity_id = ?'
  );
  const logHistory = db.prepare(
    `INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let created = 0;
  let updated = 0;
  let newDictCount = unknown.length;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of parsed) {
      const commodityId = findDictId('commodity', p.commodity);
      const existing = getExisting.get(serverId, cityId, commodityId);
      upsert.run(serverId, cityId, commodityId, p.buy, p.sell);
      if (existing) {
        updated += 1;
        if (existing.buy !== p.buy) logHistory.run(serverId, cityId, commodityId, 'buy_price', existing.buy, p.buy);
        if (existing.sell !== p.sell) logHistory.run(serverId, cityId, commodityId, 'sell_price', existing.sell, p.sell);
      } else {
        created += 1;
        logHistory.run(serverId, cityId, commodityId, 'buy_price', null, p.buy);
        logHistory.run(serverId, cityId, commodityId, 'sell_price', null, p.sell);
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
