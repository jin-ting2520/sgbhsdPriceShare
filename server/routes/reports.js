'use strict';

/** 报表：涨跌幅榜 / 城池间套利建议（含体力消耗） / 更新热度 */

const express = require('express');
const { query, get, findServerId, nowText, MONOPOLY_DEFAULTS } = require('../db');
const { ok, fail, asyncHandler, cleanName, isBlank } = require('../util');

const router = express.Router();

const bjDate = offsetDays => {
  const ms = Date.now() + 8 * 3600000 + (offsetDays || 0) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
};

const round2 = v => Math.round(v * 100) / 100;

async function requireServer(res, name) {
  if (isBlank(name)) {
    fail(res, 400, '请先输入区服');
    return null;
  }
  const serverId = await findServerId(name);
  if (!serverId) {
    fail(res, 400, `区服「${name}」暂无数据，请先录入或同步价格`);
    return null;
  }
  return serverId;
}

/** GET /api/reports/movers?server=&days=7&limit=20 —— 涨跌幅榜（基于 price_history） */
router.get('/movers', asyncHandler(async (req, res) => {
  const server = cleanName(req.query.server, 50);
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const serverId = await requireServer(res, server);
  if (!serverId) return undefined;

  const cutoff = bjDate(-days);
  const rows = await query(
    `SELECT h.city_id AS cityId, h.commodity_id AS commodityId, h.field,
            h.new_value AS value, h.created_at AS createdAt,
            c.name AS city, d.name AS commodity, d.burden
       FROM price_history h
       JOIN dict_items c ON c.id = h.city_id
       JOIN dict_items d ON d.id = h.commodity_id
      WHERE h.server_id = ?
      ORDER BY h.id`,
    [serverId]
  );

  const current = await query(
    `SELECT city_id AS cityId, commodity_id AS commodityId, buy_price AS buy, sell_price AS sell, updated_at AS updatedAt
       FROM prices WHERE server_id = ?`,
    [serverId]
  );
  const currentMap = new Map(current.map(r => [`${r.cityId}|${r.commodityId}`, r]));

  // key: cityId|commodityId|field → { seed, start, end, samples, meta }
  const agg = new Map();
  for (const r of rows) {
    const key = `${r.cityId}|${r.commodityId}|${r.field}`;
    let a = agg.get(key);
    if (!a) {
      a = { seed: null, start: null, startAt: null, end: null, endAt: null, samples: 0, city: r.city, commodity: r.commodity, burden: r.burden, cityId: r.cityId, commodityId: r.commodityId, field: r.field };
      agg.set(key, a);
    }
    if (String(r.createdAt).slice(0, 10) < cutoff) {
      if (r.value != null) a.seed = Number(r.value);
      continue;
    }
    if (r.value == null) continue;
    if (a.start == null) { a.start = Number(r.value); a.startAt = r.createdAt; }
    a.end = Number(r.value);
    a.endAt = r.createdAt;
    a.samples += 1;
  }

  const items = [];
  for (const a of agg.values()) {
    const cur = currentMap.get(`${a.cityId}|${a.commodityId}`);
    // 当前库内价格优先作为终值（可能已被他人更新/同步覆盖）
    let end = a.end;
    let endAt = a.endAt;
    if (cur) {
      const v = a.field === 'buy_price' ? cur.buy : cur.sell;
      if (v != null) { end = Number(v); endAt = cur.updatedAt; }
    }
    const start = a.start != null ? a.start : a.seed;
    if (start == null || end == null || !start) continue;
    if (start === end && a.samples < 2) continue;
    const changePct = round2(((end - start) / start) * 100);
    items.push({
      city: a.city,
      commodity: a.commodity,
      burden: a.burden,
      field: a.field === 'buy_price' ? 'buy' : 'sell',
      start: round2(start),
      end: round2(end),
      change: round2(end - start),
      changePct,
      samples: a.samples,
      startAt: a.startAt,
      updatedAt: endAt,
    });
  }

  items.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return ok(res, {
    server, days, totalCandidates: items.length,
    items: items.slice(0, limit),
  });
}));

