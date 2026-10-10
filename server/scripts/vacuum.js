'use strict';

/** 数据库维护：压缩文件 / 统计信息 */

const { db, DB_FILE } = require('../db');

const dictCount = db.prepare('SELECT COUNT(*) AS n FROM dict_items').get().n;
const priceCount = db.prepare('SELECT COUNT(*) AS n FROM prices').get().n;
const historyCount = db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n;

db.exec('VACUUM');

console.log(JSON.stringify({
  file: DB_FILE,
  dict: dictCount,
  prices: priceCount,
  history: historyCount,
  status: 'ok',
}, null, 2));
