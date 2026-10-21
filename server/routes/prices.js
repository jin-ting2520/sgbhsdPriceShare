'use strict';

/** 价格：查询 / 保存（乐观锁）/ 历史 / 趋势 / 比价 / 导出 / 导入（实时广播） */

const express = require('express');
const {
  query, get, tx, upsertServer, findServerId, findDictId,
  getCityTax, getCityTaxMap, getActiveCityEvents, getActiveCommodityEvents,
  setCurrentServer, nowText,
} = require('../db');
const cache = require('../cache');
const { broadcast } = require('../ws');
const { masterMeta, notifyMasterPriceChange } = require('../master');
const { requireAccount } = require('../auth');
const { clampRelief, displayBuy, displaySell, rawBuy, rawSell } = require('../tax');
const { enrichMonopolyEvent, monopolyCorrection } = require('../game/news');
const { ok, fail, asyncHandler, cleanName, isBlank, parsePrice } = require('../util');

const router = express.Router();

router.use(requireAccount);

const MAX_ITEMS = 500;

/** 减免：请求未指定时用账号保存的默认减免 */
const reliefOf = (obj, key, fallback) => {
  const raw = obj && obj[key];
  if (raw == null || raw === '') return clampRelief(fallback);
  return clampRelief(raw);
};

/** 区服：请求未指定时用账号当前区服（同步/保存时更新） */
const serverOf = (req, raw) => cleanName(raw, 50) || cleanName(req.account.currentServer, 50);

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 操作人 = 账号名称（可通过 body.operator 覆盖） */
const operatorOf = (req, body) => {
  const name = cleanName(body && body.operator, 20);
  return name || cleanName(req.account.name, 20) || '匿名';
};

const fallbackIdOf = meta => (meta.viewMasterPrices && meta.master ? Number(meta.master.id) : null);

async function readTax(accountId, masterId, serverId, cityId) {
  const own = await getCityTax(accountId, serverId, cityId);
  if (own != null || !masterId) return own;
  return getCityTax(masterId, serverId, cityId);
}

async function readTaxMap(accountId, masterId, serverId) {
  const own = await getCityTaxMap(accountId, serverId);
  if (!masterId) return own;
  const shared = await getCityTaxMap(masterId, serverId);
  for (const [cityId, tax] of shared) {
    if (!own.has(cityId)) own.set(cityId, tax);
  }
  return own;
}

