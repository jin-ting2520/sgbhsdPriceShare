'use strict';

/** 报表：涨跌幅榜 / 更新热度 */

const express = require('express');
const { query, get, findServerId, getCityTaxMap, nowText } = require('../db');
const { requireAccount } = require('../auth');
const { clampRelief, displayBuy, displaySell } = require('../tax');
const { ok, fail, asyncHandler, cleanName, isBlank } = require('../util');

const router = express.Router();

router.use(requireAccount);

const bjDate = offsetDays => {
  const ms = Date.now() + 8 * 3600000 + (offsetDays || 0) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
};

const round2 = v => Math.round(v * 100) / 100;

const serverOf = (req, raw) => cleanName(raw, 50) || cleanName(req.account.currentServer, 50);

const reliefOf = (req, raw) => {
  if (raw == null || raw === '') return clampRelief(req.account.relief);
  return clampRelief(raw);
};

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

/** GET /api/reports/movers?server=&days=7&limit=20&relief=5 —— 涨跌幅榜（基于 price_history） */
router.get('/movers', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.query.server);
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const relief = reliefOf(req, req.query.relief);
  const serverId = await requireServer(res, server);
  if (!serverId) return undefined;
  const accountId = req.account.id;
  const taxMap = await getCityTaxMap(accountId, serverId);

  const cutoff = bjDate(-days);
  const rows = await query(
    `SELECT h.city_id AS cityId, h.commodity_id AS commodityId, h.field,
            h.new_value AS value, h.created_at AS createdAt,
            c.name AS city, d.name AS commodity, d.burden
       FROM price_history h
       JOIN dict_items c ON c.id = h.city_id
       JOIN dict_items d ON d.id = h.commodity_id
      WHERE h.account_id = ? AND h.server_id = ?
      ORDER BY h.id`,
    [accountId, serverId]
  );

  const current = await query(
    `SELECT city_id AS cityId, commodity_id AS commodityId, buy_price AS buy, sell_price AS sell, updated_at AS updatedAt
       FROM prices WHERE account_id = ? AND server_id = ?`,
    [accountId, serverId]
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
    const tax = taxMap.get(Number(a.cityId)) ?? null;
    const adjust = a.field === 'buy_price' ? displayBuy : displaySell;
    const startView = adjust(start, tax, relief);
    const endView = adjust(end, tax, relief);
    const changePct = round2(((end - start) / start) * 100);
    items.push({
      city: a.city,
      commodity: a.commodity,
      burden: a.burden,
      field: a.field === 'buy_price' ? 'buy' : 'sell',
      start: startView,
      end: endView,
      change: round2(endView - startView),
      changePct,
      samples: a.samples,
      startAt: a.startAt,
      updatedAt: endAt,
    });
  }

  items.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return ok(res, {
    server, days, relief, totalCandidates: items.length,
    items: items.slice(0, limit),
  });
}));

/** GET /api/reports/heat?server=&days=30&bucket=day|hour —— 价格更新热度（改价次数 + 同步次数） */
router.get('/heat', asyncHandler(async (req, res) => {
  const server = serverOf(req, req.query.server);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const bucket = req.query.bucket === 'hour' ? 'hour' : 'day';
  const serverId = await requireServer(res, server);
  if (!serverId) return undefined;

  const accountId = req.account.id;
  const cutoff = bucket === 'hour'
    ? `${bjDate(-Math.min(days, 14))} 00:00:00`
    : `${bjDate(-days)} 00:00:00`;

  const rows = await query(
    `SELECT h.created_at AS createdAt, h.operator
       FROM price_history h
      WHERE h.account_id = ? AND h.server_id = ? AND h.created_at >= ?`,
    [accountId, serverId, cutoff]
  );
  const syncRows = await query(
    `SELECT started_at AS startedAt, status FROM sync_log
      WHERE account_id = ? AND started_at >= ?`,
    [accountId, cutoff]
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
