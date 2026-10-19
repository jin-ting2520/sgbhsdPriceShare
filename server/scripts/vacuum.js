'use strict';

/** 数据库维护：统计信息（SQLite 额外执行 VACUUM / MySQL 执行 OPTIMIZE） */

const db = require('../db');

(async () => {
  await db.ready();
  const dictCount = (await db.get('SELECT COUNT(*) AS n FROM dict_items')).n;
  const priceCount = (await db.get('SELECT COUNT(*) AS n FROM prices')).n;
  const historyCount = (await db.get('SELECT COUNT(*) AS n FROM price_history')).n;

  let status = 'ok';
  if (db.IS_MYSQL) {
    for (const table of ['dict_items', 'servers', 'prices', 'price_history']) {
      try {
        await db.query(`OPTIMIZE TABLE ${table}`);
      } catch (err) {
        status = `partial: ${err.message}`;
      }
    }
  } else {
    await db.run('VACUUM');
  }

  console.log(JSON.stringify({
    driver: db.DRIVER,
    target: db.IS_MYSQL ? `${process.env.MYSQL_HOST || '127.0.0.1'}/${process.env.MYSQL_DATABASE || 'price_share'}` : db.DB_FILE,
    dict: dictCount,
    prices: priceCount,
    history: historyCount,
    status,
  }, null, 2));
  await db.close();
})().catch(async err => {
  console.error('维护失败:', err.message);
  process.exitCode = 1;
  try { await db.close(); } catch { /* ignore */ }
});