async function readEventCorrections(serverId, cityId) {
  const events = await getActiveCityEvents(serverId, cityId);
  const groups = new Map();
  for (const event of events) {
    const key = Number(event.commodityId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const corrections = new Map();
  for (const [commodityId, list] of groups) corrections.set(commodityId, monopolyCorrection(list));
  return corrections;
}

/** GET /api/prices?server=&city=&commodity= —— 查询价格（商品列固定展示全部商品） */
router.get('/', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.query.server);
  const city = cleanName(req.query.city, 20);
  const commodity = cleanName(req.query.commodity, 20);

  if (isBlank(server)) return fail(res, 400, '请先输入区服');
  if (isBlank(city)) return fail(res, 400, '请先选择城池');

  const commoditySql = commodity ? 'AND name = ?' : '';
  const commodities = await query(
    `SELECT id, name, burden, sort_order FROM dict_items
      WHERE type = 'commodity' AND status = 1 ${commoditySql}
      ORDER BY sort_order, id`,
    commodity ? [commodity] : []
  );

  if (commodity && commodities.length === 0) {
    return fail(res, 400, `商品「${commodity}」不存在，请联系管理员维护商品字典`);
  }

  const accountId = req.account.id;
  const meta = await masterMeta(req.account, server);
  const fallbackId = fallbackIdOf(meta);
  const serverId = await findServerId(server);
  const cityId = await findDictId('city', city);
  const relief = reliefOf(req.query, 'relief', req.account.relief);
  const tax = await readTax(accountId, fallbackId, serverId, cityId);
  let priceMap = {};
  let sharedMap = {};
  if (serverId && cityId) {
    const rows = await query(
      `SELECT commodity_id AS commodityId, buy_price AS buy, sell_price AS sell,
              operator, updated_at AS updatedAt
         FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ?`,
      [accountId, serverId, cityId]
    );
    priceMap = Object.fromEntries(rows.map(r => [r.commodityId, r]));
    if (fallbackId) {
      const shared = await query(
        `SELECT commodity_id AS commodityId, buy_price AS buy, sell_price AS sell,
                operator, updated_at AS updatedAt
           FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ?`,
        [fallbackId, serverId, cityId]
      );
      sharedMap = Object.fromEntries(shared.map(r => [r.commodityId, r]));
    }
  }

  const events = (await getActiveCityEvents(serverId, cityId))
    .map(event => enrichMonopolyEvent(event, city, event.commodity));
  const eventsByCommodity = new Map();
  for (const event of events) {
    const key = Number(event.commodityId);
    if (!eventsByCommodity.has(key)) eventsByCommodity.set(key, []);
    eventsByCommodity.get(key).push(event);
  }

  let sharedCount = 0;
  const items = commodities.map(c => {
    const own = priceMap[c.id];
    const shared = !own && fallbackId ? sharedMap[c.id] : null;
    const p = own || shared;
    const source = own ? 'own' : (shared ? 'master' : null);
    if (source === 'master') sharedCount += 1;
    const correction = monopolyCorrection(eventsByCommodity.get(Number(c.id)));
    return {
      commodityId: c.id,
      commodity: c.name,
      burden: c.burden,
      buy: p ? displayBuy(p.buy, tax, relief, correction) : null,
      sell: p ? displaySell(p.sell, tax, relief, correction) : null,
      updatedAt: p ? p.updatedAt : null,
      operator: p ? p.operator : null,
      source,
      events: eventsByCommodity.get(Number(c.id)) || [],
    };
  });

  return ok(res, {
    server,
    city,
    tax,
    relief,
    masterAccountId: meta.masterAccountId,
    masterAccountName: meta.masterAccountName,
    isMaster: meta.isMaster,
    masterPricesAllowed: meta.masterPricesAllowed,
    viewMasterPrices: meta.viewMasterPrices,
    sharedCount,
    serverRegistered: !!serverId,
    cityRegistered: !!cityId,
    events,
    items,
  });
}));

