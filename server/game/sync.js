'use strict';

/**
 * 富甲天下价格同步：JWT → 登录 → WS → 逐城查询州府商品 → 写入价格库
 * 价格单位：游戏内 psCapitalProduct.price 为「分」，落库为税前原价（÷100，2 位小数）
 * 赋税：2104 返回城池赋税 tax（0.1~0.9），写入 city_taxes；展示价按用户「赋税减免」实时换算（见 server/tax.js）
 * 左右两侧：每城仅 3 个商品可买入（type=2），全部 25 个商品均可卖出（type=0/1）
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const {
  query, get, tx, upsertServer, findDictId, createDictItem, setCityTax, nowText, formatTime,
  COMMODITY_LIST, saveCityEvents,
} = require('../db');
const { login } = require('./login');
const { GameClient } = require('./client');
const { isUniqueConstraintError } = require('../util');

let CITY_MAP;
try {
  CITY_MAP = JSON.parse(fs.readFileSync(nodePath.join(__dirname, 'data', 'city_map.json'), 'utf8'));
} catch (err) {
  throw new Error(`缺少 server/game/data/city_map.json（需随仓库提交，Docker 构建依赖它）: ${err.message}`);
}

const CITY_QUERY_TIMEOUT_MS = 4000;
const CITIES_PER_SYNC_LIMIT = 300;
const QUERY_CONCURRENCY = 4;
const CITY_BY_NODE = new Map(CITY_MAP.map(c => [c.nodeNo, c]));
const CITY_BY_META = new Map(CITY_MAP.map(c => [c.metaId, c]));

/** 商品配置 id（1-25 及 201-225 复刻）→ 商品名 */
function productName(id) {
  const idx = id > 200 ? id - 201 : id - 1;
  return COMMODITY_LIST[idx] || null;
}

/** 游戏价格分 → 展示价（保留 2 位小数） */
function gamePrice(v) {
  if (v == null) return null;
  const n = Number(v) / 100;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function newsTimeMs(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 100000000000 ? Math.round(n * 1000) : Math.round(n);
}

function newsCity(capitalId, base) {
  let raw;
  try { raw = BigInt(capitalId); } catch { return null; }
  if (raw <= 0n) return null;
  const candidates = [];
  if (raw > base) candidates.push(raw - base);
  if (raw <= 1000000n) candidates.push(raw);
  if (raw > 1100000n) candidates.push(raw - 1100000n);
  for (const node of candidates) {
    if (node <= 0n || node > 1000000n) continue;
    const city = CITY_BY_NODE.get(Number(node));
    if (city) return city;
  }
  return CITY_BY_META.get(Number(raw)) || null;
}

function parseCityNews(list, serverBase, nowMs = Date.now()) {
  let base;
  try { base = typeof serverBase === 'bigint' ? serverBase : BigInt(serverBase); } catch { return []; }
  const out = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw) continue;
    const city = newsCity(raw.capitalId, base);
    if (!city) continue;
    const commodity = productName(Number(raw.productId));
    if (!commodity) continue;
    const startMs = newsTimeMs(raw.startTime);
    const endMs = newsTimeMs(raw.endTime);
    if (endMs && endMs <= nowMs) continue;
    if (startMs && endMs && endMs <= startMs) continue;
    const metaId = (String(raw.metaId || '').trim()
      || `news:${raw.capitalId}:${raw.startTime}:${raw.endTime}`).slice(0, 128);
    const event = {
      city: city.name,
      commodity,
      metaId,
      startsAt: startMs ? formatTime(startMs) : formatTime(nowMs),
      endsAt: endMs ? formatTime(endMs) : null,
    };
    out.set(`${city.nodeNo}|${commodity}|${metaId}`, event);
  }
  return [...out.values()];
}

/** 并发限制的 map */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 游戏内城池名 → { id, created }（缺失时自动登记，游戏数据可信） */
async function ensureCityId(name) {
  const existing = await findDictId('city', name);
  if (existing) return { id: existing, created: false };
  try {
    await createDictItem('city', name);
  } catch { /* 并发冲突忽略 */ }
  const id = await findDictId('city', name);
  return { id, created: !!id };
}

