'use strict';

/**
 * 价格落库（工具 SSO ingest 使用）：游戏数据可信，按「提交什么写什么」覆盖，
 * 未返回的一侧写 null（与 server/game/sync.js 的落库语义一致），并写 price_history 变更流水。
 *
 * 注意：server/game/sync.js 里有一份等价的同步内联实现（登录游戏直连用），
 * 这里抽出来供 /api/sso/game-ingest 复用，避免两条链路各写一半字段。
 */

const { tx } = require('../db');

/**
 * @param {object} opts
 * @param {number} opts.accountId 价格归属账号
 * @param {number} opts.serverId  区服 id
 * @param {number} opts.cityId    城池字典 id
 * @param {Array<{commodityId:number, buy:number|null, sell:number|null}>} opts.rows
 * @param {string} opts.operator  更新人
 * @param {string} opts.at        updated_at 文本（北京时间）
 * @returns {Promise<{saved:number, created:number, updated:number, cleared:number}>}
 */
async function saveCityProducts({ accountId, serverId, cityId, rows, operator, at }) {
  const summary = { saved: 0, created: 0, updated: 0, cleared: 0 };
  if (!Array.isArray(rows) || !rows.length) return summary;

  await tx(async conn => {
    for (const row of rows) {
      const commodityId = Number(row && row.commodityId);
      if (!Number.isInteger(commodityId) || commodityId <= 0) continue;
      const buy = row.buy == null ? null : Number(row.buy);
      const sell = row.sell == null ? null : Number(row.sell);
      if ((buy != null && !Number.isFinite(buy)) || (sell != null && !Number.isFinite(sell))) continue;

      const existing = await conn.get(
        'SELECT buy_price AS buy, sell_price AS sell FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
        [accountId, serverId, cityId, commodityId]
      );

      if (!existing && buy == null && sell == null) continue;

      if (existing) {
        const oldBuy = existing.buy == null ? null : Number(existing.buy);
        const oldSell = existing.sell == null ? null : Number(existing.sell);
        await conn.run(
          'UPDATE prices SET buy_price = ?, sell_price = ?, operator = ?, updated_at = ? WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
          [buy, sell, operator, at, accountId, serverId, cityId, commodityId]
        );
        summary.updated += 1;
        if (oldBuy !== buy) {
          await conn.run(
            'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [accountId, serverId, cityId, commodityId, 'buy_price', oldBuy, buy, operator, at]
          );
        }
        if (oldSell !== sell) {
          await conn.run(
            'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [accountId, serverId, cityId, commodityId, 'sell_price', oldSell, sell, operator, at]
          );
        }
      } else {
        await conn.run(
          'INSERT INTO prices (account_id, server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, serverId, cityId, commodityId, buy, sell, operator, at]
        );
        summary.created += 1;
        if (buy != null) {
          await conn.run(
            'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [accountId, serverId, cityId, commodityId, 'buy_price', null, buy, operator, at]
          );
        }
        if (sell != null) {
          await conn.run(
            'INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [accountId, serverId, cityId, commodityId, 'sell_price', null, sell, operator, at]
          );
        }
      }
      summary.saved += 1;
    }
  });

  return summary;
}

module.exports = { saveCityProducts };