/** POST /api/prices —— 保存价格（覆盖写，仅提交有改动的行；支持乐观并发校验） */
router.post('/', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.body.server);
  const city = cleanName(req.body.city, 20);
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  const force = req.body.force === true;

  if (isBlank(server)) return fail(res, 400, '请先输入区服');
  if (isBlank(city)) return fail(res, 400, '请先选择城池');
  if (!items || items.length === 0) return fail(res, 400, '没有需要保存的价格数据');
  if (items.length > MAX_ITEMS) return fail(res, 400, `单次最多保存 ${MAX_ITEMS} 条`);

  const unknown = [];
  for (const name of [...new Set(items.map(i => cleanName(i.commodity, 20)).filter(Boolean))]) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await findDictId('commodity', name))) unknown.push(name);
  }
  if (unknown.length) {
    return fail(res, 400, `商品 ${unknown.map(n => `「${n}」`).join('、')} 不在字典中，请联系管理员维护商品字典`);
  }

  const accountId = req.account.id;
  const meta = await masterMeta(req.account, server);
  const serverId = await upsertServer(server);
  const cityId = await findDictId('city', city);
  if (!cityId) return fail(res, 400, `城池「${city}」不在字典中，请先通过城池下拉框新增`);

  const operator = operatorOf(req, req.body);
  const relief = reliefOf(req.body, 'relief', req.account.relief);
  const tax = await readTax(accountId, fallbackIdOf(meta), serverId, cityId);
  const eventCorrections = await readEventCorrections(serverId, cityId);

  const ops = [];
  for (const raw of items) {
    const commodity = cleanName(raw && raw.commodity, 20);
    if (isBlank(commodity)) continue;
    const commodityId = await findDictId('commodity', commodity);
    if (!commodityId) continue;

    const buy = parsePrice(raw && raw.buy);
    const sell = parsePrice(raw && raw.sell);
    if (!buy.ok) return fail(res, 400, `「${commodity}」买价：${buy.error}`);
    if (!sell.ok) return fail(res, 400, `「${commodity}」卖价：${sell.error}`);

    ops.push({
      commodityId,
      commodity,
      buy: rawBuy(buy.value, tax, relief, eventCorrections.get(commodityId)),
      sell: rawSell(sell.value, tax, relief, eventCorrections.get(commodityId)),
      baseUpdatedAt: raw && raw.baseUpdatedAt != null ? String(raw.baseUpdatedAt) : null,
    });
  }

  const existingRows = await query(
    `SELECT commodity_id AS commodityId, buy_price AS buy, sell_price AS sell,
            operator, updated_at AS updatedAt
       FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ?`,
    [accountId, serverId, cityId]
  );
  const existingMap = new Map(existingRows.map(r => [Number(r.commodityId), r]));

  // 乐观并发：客户端带上了读取时的 updatedAt，但数据库已被他人改动 → 拒绝并回传最新值
  if (!force) {
    const conflicts = [];
    for (const op of ops) {
      if (!op.baseUpdatedAt) continue;
      const cur = existingMap.get(op.commodityId);
      if (cur && String(cur.updatedAt) !== op.baseUpdatedAt) {
        conflicts.push({
          commodity: op.commodity,
          baseUpdatedAt: op.baseUpdatedAt,
          updatedAt: cur.updatedAt,
          buy: displayBuy(cur.buy, tax, relief, eventCorrections.get(op.commodityId)),
          sell: displaySell(cur.sell, tax, relief, eventCorrections.get(op.commodityId)),
          operator: cur.operator,
        });
      }
    }
    if (conflicts.length) {
      return res.status(409).json({
        code: 40903,
        message: `「${conflicts.map(c => c.commodity).join('、')}」已被他人更新，请刷新后重试`,
        data: { conflicts },
      });
    }
  }

  const summary = { saved: 0, updated: 0, created: 0, cleared: 0 };
  const t = nowText();
  const changed = [];

  await tx(async conn => {
    for (const { commodityId, commodity, buy, sell } of ops) {
      const existing = existingMap.get(commodityId);

      if (buy == null && sell == null) {
        if (existing) {
          await conn.run('DELETE FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?', [accountId, serverId, cityId, commodityId]);
          if (existing.buy != null) await conn.run(
            'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [accountId, serverId, cityId, commodityId, 'buy_price', existing.buy, null, operator, t]
          );
          if (existing.sell != null) await conn.run(
            'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [accountId, serverId, cityId, commodityId, 'sell_price', existing.sell, null, operator, t]
          );
          summary.cleared += 1;
          changed.push({ commodityId, commodity, buy: null, sell: null, updatedAt: t, operator });
        }
        continue;
      }

      if (existing) {
        await conn.run(
          'UPDATE prices SET buy_price = ?, sell_price = ?, operator = ?, updated_at = ? WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
          [buy, sell, operator, t, accountId, serverId, cityId, commodityId]
        );
        summary.updated += 1;
        if (Number(existing.buy) !== buy) await conn.run(
          'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, 'buy_price', existing.buy, buy, operator, t]
        );
        if (Number(existing.sell) !== sell) await conn.run(
          'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, 'sell_price', existing.sell, sell, operator, t]
        );
      } else {
        await conn.run(
          'INSERT INTO prices (account_id, server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, buy, sell, operator, t]
        );
        summary.created += 1;
        await conn.run(
          'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, 'buy_price', null, buy, operator, t]
        );
        await conn.run(
          'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, 'sell_price', null, sell, operator, t]
        );
      }
      summary.saved += 1;
      changed.push({ commodityId, commodity, buy, sell, updatedAt: t, operator });
    }
  });

  await setCurrentServer(accountId, server);
  if (changed.length) {
    await cache.invalidate('dict:');
    broadcast('price.updated', { server, city, operator, tax, items: changed }, { accountId });
    await notifyMasterPriceChange(accountId, { server, city, operator, tax, items: changed });
  }

  return ok(res, summary);
}));