/** GET /api/reports/arbitrage?server=&load=&energyPrice=&energyPerTrip=&returnTrip= —— 城池间套利建议 */
router.get('/arbitrage', asyncHandler(async (req, res) => {
  const server = cleanName(req.query.server, 50);
  const serverId = await requireServer(res, server);
  if (!serverId) return undefined;

  const load = Math.min(Math.max(Number(req.query.load) || 200, 1), 100000);
  const energyPrice = Math.min(Math.max(Number(req.query.energyPrice) || 0, 0), 999999);
  const energyPerTrip = Math.min(Math.max(Number(req.query.energyPerTrip) || MONOPOLY_DEFAULTS.energyCost, 1), 99);
  const returnTrip = req.query.returnTrip !== '0' && req.query.returnTrip !== 'false';
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const onlyPositive = req.query.all !== '1';

  const rows = await query(
    `SELECT p.city_id AS cityId, c.name AS city, p.commodity_id AS commodityId, d.name AS commodity,
            d.burden, p.buy_price AS buy, p.sell_price AS sell, p.updated_at AS updatedAt
       FROM prices p
       JOIN dict_items c ON c.id = p.city_id AND c.status = 1
       JOIN dict_items d ON d.id = p.commodity_id AND d.status = 1
      WHERE p.server_id = ?`,
    [serverId]
  );

  const routeEnergy = await query('SELECT from_city AS fromCity, to_city AS toCity, energy FROM route_energy');
  const energyMap = new Map();
  for (const r of routeEnergy) {
    energyMap.set(`${r.fromCity}|${r.toCity}`, Number(r.energy));
  }
  const lookupEnergy = (a, b) => {
    const k1 = energyMap.get(`${a}|${b}`);
    const k2 = energyMap.get(`${b}|${a}`);
    if (k1 != null || k2 != null) {
      return { energy: Math.min(k1 ?? Infinity, k2 ?? Infinity), source: 'game' };
    }
    return { energy: energyPerTrip, source: 'default' };
  };

  const byCommodity = new Map();
  for (const r of rows) {
    let g = byCommodity.get(r.commodityId);
    if (!g) {
      g = { commodity: r.commodity, burden: r.burden == null ? null : Number(r.burden), buys: [], sells: [] };
      byCommodity.set(r.commodityId, g);
    }
    if (r.buy != null) g.buys.push({ city: r.city, price: Number(r.buy), updatedAt: r.updatedAt });
    if (r.sell != null) g.sells.push({ city: r.city, price: Number(r.sell), updatedAt: r.updatedAt });
  }

  const items = [];
  for (const [commodityId, g] of byCommodity) {
    if (!g.buys.length || !g.sells.length) continue;
    g.buys.sort((a, b) => a.price - b.price || a.city.localeCompare(b.city, 'zh'));
    g.sells.sort((a, b) => b.price - a.price || a.city.localeCompare(b.city, 'zh'));

    for (const buy of g.buys) {
      const sell = g.sells.find(s => s.city !== buy.city);
      if (!sell) continue;
      const unitProfit = round2(sell.price - buy.price);
      const burden = g.burden && g.burden > 0 ? g.burden : null;
      const units = burden ? Math.max(1, Math.floor(load / burden)) : 1;
      const gross = round2(unitProfit * units);
      const { energy, source } = lookupEnergy(buy.city, sell.city);
      const energyCost = round2(energy * energyPrice * (returnTrip ? 2 : 1));
      const net = round2(gross - energyCost);
      const dailyTrips = Math.max(1, Math.floor(MONOPOLY_DEFAULTS.energyLimit / energy));
      items.push({
        commodityId,
        commodity: g.commodity,
        burden,
        buyCity: buy.city,
        buyPrice: round2(buy.price),
        sellCity: sell.city,
        sellPrice: round2(sell.price),
        unitProfit,
        load,
        units,
        gross,
        energy,
        energySource: source,
        energyCost,
        net,
        dailyTrips,
        dailyNet: round2(net * dailyTrips),
        perBurden: burden ? round2(unitProfit / burden) : null,
        buyUpdatedAt: buy.updatedAt,
        sellUpdatedAt: sell.updatedAt,
      });
      break; // 每个商品只推荐「最低买入城 → 该城可卖的最高价城市」一条
    }
  }

  const filtered = onlyPositive ? items.filter(i => i.net > 0) : items;
  filtered.sort((a, b) => b.net - a.net || b.unitProfit - a.unitProfit);

  return ok(res, {
    server,
    params: { load, energyPrice, energyPerTrip, returnTrip, onlyPositive },
    energyInfo: {
      energyCost: MONOPOLY_DEFAULTS.energyCost,
      energyLimit: MONOPOLY_DEFAULTS.energyLimit,
      energyCDHours: MONOPOLY_DEFAULTS.energyCDHours,
      dailyMaxTrips: Math.max(1, Math.floor(MONOPOLY_DEFAULTS.energyLimit / energyPerTrip)),
    },
    totalCandidates: items.length,
    items: filtered.slice(0, limit),
  });
}));