/** 2104 响应 → { 商品名: {buy, sell} }（税前原价，元） */
function parseProducts(products) {
  const out = new Map();
  for (const p of products || []) {
    const name = productName(Number(p.id));
    if (!name) continue;
    const raw = gamePrice(p.price);
    if (raw == null) continue;
    const row = out.get(name) || { buy: null, sell: null };
    if (Number(p.type) === 2) row.buy = raw;
    else row.sell = raw;
    out.set(name, row);
  }
  return out;
}

/** 登录态所属区服：优先角色所在区服，回退角色区服列表，最后回退赛季服 */
function serverOfLogin(info) {
  const candidates = [
    info && info.oServerId,
    ...(info && Array.isArray(info.existRoleServerIds) ? info.existRoleServerIds : []),
    info && info.serverId,
  ];
  for (const v of candidates) {
    const name = v == null ? '' : String(v).trim();
    if (name) return name;
  }
  return '';
}

/** 探测 token 所属区服（仅展示用，不写库） */
async function inspectToken(token) {
  const raw = String(token || '').trim();
  if (!raw) throw Object.assign(new Error('请提供登录 token'), { status: 400 });
  const { login: info } = await login(raw);
  const server = serverOfLogin(info);
  if (!server) throw Object.assign(new Error('登录信息中缺少区服'), { status: 502 });
  return {
    server,
    roleId: info.roleId,
    serverId: info.serverId,
    season: info.season,
  };
}

/**
 * 同步登录 token 所属区服的全部城池价格（区服由登录信息自动识别）
 * @param {object} opts
 * @param {string} opts.token    x-game-token-pcweb（登录态 JWT）
 * @param {string} [opts.operator] 更新人（默认「游戏同步」）
 * @param {string[]} [opts.cities] 仅同步指定城池（默认全部）
 * @param {string} [opts.server] 区服覆盖（仅管理员授权账号可用）
 */