/** GET /api/prices/history?server=&city=&limit= —— 最近变更流水 */
router.get('/history', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.query.server);
  const city = cleanName(req.query.city, 20);
  if (isBlank(server) || isBlank(city)) return ok(res, { total: 0, items: [] });

  const accountId = req.account.id;
  const meta = await masterMeta(req.account, server);
  const fallbackId = fallbackIdOf(meta);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const serverId = await findServerId(server);
  const cityId = await findDictId('city', city);
  if (!serverId || !cityId) return ok(res, { total: 0, items: [] });

  const relief = reliefOf(req.query, 'relief', req.account.relief);
  const tax = await readTax(accountId, fallbackId, serverId, cityId);
  const historySql = `SELECT h.id, h.field, h.old_value AS oldValue, h.new_value AS newValue,
            h.created_at AS createdAt, h.operator, s.name AS server, c.name AS city, d.name AS commodity
       FROM price_history h
       JOIN servers s    ON s.id = h.server_id
       JOIN dict_items c ON c.id = h.city_id
       JOIN dict_items d ON d.id = h.commodity_id
      WHERE h.account_id = ? AND h.server_id = ? AND h.city_id = ?
      ORDER BY h.id DESC LIMIT ?`;
  let source = null;
  let rows = await query(historySql, [accountId, serverId, cityId, limit]);
  if (rows.length) {
    source = 'own';
  } else if (fallbackId) {
    const ownPrice = await get(
      'SELECT 1 AS hit FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? LIMIT 1',
      [accountId, serverId, cityId]
    );
    if (!ownPrice) {
      rows = await query(historySql, [fallbackId, serverId, cityId, limit]);
      if (rows.length) source = 'master';
    }
  }

  const items = rows.map(r => {
    const adjust = r.field === 'buy_price' ? displayBuy : displaySell;
    return { ...r, oldValue: adjust(r.oldValue, tax, relief), newValue: adjust(r.newValue, tax, relief) };
  });

  return ok(res, {
    total: items.length,
    tax,
    relief,
    source,
    masterAccountName: meta.masterAccountName,
    items,
  });
}));

