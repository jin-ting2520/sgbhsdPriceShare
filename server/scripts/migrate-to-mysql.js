'use strict';

/**
 * 存量 SQLite 数据迁移到 MySQL（兼容旧版共享库与新卡密库）：
 *   node server/scripts/migrate-to-mysql.js [--source data/price.db] [--force]
 *
 * 需先配置 MySQL 连接（MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE）。
 * 旧库无 account_id 的价格/历史/税率会归入“历史归属账号”（旧 token 所属账号，否则最早注册账号）。
 * 会话（sessions）不迁移，升级后需重新登录以绑定设备。
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_KEY_HELP_MD, DEFAULT_TOKEN_HELP_MD } = require('../markdown');

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
  const colsOf = table => {
    try { return raw.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); } catch { return []; }
  };
  const all = (sql, ...params) => {
    try { return raw.prepare(sql).all(...params); } catch { return []; }
  };
  const hasTable = table => {
    try { return !!raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table); } catch { return false; }
  };
  const has = (table, col) => colsOf(table).includes(col);

  const accountCols = colsOf('accounts');
  const pick = (cols, expr, alias, fallback) => (cols.includes(expr) ? `${expr} AS ${alias}` : `${fallback} AS ${alias}`);

  const accountRows = accountCols.length ? all(`SELECT id, name, password_hash AS passwordHash,
      ${pick(accountCols, 'token', 'token', 'NULL')},
      ${pick(accountCols, 'relief', 'relief', '5')},
      ${pick(accountCols, 'status', 'status', "'active'")},
      ${pick(accountCols, 'expires_at', 'expiresAt', 'NULL')},
      ${pick(accountCols, 'key_code', 'keyCode', 'NULL')},
      ${pick(accountCols, 'device_limit', 'deviceLimit', '3')},
      ${pick(accountCols, 'current_server', 'currentServer', "''")},
      ${pick(accountCols, 'allow_sync_server', 'allowSyncServer', '0')},
      ${pick(accountCols, 'view_master_prices', 'viewMasterPrices', '0')},
      ${pick(accountCols, 'allow_master_prices', 'allowMasterPrices', '1')},
      ${pick(accountCols, 'sso_source', 'ssoSource', 'NULL')},
      ${pick(accountCols, 'sso_subject', 'ssoSubject', 'NULL')},
      ${pick(accountCols, 'created_at', 'createdAt', 'NULL')},
      ${pick(accountCols, 'updated_at', 'updatedAt', 'NULL')}
    FROM accounts ORDER BY id`) : [];

  const t = db.nowText();
  const inserted = { dict: 0, servers: 0, accounts: 0, serverMasters: 0, keys: 0, prices: 0, history: 0, cityNodes: 0, cityTaxes: 0, settings: 0, syncLogs: 0 };
  const warnings = [];
  const accountIdMap = new Map();

  for (const d of all('SELECT type, name, sort_order, burden, status FROM dict_items')) {
    const row = await db.get('SELECT id FROM dict_items WHERE type = ? AND name = ?', [d.type, d.name]);
    if (row) continue;
    await db.run(
      'INSERT INTO dict_items (type, name, sort_order, burden, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d.type, d.name, d.sort_order, d.burden, d.status, t, t]
    );
    inserted.dict += 1;
  }

  for (const s of all('SELECT name FROM servers')) {
    const existing = await db.findServerId(s.name);
    await db.upsertServer(s.name);
    if (!existing) inserted.servers += 1;
  }

  for (const a of accountRows) {
    const existing = await db.get('SELECT id FROM accounts WHERE name = ?', [a.name]);
    if (existing) { accountIdMap.set(a.id, existing.id); continue; }
    const info = await db.run(
      `INSERT INTO accounts (name, password_hash, token, relief, status, expires_at, key_code,
                             device_limit, current_server, allow_sync_server, view_master_prices,
                             allow_master_prices, sso_source, sso_subject, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.name, a.passwordHash, a.token || null, a.relief == null ? 5 : a.relief,
        a.status || 'active', a.expiresAt || null, a.keyCode || null,
        Number(a.deviceLimit) || 3, a.currentServer || '', Number(a.allowSyncServer) ? 1 : 0,
        Number(a.viewMasterPrices) ? 1 : 0, a.allowMasterPrices == null ? 1 : (Number(a.allowMasterPrices) ? 1 : 0),
        a.ssoSource || null, a.ssoSubject || null,
        a.createdAt || t, a.updatedAt || t]
    );
    accountIdMap.set(a.id, info.insertId);
    inserted.accounts += 1;
  }

  const sourceServerMasters = new Map();
  if (hasTable('server_masters')) {
    for (const row of all(`SELECT s.name AS server, sm.account_id AS accountId
        FROM server_masters sm JOIN servers s ON s.id = sm.server_id`)) {
      if (row.server && row.accountId) sourceServerMasters.set(row.server, Number(row.accountId));
    }
  }
  if (hasTable('app_settings') && has('app_settings', 'master_account_id')) {
    const legacyMaster = raw.prepare('SELECT master_account_id AS id FROM app_settings WHERE id = 1').get();
    const srcMasterId = Number(legacyMaster && legacyMaster.id) || 0;
    const masterAccount = srcMasterId ? accountRows.find(a => Number(a.id) === srcMasterId) : null;
    if (masterAccount && masterAccount.currentServer && !sourceServerMasters.has(masterAccount.currentServer)) {
      sourceServerMasters.set(masterAccount.currentServer, srcMasterId);
    }
  }
  for (const [serverName, srcAccountId] of sourceServerMasters) {
    const accountId = accountIdMap.get(Number(srcAccountId));
    if (!accountId) continue;
    const serverId = await db.upsertServer(serverName);
    const existing = await db.get('SELECT 1 AS hit FROM server_masters WHERE server_id = ?', [serverId]);
    if (existing) continue;
    await db.run(
      'INSERT INTO server_masters (server_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [serverId, accountId, t, t]
    );
    inserted.serverMasters += 1;
  }

  const legacyTokenAccountId = (() => {
    if (!hasTable('sync_settings') || !has('sync_settings', 'token_account_id')) return null;
    const row = raw.prepare('SELECT token_account_id AS id FROM sync_settings WHERE token_account_id IS NOT NULL LIMIT 1').get();
    return row ? Number(row.id) : null;
  })();
  let legacyOwner = legacyTokenAccountId && accountIdMap.get(legacyTokenAccountId);
  if (!legacyOwner) {
    const first = await db.get('SELECT id FROM accounts ORDER BY id ASC LIMIT 1');
    legacyOwner = first ? Number(first.id) : 0;
  }
  if (!legacyOwner && (all('SELECT 1 FROM prices LIMIT 1').length || all('SELECT 1 FROM price_history LIMIT 1').length)) {
    warnings.push('目标库没有账号，旧价格暂归入 account_id=0（注册任意账号后仍不可见，请手动调整）');
  }
  const accountFor = srcId => (srcId != null && accountIdMap.get(Number(srcId))) || legacyOwner || 0;

  if (hasTable('invite_keys')) {
    const keyCols = colsOf('invite_keys');
    for (const k of all('SELECT * FROM invite_keys')) {
      if (!k.code) continue;
      const existing = await db.get('SELECT id FROM invite_keys WHERE code = ?', [k.code]);
      if (existing) continue;
      const type = k.type || 'day';
      const status = k.status || (k.used_at ? 'used' : 'unused');
      const accountId = k.account_id
        ? accountFor(k.account_id)
        : (status === 'used' && legacyOwner ? legacyOwner : null);
      await db.run(
        `INSERT INTO invite_keys (code, type, status, note, batch_id, account_id, created_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [k.code, type, status, k.note || '', k.batch_id || '', accountId || null,
          k.created_at || t, k.used_at || null]
      );
      inserted.keys += 1;
    }
    if (keyCols.includes('type') && !all("SELECT 1 FROM invite_keys WHERE type IN ('day','month','forever') LIMIT 1").length) {
      warnings.push('源库卡密类型不在 day/month/forever 范围内，请检查');
    }
  }

  if (hasTable('app_settings')) {
    const row = raw.prepare('SELECT * FROM app_settings WHERE id = 1').get();
    if (row) {
      const keyHelpMd = has('app_settings', 'key_help_md') ? (row.key_help_md || '') : DEFAULT_KEY_HELP_MD;
      const tokenHelpMd = has('app_settings', 'token_help_md') ? (row.token_help_md || '') : DEFAULT_TOKEN_HELP_MD;
      const keyRequiredAt = has('app_settings', 'key_required_at')
        ? (row.key_required_at || '2026-10-22 00:00:00')
        : '2026-10-22 00:00:00';
      await db.run(
        `UPDATE app_settings SET registration_enabled = ?, announcement = ?, key_help_md = ?,
           token_help_md = ?, key_required_at = ?, default_device_limit = ?, updated_at = ?
          WHERE id = 1`,
        [row.registration_enabled == null ? 1 : row.registration_enabled ? 1 : 0,
          row.announcement || '', keyHelpMd, tokenHelpMd, keyRequiredAt,
          Number(row.default_device_limit) || 3, row.updated_at || t]
      );
    }
  }

  const priceAccountExpr = has('prices', 'account_id') ? 'p.account_id AS srcAccountId' : `${legacyTokenAccountId || 0} AS srcAccountId`;
  const priceRows = all(`
    SELECT s.name AS server, c.name AS city, d.name AS commodity,
           p.buy_price AS buy, p.sell_price AS sell, p.operator, p.updated_at AS updatedAt,
           ${priceAccountExpr}
      FROM prices p
      JOIN servers s ON s.id = p.server_id
      JOIN dict_items c ON c.id = p.city_id
      JOIN dict_items d ON d.id = p.commodity_id`);

  for (const p of priceRows) {
    const accountId = accountFor(p.srcAccountId);
    const serverId = await db.upsertServer(p.server);
    const cityId = await db.findDictId('city', p.city);
    const commodityId = await db.findDictId('commodity', p.commodity);
    if (!cityId || !commodityId) continue;
    const existing = await db.get(
      'SELECT id FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
      [accountId, serverId, cityId, commodityId]
    );
    if (existing) continue;
    await db.run(
      `INSERT INTO prices (account_id, server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, serverId, cityId, commodityId, p.buy, p.sell, p.operator, p.updatedAt || t]
    );
    inserted.prices += 1;
  }

  const historyAccountExpr = has('price_history', 'account_id')
    ? 'h.account_id AS srcAccountId'
    : `${legacyTokenAccountId || 0} AS srcAccountId`;

  for (const h of all(`
    SELECT s.name AS server, c.name AS city, d.name AS commodity,
           h.field, h.old_value AS oldValue, h.new_value AS newValue, h.operator, h.created_at AS createdAt,
           ${historyAccountExpr}
      FROM price_history h
      JOIN servers s ON s.id = h.server_id
      JOIN dict_items c ON c.id = h.city_id
      JOIN dict_items d ON d.id = h.commodity_id
     ORDER BY h.id`)) {
    const accountId = accountFor(h.srcAccountId);
    const serverId = await db.findServerId(h.server);
    const cityId = await db.findDictId('city', h.city);
    const commodityId = await db.findDictId('commodity', h.commodity);
    if (!serverId || !cityId || !commodityId) continue;
    await db.run(
      `INSERT INTO price_history (account_id, server_id, city_id, commodity_id, field,
                                  old_value, new_value, operator, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, serverId, cityId, commodityId, h.field, h.oldValue, h.newValue, h.operator, h.createdAt || t]
    );
    inserted.history += 1;
  }

  for (const c of all(`SELECT city_name AS cityName, cfg_name AS cfgName, node_no AS nodeNo,
                              meta_id AS metaId, grid_x AS gridX, grid_y AS gridY FROM city_nodes`)) {
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

  const taxAccountExpr = has('city_taxes', 'account_id') ? 't.account_id AS srcAccountId' : `${legacyTokenAccountId || 0} AS srcAccountId`;
  for (const ct of all(`SELECT s.name AS server, c.name AS city, t.tax, ${taxAccountExpr}
                          FROM city_taxes t
                          JOIN servers s ON s.id = t.server_id
                          JOIN dict_items c ON c.id = t.city_id`)) {
    const serverId = await db.findServerId(ct.server);
    const cityId = await db.findDictId('city', ct.city);
    if (!serverId || !cityId) continue;
    await db.setCityTax(accountFor(ct.srcAccountId), serverId, cityId, Number(ct.tax));
    inserted.cityTaxes += 1;
  }

  if (hasTable('sync_settings')) {
    const sCols = colsOf('sync_settings');
    const overrideExpr = sCols.includes('server_override') ? 's.server_override AS serverOverride' : "'' AS serverOverride";
    if (sCols.includes('account_id')) {
      for (const s of all(`SELECT s.*, ${overrideExpr}, a.name AS accountName FROM sync_settings s
                             LEFT JOIN accounts a ON a.id = s.account_id`)) {
        const target = s.account_id ? accountFor(s.account_id) : 0;
        if (!target) continue;
        await db.run(
          `INSERT INTO sync_settings (account_id, enabled, cron_expr, server_name, server_override, operator,
                                      last_run_at, last_status, last_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), cron_expr = VALUES(cron_expr),
             server_name = VALUES(server_name), server_override = VALUES(server_override), operator = VALUES(operator),
             last_run_at = VALUES(last_run_at), last_status = VALUES(last_status),
             last_message = VALUES(last_message)`,
          [target, s.enabled ? 1 : 0, s.cron_expr || '0 */2 * * *', s.server_name || '',
            s.serverOverride || '', s.operator || '定时同步', s.last_run_at || null, s.last_status || null, s.last_message || null]
        );
        if (s.token) await db.run('UPDATE accounts SET token = ? WHERE id = ?', [s.token, target]);
        inserted.settings += 1;
      }
    } else if (has('sync_settings', 'id')) {
      const s = raw.prepare('SELECT * FROM sync_settings WHERE id = 1').get();
      if (s) {
        const target = legacyTokenAccountId ? accountFor(legacyTokenAccountId) : legacyOwner;
        if (target) {
          await db.run(
            `INSERT INTO sync_settings (account_id, enabled, cron_expr, server_name, server_override, operator,
                                        last_run_at, last_status, last_message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), cron_expr = VALUES(cron_expr),
               server_name = VALUES(server_name), server_override = VALUES(server_override), operator = VALUES(operator),
               last_run_at = VALUES(last_run_at), last_status = VALUES(last_status),
               last_message = VALUES(last_message)`,
            [target, s.enabled ? 1 : 0, s.cron_expr || '0 */2 * * *', s.server_name || '',
              s.server_override || '', s.operator || '定时同步', s.last_run_at || null, s.last_status || null, s.last_message || null]
          );
          if (s.token) await db.run('UPDATE accounts SET token = ? WHERE id = ?', [s.token, target]);
          inserted.settings += 1;
        } else {
          warnings.push('旧定时设置未迁移：没有可归属的账号');
        }
      }
    }
  }

  if (hasTable('sync_log')) {
    const lCols = colsOf('sync_log');
    const logAccountExpr = lCols.includes('account_id') ? 'account_id AS srcAccountId' : `${legacyTokenAccountId || 0} AS srcAccountId`;
    for (const l of all(`SELECT ${logAccountExpr}, trigger_type, server_name, started_at, finished_at,
                                status, queried, saved, failed_count, message
                           FROM sync_log ORDER BY id`)) {
      await db.run(
        `INSERT INTO sync_log (account_id, trigger_type, server_name, started_at, finished_at,
                               status, queried, saved, failed_count, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountFor(l.srcAccountId), l.trigger_type || 'cli', l.server_name || '',
          l.started_at || t, l.finished_at || null, l.status || 'success',
          Number(l.queried) || 0, Number(l.saved) || 0, Number(l.failed_count) || 0, l.message || '']
      );
      inserted.syncLogs += 1;
    }
  }

  raw.close();
  console.log('迁移完成：', JSON.stringify({
    source: srcFile,
    target: `${process.env.MYSQL_HOST || '127.0.0.1'}/${process.env.MYSQL_DATABASE || 'price_share'}`,
    inserted,
    legacyOwnerAccountId: legacyOwner,
    warnings,
  }, null, 2));
  await db.close();
})().catch(async err => {
  console.error('迁移失败:', err.message);
  process.exitCode = 1;
  try { require('../db').close(); } catch { /* ignore */ }
});
