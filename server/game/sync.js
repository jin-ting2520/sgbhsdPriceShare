'use strict';

/**
 * 富甲天下价格同步：JWT → 登录 → WS → 逐城查询州府商品 → 写入价格库
 * 价格单位：游戏内 psCapitalProduct.price 为「分」，展示价为 /100（游戏 getPriceStr 逻辑）
 * 体力：otherPrices[].energy 为从当前城池出发到目标城池的体力消耗，顺带采集进 route_energy
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const {
  query, get, tx, upsertServer, findDictId, createDictItem, nowText, COMMODITY_LIST,
} = require('../db');
const { login } = require('./login');
const { GameClient } = require('./client');
const { isUniqueConstraintError } = require('../util');

const CITY_MAP = JSON.parse(fs.readFileSync(nodePath.join(__dirname, 'data', 'city_map.json'), 'utf8'));

const CITY_QUERY_TIMEOUT_MS = 8000;
const CITIES_PER_SYNC_LIMIT = 100;
const QUERY_CONCURRENCY = 4;

const NODE_TO_CITY = new Map(CITY_MAP.filter(c => c.nodeNo != null).map(c => [Number(c.nodeNo), c.name]));

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

/** 游戏内城池名 → 字典 id（缺失时自动登记，游戏数据可信） */
async function ensureCityId(name) {
  let id = await findDictId('city', name);
  if (id) return id;
  try {
    await createDictItem('city', name);
  } catch { /* 并发冲突忽略 */ }
  return findDictId('city', name);
}

/** 2104 响应 → { 商品名: {buy, sell} } */
function parseProducts(products) {
  const out = new Map();
  for (const p of products || []) {
    const name = productName(Number(p.id));
    if (!name) continue;
    const price = gamePrice(p.price);
    if (price == null) continue;
    const row = out.get(name) || { buy: null, sell: null };
    if (Number(p.type) === 2) row.sell = price;
    else row.buy = price;
    out.set(name, row);
  }
  return out;
}

/** 2104 响应中采集「当前城池 → 目标城池」的体力消耗（游戏实测样本） */
function harvestEnergy(city, res, sink) {
  const base = 100000000000n;
  for (const p of res.products || []) {
    for (const op of p.otherPrices || []) {
      const toNode = Number(BigInt(op.capitalNodeId) % base);
      const toCity = NODE_TO_CITY.get(toNode);
      const energy = Number(op.energy);
      if (!toCity || toCity === city.name) continue;
      if (!Number.isFinite(energy) || energy <= 0 || energy > 99) continue;
      const key = `${city.name}|${toCity}`;
      const prev = sink.get(key);
      if (prev == null || energy < prev) sink.set(key, energy);
    }
  }
}

/**
 * 同步指定区服的全部城池价格
 * @param {object} opts
 * @param {string} opts.token    x-game-token-pcweb（登录态 JWT）
 * @param {string} opts.server   区服名称（价格表所用名称）
 * @param {string} [opts.operator] 更新人（默认「游戏同步」）
 * @param {string[]} [opts.cities] 仅同步指定城池（默认全部）
 */
async function syncPrices(opts) {
  const token = String(opts.token || '').trim();
  const serverName = String(opts.server || '').trim();
  const operator = String(opts.operator || '').trim() || '游戏同步';
  const onlyCities = Array.isArray(opts.cities) && opts.cities.length
    ? new Set(opts.cities.map(s => String(s).trim()))
    : null;

  if (!token) throw Object.assign(new Error('请提供登录 token'), { status: 400 });
  if (!serverName) throw Object.assign(new Error('请提供区服名称'), { status: 400 });

  const cities = CITY_MAP.filter(c => !onlyCities || onlyCities.has(c.name));
  if (!cities.length) throw Object.assign(new Error('没有匹配的城池'), { status: 400 });
  if (cities.length > CITIES_PER_SYNC_LIMIT) {
    throw Object.assign(new Error(`单次最多同步 ${CITIES_PER_SYNC_LIMIT} 个城池`), { status: 400 });
  }

  const { login: info, alipayUserId } = await login(token);
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
    energyPairs: 0,
    failed: [],
    syncedAt: nowText(),
  };

  const t = nowText();
  const base = BigInt(info.serverId) * 100000000000n;
  const energySink = new Map();

  try {
    await client.open();
    await client.login(info, alipayUserId);

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
      harvestEnergy(city, item.res, energySink);

      const rows = parseProducts(item.res.products);
      if (!rows.size) {
        result.failed.push({ city: city.name, error: '该城池没有商品数据' });
        continue;
      }

      const cityId = await ensureCityId(city.name);
      if (!cityId) {
        result.failed.push({ city: city.name, error: '城池不在字典中' });
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
              'SELECT buy_price AS buy, sell_price AS sell FROM prices WHERE server_id = ? AND city_id = ? AND commodity_id = ?',
              [serverId, cityId, commodityId]
            );
            // 游戏数据可信：出现的一侧覆盖，缺失的一侧保留原值
            const newBuy = buy != null ? buy : (existing ? existing.buy : null);
            const newSell = sell != null ? sell : (existing ? existing.sell : null);
            if (newBuy == null && newSell == null) continue;

            if (existing) {
              await conn.run(
                'UPDATE prices SET buy_price = ?, sell_price = ?, operator = ?, updated_at = ? WHERE server_id = ? AND city_id = ? AND commodity_id = ?',
                [newBuy, newSell, operator, t, serverId, cityId, commodityId]
              );
              result.updated += 1;
              if (Number(existing.buy) !== newBuy) await conn.run(
                'INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [serverId, cityId, commodityId, 'buy_price', existing.buy, newBuy, operator, t]
              );
              if (Number(existing.sell) !== newSell) await conn.run(
                'INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [serverId, cityId, commodityId, 'sell_price', existing.sell, newSell, operator, t]
              );
            } else {
              await conn.run(
                'INSERT INTO prices (server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [serverId, cityId, commodityId, newBuy, newSell, operator, t]
              );
              result.created += 1;
              await conn.run(
                'INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [serverId, cityId, commodityId, 'buy_price', null, newBuy, operator, t]
              );
              await conn.run(
                'INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [serverId, cityId, commodityId, 'sell_price', null, newSell, operator, t]
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
  } finally {
    client.close();
  }

  if (energySink.size) {
    try {
      await tx(async conn => {
        for (const [key, energy] of energySink) {
          const [from, to] = key.split('|');
          const existing = await conn.get(
            'SELECT energy FROM route_energy WHERE from_city = ? AND to_city = ?',
            [from, to]
          );
          if (existing) {
            await conn.run(
              'UPDATE route_energy SET energy = ?, source = ?, updated_at = ? WHERE from_city = ? AND to_city = ?',
              [energy, 'game', t, from, to]
            );
          } else {
            await conn.run(
              'INSERT INTO route_energy (from_city, to_city, energy, source, updated_at) VALUES (?, ?, ?, ?, ?)',
              [from, to, energy, 'game', t]
            );
          }
          result.energyPairs += 1;
        }
      });
    } catch (err) {
      result.failed.push({ city: '(体力数据)', error: err.message });
    }
  }

  return result;
}

module.exports = { syncPrices, parseProducts, productName, gamePrice, harvestEnergy, CITY_MAP, NODE_TO_CITY };