/** GET /api/prices/trend?server=&city=&commodity=&days= —— 价格趋势（逐次变更时点 + 前向填充） */
router.get('/trend', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.query.server);
  const city = cleanName(req.query.city, 20);
  const commodity = cleanName(req.query.commodity, 20);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

  if (isBlank(server) || isBlank(city) || isBlank(commodity)) {
    return fail(res, 400, '请提供区服、城池和商品');
  }

  const accountId = req.account.id;
  const meta = await masterMeta(req.account, server);
  const fallbackId = fallbackIdOf(meta);
  const serverId = await findServerId(server);
  const cityId = await findDictId('city', city);
  const commodityRow = await get("SELECT id, name, burden FROM dict_items WHERE type = 'commodity' AND name = ?", [commodity]);
  if (!commodityRow) return fail(res, 400, `商品「${commodity}」不存在`);

  const relief = reliefOf(req.query, 'relief', req.account.relief);
  const historySql = `SELECT h.field, h.new_value AS value, h.created_at AS createdAt
         FROM price_history h
        WHERE h.account_id = ? AND h.server_id = ? AND h.city_id = ? AND h.commodity_id = ? AND h.new_value IS NOT NULL
        ORDER BY h.id`;
  const currentSql = 'SELECT buy_price AS buy, sell_price AS sell FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?';

  let rows = [];
  let current = null;
  let source = null;
  if (serverId && cityId) {
    rows = await query(historySql, [accountId, serverId, cityId, commodityRow.id]);
    current = await get(currentSql, [accountId, serverId, cityId, commodityRow.id]);
    if (rows.length || current) {
      source = 'own';
    } else if (fallbackId) {
      rows = await query(historySql, [fallbackId, serverId, cityId, commodityRow.id]);
      current = await get(currentSql, [fallbackId, serverId, cityId, commodityRow.id]);
      if (rows.length || current) source = 'master';
    }
  }
  const tax = await readTax(accountId, fallbackId, serverId, cityId);
  rows = rows.map(r => ({
    ...r,
    value: r.field === 'buy_price' ? displayBuy(r.value, tax, relief) : displaySell(r.value, tax, relief),
  }));

  // 近 N 天（created_at 为北京时间 'YYYY-MM-DD HH:MM:SS'）
  const cutoff = new Date(Date.now() + 8 * 3600000 - days * 86400000).toISOString().slice(0, 10);
  let seedBuy = null;
  let seedSell = null;
  const byTime = new Map();
  for (const r of rows) {
    const t = String(r.createdAt);
    const key = r.field === 'sell_price' ? 'sell' : 'buy';
    if (t.slice(0, 10) < cutoff) {
      if (r.value != null) { if (key === 'buy') seedBuy = r.value; else seedSell = r.value; }
      continue;
    }
    if (!byTime.has(t)) byTime.set(t, {});
    byTime.get(t)[key] = r.value;
  }

  if (current) {
    current.buy = displayBuy(current.buy, tax, relief);
    current.sell = displaySell(current.sell, tax, relief);
  }
  if (current && (current.buy != null || current.sell != null)) {
    const t = nowText();
    const lastT = byTime.size ? [...byTime.keys()].pop() : null;
    if (lastT && lastT.slice(0, 10) === t.slice(0, 10)) {
      const slot = byTime.get(lastT);
      if (current.buy != null) slot.buy = current.buy;
      if (current.sell != null) slot.sell = current.sell;
    } else {
      byTime.set(t, { buy: current.buy, sell: current.sell });
    }
  }

  let lastBuy = seedBuy;
  let lastSell = seedSell;
  const points = [...byTime.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([t, v]) => {
      if (v.buy != null) lastBuy = v.buy;
      if (v.sell != null) lastSell = v.sell;
      return { date: t, buy: lastBuy, sell: lastSell };
    });

  const buys = points.map(p => p.buy).filter(v => v != null);
  const sells = points.map(p => p.sell).filter(v => v != null);
  const summary = {
    count: points.length,
    lastBuy: buys.length ? buys[buys.length - 1] : null,
    lastSell: sells.length ? sells[sells.length - 1] : null,
    minBuy: buys.length ? Math.min(...buys) : null,
    maxBuy: buys.length ? Math.max(...buys) : null,
    minSell: sells.length ? Math.min(...sells) : null,
    maxSell: sells.length ? Math.max(...sells) : null,
    firstBuy: buys.length ? buys[0] : null,
    buyChangePct: (buys.length > 1 && buys[0]) ? Math.round(((buys[buys.length - 1] - buys[0]) / buys[0]) * 10000) / 100 : null,
    sellChangePct: (sells.length > 1 && sells[0]) ? Math.round(((sells[sells.length - 1] - sells[0]) / sells[0]) * 10000) / 100 : null,
  };

  return ok(res, {
    server, city, commodity, burden: commodityRow.burden, days, tax, relief, source,
    masterAccountName: meta.masterAccountName, points, summary,
  });
}));