async function syncPrices(opts) {
  const accountId = Number(opts.accountId);
  const token = String(opts.token || '').trim();
  const operator = String(opts.operator || '').trim() || '游戏同步';
  const serverOverride = String(opts.server || '').trim().slice(0, 50);
  const onlyCities = Array.isArray(opts.cities) && opts.cities.length
    ? new Set(opts.cities.map(s => String(s).trim()))
    : null;

  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw Object.assign(new Error('同步必须指定账号'), { status: 400 });
  }
  if (!token) throw Object.assign(new Error('请提供登录 token'), { status: 400 });

  if (onlyCities) {
    const unknown = [...onlyCities].filter(name => !CITY_MAP.some(c => c.name === name));
    if (unknown.length) {
      throw Object.assign(new Error(`同步映射中没有这些城池：${unknown.join('、')}`), { status: 400 });
    }
  }
  const cities = CITY_MAP.filter(c => !onlyCities || onlyCities.has(c.name));
  if (!cities.length) throw Object.assign(new Error('没有匹配的城池'), { status: 400 });
  if (cities.length > CITIES_PER_SYNC_LIMIT) {
    throw Object.assign(new Error(`单次最多同步 ${CITIES_PER_SYNC_LIMIT} 个城池`), { status: 400 });
  }

  const { login: info, alipayUserId } = await login(token);
  const serverName = serverOverride || serverOfLogin(info);
  if (!serverName) throw Object.assign(new Error('登录信息中缺少区服'), { status: 502 });
  const serverId = await upsertServer(serverName);

  const client = new GameClient(
    { serverHost: info.serverHost, serverPort: info.serverPort, serverId: info.serverId },
    { timeoutMs: 15000 }
  );

  const result = {
    server: serverName,
    account: { userId: info.userId, roleId: info.roleId, serverId: info.serverId, season: info.season },
    cities: cities.length,
    queried: 0,
    saved: 0,
    created: 0,
    updated: 0,
    events: 0,
    newCities: [],
    failed: [],
    syncedAt: nowText(),
  };

  const t = nowText();
  const base = BigInt(info.serverId) * 100000000000n;

  try {
    await client.open();
    await client.login(info, alipayUserId);
    await client.waitForNews(1500);

    const queried = await mapLimit(cities, QUERY_CONCURRENCY, async city => {
      const capId = base + BigInt(city.nodeNo);
      try {
        const res = await client.queryCapitalProducts(capId, 1, CITY_QUERY_TIMEOUT_MS);
        client.unsubscribeCapitalProducts(capId);
        return { city, res };
      } catch (err) {
        return { city, error: err.message };
      }
    });

    for (const item of queried) {
      const { city } = item;
      if (item.error) {
        result.failed.push({ city: city.name, error: item.error });
        continue;
      }
      result.queried += 1;

      const rows = parseProducts(item.res.products);

      const { id: cityId, created: cityCreated } = await ensureCityId(city.name);
      if (!cityId) {
        result.failed.push({ city: city.name, error: '城池不在字典中' });
        continue;
      }
      if (cityCreated) result.newCities.push(city.name);

      await setCityTax(accountId, serverId, cityId, item.res.tax);

      if (!rows.size) {
        result.failed.push({ city: city.name, error: '该城池没有商品数据' });
        continue;
      }

      const ops = [];
      for (const [name, prices] of rows) {
        const commodityId = await findDictId('commodity', name);
        if (!commodityId) continue;
        ops.push({ commodityId, buy: prices.buy, sell: prices.sell });
      }

      try {
        await tx(async conn => {
          for (const { commodityId, buy, sell } of ops) {
            const existing = await conn.get(
              'SELECT buy_price AS buy, sell_price AS sell FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
              [accountId, serverId, cityId, commodityId]
            );
            // 游戏数据可信：只写游戏返回的一侧，另一侧归零（如非可购商品的买入价）
            if (!existing && buy == null && sell == null) continue;

            if (existing) {
              const oldBuy = existing.buy == null ? null : Number(existing.buy);
              const oldSell = existing.sell == null ? null : Number(existing.sell);
              await conn.run(
                'UPDATE prices SET buy_price = ?, sell_price = ?, operator = ?, updated_at = ? WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
                [buy, sell, operator, t, accountId, serverId, cityId, commodityId]
              );
              result.updated += 1;
              if (oldBuy !== buy) await conn.run(
                'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [accountId, serverId, cityId, commodityId, 'buy_price', oldBuy, buy, operator, t]
              );
              if (oldSell !== sell) await conn.run(
                'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [accountId, serverId, cityId, commodityId, 'sell_price', oldSell, sell, operator, t]
              );
            } else {
              await conn.run(
                'INSERT INTO prices (account_id, server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [accountId, serverId, cityId, commodityId, buy, sell, operator, t]
              );
              result.created += 1;
              if (buy != null) await conn.run(
                'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [accountId, serverId, cityId, commodityId, 'buy_price', null, buy, operator, t]
              );
              if (sell != null) await conn.run(
                'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [accountId, serverId, cityId, commodityId, 'sell_price', null, sell, operator, t]
              );
            }
            result.saved += 1;
          }
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          result.failed.push({ city: city.name, error: '价格记录冲突' });
        } else {
          throw err;
        }
      }
    }

    const eventRows = [];
    for (const event of parseCityNews(client.getNews(), base)) {
      const { id: cityId } = await ensureCityId(event.city);
      const commodityId = await findDictId('commodity', event.commodity);
      if (!cityId || !commodityId) continue;
      eventRows.push({
        cityId,
        commodityId,
        metaId: event.metaId,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
      });
    }
    result.events = await saveCityEvents(serverId, eventRows);
  } finally {
    client.close();
  }

  return result;
}

module.exports = {
  syncPrices, inspectToken, serverOfLogin,
  parseProducts, productName, gamePrice, ensureCityId, CITY_MAP,
  parseCityNews, newsTimeMs, newsCity,
};