/** GET /api/reports/heat?server=&days=30&bucket=day|hour —— 价格更新热度（改价次数 + 同步次数） */
router.get('/heat', asyncHandler(async (req, res) => {
  const server = cleanName(req.query.server, 50);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const bucket = req.query.bucket === 'hour' ? 'hour' : 'day';
  const serverId = await requireServer(res, server);
  if (!serverId) return undefined;

  const cutoff = bucket === 'hour'
    ? `${bjDate(-Math.min(days, 14))} 00:00:00`
    : `${bjDate(-days)} 00:00:00`;

  const rows = await query(
    `SELECT h.created_at AS createdAt, h.operator
       FROM price_history h
      WHERE h.server_id = ? AND h.created_at >= ?`,
    [serverId, cutoff]
  );
  const syncRows = await query(
    `SELECT started_at AS startedAt, status FROM sync_log
      WHERE server_name = ? AND started_at >= ?`,
    [server, cutoff]
  );

  const keyOf = t => (bucket === 'hour' ? `${String(t).slice(0, 13)}:00` : String(t).slice(0, 10));
  const map = new Map();
  const ensure = key => {
    if (!map.has(key)) map.set(key, { key, changes: 0, syncs: 0, users: new Set() });
    return map.get(key);
  };
  for (const r of rows) {
    const b = ensure(keyOf(r.createdAt));
    b.changes += 1;
    if (r.operator) b.users.add(r.operator);
  }
  for (const r of syncRows) {
    const b = ensure(keyOf(r.startedAt));
    b.syncs += 1;
  }

  // 补齐连续的时间桶，方便画图
  const buckets = [];
  const now = nowText();
  if (bucket === 'hour') {
    const startMs = Date.parse(`${cutoff.replace(' ', 'T')}+08:00`);
    for (let i = 0; i <= Math.min(days, 14) * 24; i++) {
      const ms = startMs + i * 3600000;
      const key = new Date(ms + 8 * 3600000).toISOString().slice(0, 13) + ':00';
      if (key > now.slice(0, 13)) break;
      const b = map.get(key) || { key, changes: 0, syncs: 0, users: new Set() };
      buckets.push({ key, label: key.slice(5, 13).replace('T', ' '), changes: b.changes, syncs: b.syncs, users: b.users.size });
    }
  } else {
    const end = bjDate(0);
    let d = bjDate(-days);
    while (d <= end) {
      const b = map.get(d) || { key: d, changes: 0, syncs: 0, users: new Set() };
      buckets.push({ key: d, label: d.slice(5), changes: b.changes, syncs: b.syncs, users: b.users.size });
      const next = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      d = next;
    }
  }

  return ok(res, {
    server, days, bucket,
    totalChanges: rows.length,
    totalSyncs: syncRows.length,
    buckets,
  });
}));

module.exports = router;