/** GET /api/prices/matrix?server=&commodity= —— 跨城池比价（同一商品在所有城池的价格） */
router.get('/matrix', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.query.server);
  const commodity = cleanName(req.query.commodity, 20);
  if (isBlank(server) || isBlank(commodity)) return fail(res, 400, '请提供区服和商品');

  const accountId = req.account.id;
  const meta = await masterMeta(req.account, server);
  const fallbackId = fallbackIdOf(meta);
  const serverId = await findServerId(server);
  const commodityRow = await get("SELECT id, name, burden FROM dict_items WHERE type = 'commodity' AND name = ?", [commodity]);
  if (!commodityRow) return fail(res, 400, `商品「${commodity}」不存在`);

  const relief = reliefOf(req.query, 'relief', req.account.relief);
  const taxMap = await readTaxMap(accountId, fallbackId, serverId);
  const events = (await getActiveCommodityEvents(serverId, commodityRow.id))
    .map(event => enrichMonopolyEvent(event, event.city, commodity));
  const eventsByCity = new Map();
  for (const event of events) {
    const key = Number(event.cityId);
    if (!eventsByCity.has(key)) eventsByCity.set(key, []);
    eventsByCity.get(key).push(event);
  }

  const rows = await query(
    `SELECT c.id AS cityId, c.name AS city, c.sort_order AS sortOrder,
            p.id AS priceId, p.buy_price AS buy, p.sell_price AS sell,
            p.operator, p.updated_at AS updatedAt
       FROM dict_items c
       LEFT JOIN prices p
              ON p.city_id = c.id AND p.commodity_id = ? AND p.server_id = ? AND p.account_id = ?
      WHERE c.type = 'city' AND c.status = 1
      ORDER BY (p.buy_price IS NULL), p.buy_price, c.sort_order, c.id`,
    [commodityRow.id, serverId || -1, accountId]
  );
  const sharedMap = new Map();
  if (fallbackId) {
    const sharedRows = await query(
      `SELECT city_id AS cityId, buy_price AS buy, sell_price AS sell, operator, updated_at AS updatedAt
         FROM prices WHERE account_id = ? AND server_id = ? AND commodity_id = ?`,
      [fallbackId, serverId || -1, commodityRow.id]
    );
    for (const row of sharedRows) sharedMap.set(Number(row.cityId), row);
  }

  let sharedCount = 0;
  const items = rows.map(r => {
    const own = r.priceId != null;
    const shared = !own ? sharedMap.get(Number(r.cityId)) : null;
    const p = own ? r : shared;
    const source = own ? 'own' : (shared ? 'master' : null);
    if (source === 'master') sharedCount += 1;
    const tax = taxMap.get(Number(r.cityId)) ?? null;
    const correction = monopolyCorrection(eventsByCity.get(Number(r.cityId)));
    return {
      cityId: r.cityId,
      city: r.city,
      sortOrder: r.sortOrder,
      tax,
      buy: p ? displayBuy(p.buy, tax, relief, correction) : null,
      sell: p ? displaySell(p.sell, tax, relief, correction) : null,
      updatedAt: p ? p.updatedAt : null,
      operator: p ? p.operator : null,
      source,
      events: eventsByCity.get(Number(r.cityId)) || [],
    };
  });
  items.sort((a, b) => {
    const an = a.buy == null;
    const bn = b.buy == null;
    if (an !== bn) return an ? 1 : -1;
    if (a.buy != null && a.buy !== b.buy) return a.buy - b.buy;
    return a.sortOrder - b.sortOrder || a.cityId - b.cityId;
  });

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

  return ok(res, {
    server, commodity, burden: commodityRow.burden, relief,
    masterAccountId: meta.masterAccountId,
    masterAccountName: meta.masterAccountName,
    isMaster: meta.isMaster,
    masterPricesAllowed: meta.masterPricesAllowed,
    viewMasterPrices: meta.viewMasterPrices,
    sharedCount,
    events,
    items,
    summary,
  });
}));

