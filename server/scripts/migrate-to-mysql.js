'use strict';

/**
 * 存量 SQLite 数据迁移到 MySQL：
 *   node server/scripts/migrate-to-mysql.js [--source data/price.db] [--force]
 *
 * 需先配置 MySQL 连接（MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE），
 * 脚本会把源库的字典、区服、价格、历史流水、城市坐标与路线体力导入目标库。
 * 默认仅在目标库为空（无 prices 记录）时执行，--force 可强制合并导入。
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const force = args.includes('--force');
const srcIdx = args.indexOf('--source');
const srcFile = srcIdx >= 0 ? args[srcIdx + 1] : nodePath.join(__dirname, '..', '..', 'data', 'price.db');
const driver = (process.env.DB_DRIVER || (process.env.MYSQL_HOST ? 'mysql' : 'sqlite')).toLowerCase();

if (driver !== 'mysql') {
  console.error('目标库不是 MySQL（请设置 MYSQL_HOST 等环境变量），已中止。');
  process.exit(1);
}
if (!fs.existsSync(srcFile)) {
  console.error(`源 SQLite 数据库不存在：${srcFile}`);
  process.exit(1);
}

(async () => {
  const db = require('../db');
  await db.ready();

  const priceCount = Number((await db.get('SELECT COUNT(*) AS n FROM prices')).n);
  if (priceCount > 0 && !force) {
    console.error(`目标库已有 ${priceCount} 条价格记录，如需合并导入请加 --force`);
    process.exit(1);
  }

  const raw = new DatabaseSync(srcFile);
  const all = (sql, ...params) => {
    try { return raw.prepare(sql).all(...params); } catch { return []; }
  };

  const dictRows = all('SELECT type, name, sort_order, burden, status FROM dict_items');
  const serverRows = all('SELECT name FROM servers');
  const priceRows = all(`
    SELECT s.name AS server, c.name AS city, d.name AS commodity,
           p.buy_price AS buy, p.sell_price AS sell, p.operator, p.updated_at AS updatedAt
      FROM prices p
      JOIN servers s ON s.id = p.server_id
      JOIN dict_items c ON c.id = p.city_id
      JOIN dict_items d ON d.id = p.commodity_id`);
  const historyRows = all(`
    SELECT s.name AS server, c.name AS city, d.name AS commodity,
           h.field, h.old_value AS oldValue, h.new_value AS newValue, h.operator, h.created_at AS createdAt
      FROM price_history h
      JOIN servers s ON s.id = h.server_id
      JOIN dict_items c ON c.id = h.city_id
      JOIN dict_items d ON d.id = h.commodity_id
     ORDER BY h.id`);
  const cityRows = all(`SELECT city_name AS cityName, cfg_name AS cfgName, node_no AS nodeNo,
                               meta_id AS metaId, grid_x AS gridX, grid_y AS gridY FROM city_nodes`);
  const taxRows = all(`SELECT s.name AS server, c.name AS city, t.tax
                         FROM city_taxes t
                         JOIN servers s ON s.id = t.server_id
                         JOIN dict_items c ON c.id = t.city_id`);
  const accountRows = all(`SELECT name, password_hash AS passwordHash, token, session_token AS sessionToken,
                                  created_at AS createdAt, updated_at AS updatedAt FROM accounts`);
  const settingsRows = all(`SELECT s.enabled, s.cron_expr AS cron, s.token, s.server_name AS server, s.operator,
                                   s.last_run_at AS lastRunAt, s.last_status AS lastStatus, s.last_message AS lastMessage,
                                   a.name AS tokenAccountName
                              FROM sync_settings s
                              LEFT JOIN accounts a ON a.id = s.token_account_id
                             WHERE s.id = 1`);

  const t = db.nowText();
  let inserted = { dict: 0, servers: 0, prices: 0, history: 0, cityNodes: 0, cityTaxes: 0, accounts: 0, settings: 0 };

  for (const d of dictRows) {
    const row = await db.get('SELECT id FROM dict_items WHERE type = ? AND name = ?', [d.type, d.name]);
    if (row) continue;
    await db.run(
      'INSERT INTO dict_items (type, name, sort_order, burden, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d.type, d.name, d.sort_order, d.burden, d.status, t, t]
    );
    inserted.dict += 1;
  }
  for (const s of serverRows) {
    await db.upsertServer(s.name);
    inserted.servers += 1;
  }

  for (const p of priceRows) {
    const serverId = await db.upsertServer(p.server);
    const cityId = await db.findDictId('city', p.city);
    const commodityId = await db.findDictId('commodity', p.commodity);
    if (!cityId || !commodityId) continue;
    const existing = await db.get(
      'SELECT id FROM prices WHERE server_id = ? AND city_id = ? AND commodity_id = ?',
      [serverId, cityId, commodityId]
    );
    if (existing) continue;
    await db.run(
      'INSERT INTO prices (server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [serverId, cityId, commodityId, p.buy, p.sell, p.operator, p.updatedAt || t]
    );
    inserted.prices += 1;
  }

  for (const h of historyRows) {
    const serverId = await db.findServerId(h.server);
    const cityId = await db.findDictId('city', h.city);
    const commodityId = await db.findDictId('commodity', h.commodity);
    if (!serverId || !cityId || !commodityId) continue;
    await db.run(
      'INSERT INTO price_history (server_id, city_id, commodity_id, field, old_value, new_value, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [serverId, cityId, commodityId, h.field, h.oldValue, h.newValue, h.operator, h.createdAt || t]
    );
    inserted.history += 1;
  }

  for (const c of cityRows) {
    const existing = await db.get('SELECT city_name FROM city_nodes WHERE city_name = ?', [c.cityName]);
    if (existing) {
      if (c.gridX != null || c.gridY != null) {
        await db.run(
          'UPDATE city_nodes SET cfg_name = ?, node_no = ?, meta_id = ?, grid_x = ?, grid_y = ?, updated_at = ? WHERE city_name = ?',
          [c.cfgName, c.nodeNo, c.metaId, c.gridX, c.gridY, t, c.cityName]
        );
      }
      continue;
    }
    await db.run(
      `INSERT INTO city_nodes (city_name, cfg_name, node_no, meta_id, grid_x, grid_y, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.cityName, c.cfgName, c.nodeNo, c.metaId, c.gridX, c.gridY, t]
    );
    inserted.cityNodes += 1;
  }

  for (const ct of taxRows) {
    const serverId = await db.findServerId(ct.server);
    const cityId = await db.findDictId('city', ct.city);
    if (!serverId || !cityId) continue;
    await db.setCityTax(serverId, cityId, Number(ct.tax));
    inserted.cityTaxes += 1;
  }

  for (const a of accountRows) {
    const existing = await db.get('SELECT id FROM accounts WHERE name = ?', [a.name]);
    if (existing) continue;
    await db.run(
      `INSERT INTO accounts (name, password_hash, token, session_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [a.name, a.passwordHash, a.token || null, a.sessionToken || null, a.createdAt || t, a.updatedAt || t]
    );
    inserted.accounts += 1;
  }

  if (settingsRows.length) {
    const s = settingsRows[0];
    const tokenAccount = s.tokenAccountName
      ? await db.get('SELECT id FROM accounts WHERE name = ?', [s.tokenAccountName])
      : null;
    await db.run(
      `UPDATE sync_settings
          SET enabled = ?, cron_expr = ?, token = ?, token_account_id = ?, server_name = ?, operator = ?,
              last_run_at = ?, last_status = ?, last_message = ?
        WHERE id = 1`,
      [s.enabled ? 1 : 0, s.cron || '0 */2 * * *', s.token || null,
        tokenAccount ? tokenAccount.id : null, s.server || '',
        s.operator || '自动同步', s.lastRunAt || null, s.lastStatus || null, s.lastMessage || null]
    );
    inserted.settings = 1;
  }

  raw.close();
  console.log('迁移完成：', JSON.stringify({
    source: srcFile,
    target: `${process.env.MYSQL_HOST || '127.0.0.1'}/${process.env.MYSQL_DATABASE || 'price_share'}`,
    inserted,
  }, null, 2));
  await db.close();
})().catch(async err => {
  console.error('迁移失败:', err.message);
  process.exitCode = 1;
  try { require('../db').close(); } catch { /* ignore */ }
});