/** GET /api/prices/export?server=&city= —— CSV 导出（带 BOM，Excel 友好） */
router.get('/export', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.query.server);
  const city = cleanName(req.query.city, 20);
  if (isBlank(server) || isBlank(city)) return fail(res, 400, '请先选择区服和城池');

  const accountId = req.account.id;
  const meta = await masterMeta(req.account, server);
  const fallbackId = fallbackIdOf(meta);
  const serverId = await findServerId(server);
  const cityId = await findDictId('city', city);
  const relief = reliefOf(req.query, 'relief', req.account.relief);
  const tax = await readTax(accountId, fallbackId, serverId, cityId);
  const eventCorrections = await readEventCorrections(serverId, cityId);
  let rows = [];
  let sharedRows = [];
  if (serverId && cityId) {
    const selectSql = `SELECT d.id AS commodityId, d.name AS commodity, d.burden, p.buy_price AS buy, p.sell_price AS sell,
              p.operator, p.updated_at AS updatedAt
         FROM prices p JOIN dict_items d ON d.id = p.commodity_id
        WHERE p.account_id = ? AND p.server_id = ? AND p.city_id = ? ORDER BY d.sort_order, d.id`;
    rows = await query(selectSql, [accountId, serverId, cityId]);
    if (fallbackId) sharedRows = await query(selectSql, [fallbackId, serverId, cityId]);
    const adjust = row => ({
      ...row,
      buy: displayBuy(row.buy, tax, relief, eventCorrections.get(Number(row.commodityId))),
      sell: displaySell(row.sell, tax, relief, eventCorrections.get(Number(row.commodityId))),
    });
    rows = rows.map(adjust);
    sharedRows = sharedRows.map(adjust);
  }
  const all = await query(
    `SELECT name, burden FROM dict_items WHERE type = 'commodity' AND status = 1 ORDER BY sort_order, id`
  );
  const full = all.map(c => {
    const own = rows.find(r => r.commodity === c.name);
    const shared = !own ? sharedRows.find(r => r.commodity === c.name) : null;
    const hit = own || shared;
    return {
      commodity: c.name,
      burden: c.burden,
      buy: hit ? hit.buy : null,
      sell: hit ? hit.sell : null,
      updatedAt: hit ? hit.updatedAt : null,
      operator: hit ? hit.operator : null,
      source: own ? '本人' : (shared ? '主账号' : ''),
    };
  });

  const lines = ['区服,城池,商品,负重,买价,卖价,更新时间,更新人,来源'];
  for (const r of full) {
    lines.push([
      server, city, r.commodity, r.burden ?? '', r.buy ?? '', r.sell ?? '',
      r.updatedAt ?? '', r.operator ?? '', r.source,
    ].map(csvCell).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${server}-${city}-价格表.csv`)}`);
  return res.send(csv);
}));

/** POST /api/prices/import —— 批量导入（rows 结构化数组，或 text 粘贴文本兼容旧客户端）
 *  merge: true 时只覆盖非空字段（单侧数据导入用：null 价保留原值） */
router.post('/import', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.body.server);
  const city = cleanName(req.body.city, 20);
  const merge = req.body.merge === true;
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  const rowsIn = Array.isArray(req.body.rows) ? req.body.rows : null;

  if (isBlank(server)) return fail(res, 400, '请先输入区服');
  if (isBlank(city)) return fail(res, 400, '请先选择城池');
  if (!rowsIn && text.trim() === '') return fail(res, 400, '请提供要导入的数据');

  const accountId = req.account.id;
  const meta = await masterMeta(req.account, server);
  const serverId = await upsertServer(server);
  const cityId = await findDictId('city', city);
  if (!cityId) return fail(res, 400, `城池「${city}」不在字典中，请先通过城池下拉框新增`);
  const operator = operatorOf(req, req.body);
  const relief = reliefOf(req.body, 'relief', req.account.relief);
  const tax = await readTax(accountId, fallbackIdOf(meta), serverId, cityId);

  const errors = [];
  const parsed = [];

  if (rowsIn) {
    rowsIn.forEach((raw, idx) => {
      const commodity = cleanName(raw && raw.commodity, 20);
      if (isBlank(commodity)) return;
      const pb = parsePrice(raw.buy);
      const ps = parsePrice(raw.sell);
      if (!pb.ok || !ps.ok) {
        errors.push(`第 ${idx + 1} 行：「${commodity}」${!pb.ok ? '买价' : '卖价'}${(!pb.ok ? pb.error : ps.error).replace(/^价格/, '')}`);
        return;
      }
      if (pb.value == null && ps.value == null) return;
      parsed.push({ commodity, buy: pb.value, sell: ps.value, burden: raw.burden });
    });
  } else {
    text.split(/\r?\n/).forEach((line, idx) => {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) return;
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
  }

  if (errors.length) return fail(res, 400, `导入失败：${errors.slice(0, 3).join('；')}${errors.length > 3 ? ` 等（共 ${errors.length} 条错误）` : ''}`);

  const eventCorrections = await readEventCorrections(serverId, cityId);
  const unknown = [];
  const commodityIds = new Map();
  for (const name of [...new Set(parsed.map(p => p.commodity))]) {
    // eslint-disable-next-line no-await-in-loop
    const id = await findDictId('commodity', name);
    if (!id) unknown.push(name);
    else commodityIds.set(name, id);
  }
  if (unknown.length) {
    return fail(res, 400, `商品 ${unknown.map(n => `「${n}」`).join('、')} 不在字典中，请联系管理员维护商品字典`);
  }

  // 导入的是用户看到的税后价，按当前用户减免、该城税率与大事件修正反推税前原价
  for (const p of parsed) {
    const correction = eventCorrections.get(commodityIds.get(p.commodity));
    p.buy = rawBuy(p.buy, tax, relief, correction);
    p.sell = rawSell(p.sell, tax, relief, correction);
  }

  const existingRows = await query(
    `SELECT commodity_id AS commodityId, buy_price AS buy, sell_price AS sell, updated_at AS updatedAt
       FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ?`,
    [accountId, serverId, cityId]
  );
  const existingMap = new Map(existingRows.map(r => [Number(r.commodityId), r]));

  let created = 0;
  let updated = 0;
  const t = nowText();

  await tx(async conn => {
    for (const p of parsed) {
      const row = await conn.get("SELECT id FROM dict_items WHERE type = 'commodity' AND name = ?", [p.commodity]);
      if (!row) continue;
      const commodityId = row.id;
      const existing = existingMap.get(Number(commodityId));
      const newBuy = merge && p.buy == null ? (existing ? existing.buy : null) : p.buy;
      const newSell = merge && p.sell == null ? (existing ? existing.sell : null) : p.sell;

      if (existing) {
        await conn.run(
          'UPDATE prices SET buy_price = ?, sell_price = ?, operator = ?, updated_at = ? WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
          [newBuy, newSell, operator, t, accountId, serverId, cityId, commodityId]
        );
        updated += 1;
        if (Number(existing.buy) !== newBuy) await conn.run(
          'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, 'buy_price', existing.buy, newBuy, operator, t]
        );
        if (Number(existing.sell) !== newSell) await conn.run(
          'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, 'sell_price', existing.sell, newSell, operator, t]
        );
      } else {
        await conn.run(
          'INSERT INTO prices (account_id, server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, newBuy, newSell, operator, t]
        );
        created += 1;
        await conn.run(
          'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, 'buy_price', null, newBuy, operator, t]
        );
        await conn.run(
          'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, 'sell_price', null, newSell, operator, t]
        );
      }
    }
  });

  await setCurrentServer(accountId, server);
  if (created || updated) {
    await cache.invalidate('dict:');
    broadcast('price.updated', { server, city, operator, tax, items: [] }, { accountId });
    await notifyMasterPriceChange(accountId, { server, city, operator, tax, items: [] });
  }

  return ok(res, { total: parsed.length, created, updated });
}));

module.exports = router;
