'use strict';

/**
 * 数据层：SQLite（Node 内置 node:sqlite，零原生编译依赖）
 * 表结构：
 *  - dict_items    字典表（城池 / 商品）
 *  - servers       区服表（自由文本输入的区服自动登记）
 *  - prices        价格表（区服 + 城池 + 商品 唯一，买价 / 卖价 / 更新人）
 *  - price_history 价格变更流水（含操作人昵称）
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = nodePath.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// PRICE_DB 便于测试使用独立临时库
const DB_FILE = process.env.PRICE_DB
  ? nodePath.resolve(process.env.PRICE_DB)
  : nodePath.join(DATA_DIR, 'price.db');

const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS dict_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL CHECK (type IN ('city', 'commodity')),
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  burden     REAL,                                    -- 负重（商品）：利润 = (卖价-买价)/负重
  status     INTEGER NOT NULL DEFAULT 1,          -- 1 启用 / 0 停用
  created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_dict_type_name ON dict_items(type, name);

CREATE TABLE IF NOT EXISTS servers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS prices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id)    ON DELETE CASCADE,
  city_id      INTEGER NOT NULL REFERENCES dict_items(id) ON DELETE CASCADE,
  commodity_id INTEGER NOT NULL REFERENCES dict_items(id) ON DELETE CASCADE,
  buy_price    REAL,
  sell_price   REAL,
  operator     TEXT,                                    -- 最后更新人
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (server_id, city_id, commodity_id)
);
CREATE INDEX IF NOT EXISTS idx_prices_lookup ON prices(server_id, city_id, commodity_id);

CREATE TABLE IF NOT EXISTS price_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL,
  city_id      INTEGER NOT NULL,
  commodity_id INTEGER NOT NULL,
  field        TEXT    NOT NULL,                        -- buy_price / sell_price
  old_value    REAL,
  new_value    REAL,
  operator     TEXT,                                    -- 操作人（更新人昵称）
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_history_scope ON price_history(server_id, city_id, created_at DESC);
`);

/* 存量库迁移：补 price_history.operator / dict_items.burden / prices.operator 列 */
const historyCols = db.prepare('PRAGMA table_info(price_history)').all().map(c => c.name);
if (!historyCols.includes('operator')) {
  db.exec('ALTER TABLE price_history ADD COLUMN operator TEXT');
}
const dictCols = db.prepare('PRAGMA table_info(dict_items)').all().map(c => c.name);
if (!dictCols.includes('burden')) {
  db.exec('ALTER TABLE dict_items ADD COLUMN burden REAL');
}
const priceCols = db.prepare('PRAGMA table_info(prices)').all().map(c => c.name);
if (!priceCols.includes('operator')) {
  db.exec('ALTER TABLE prices ADD COLUMN operator TEXT');
}

/* ------------------------------ 种子数据 ------------------------------ */

const CITY_LIST = [
  '桂阳', '浈阳', '曲江', '赣县', '柴桑', '谢沐', '营浦', '梆县', '茶陵',
  '庐陵', '宜春', '蕲春', '宛陵', '谭成', '零陵', '泉陵', '酃县', '江陵',
  '临湘', '西陵', '戈阳', '安丰', '鄱阳', '钱塘', '芜湖', '西阳', '章陵',
  '襄阳', '夷陵', '巫县', '白帝城', '涪陵', '江州', '辰阳', '昭陵', '酉阳',
  '广汉', '朐县', '西城', '房陵',
];

/** 内置商品及负重（负重用于计算利润：卖价-买价 后按负重折算） */
const COMMODITY_SEED = [
  { name: '谷物', burden: 10 }, { name: '黏土', burden: 15 }, { name: '葡萄', burden: 10 },
  { name: '铁矿石', burden: 34 }, { name: '铜矿石', burden: 35 }, { name: '硬木', burden: 15 },
  { name: '棉花', burden: 13 }, { name: '茶叶', burden: 13 }, { name: '药材', burden: 11 },
  { name: '香料', burden: 10 }, { name: '毛皮', burden: 18 }, { name: '蜂蜜', burden: 29 },
  { name: '盐', burden: 35 }, { name: '米酒', burden: 30 }, { name: '陶器', burden: 30 },
  { name: '葡萄酒', burden: 30 }, { name: '兵器', burden: 52 }, { name: '铜器', burden: 55 },
  { name: '工具', burden: 50 }, { name: '布帛', burden: 16 }, { name: '蜀锦', burden: 10 },
  { name: '漆器', burden: 32 }, { name: '玉器', burden: 32 }, { name: '海南珍珠', burden: 12 },
  { name: '金银器', burden: 27 },
];

/** 利润 =（卖价 - 买价）/ 负重 */
function calcProfit(buy, sell, burden) {
  if (buy == null || sell == null || burden == null || !(burden > 0)) return null;
  const v = (sell - buy) / burden;
  return Math.round(v * 100) / 100;
}

function seedIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM dict_items').get();
  if (row.n > 0) return;
  const insert = db.prepare(
    'INSERT INTO dict_items (type, name, sort_order) VALUES (?, ?, ?)'
  );
  CITY_LIST.forEach((name, i) => insert.run('city', name, i + 1));
  COMMODITY_SEED.forEach((c, i) => insert.run('commodity', c.name, i + 1));
}
seedIfEmpty();

/**
 * 商品字典补齐 / 负重维护：
 *  - 缺失的内置商品自动插入（含负重，如新增的「毛皮」）
 *  - 内置商品负重随代码更新
 *  - 内置商品排序对齐字典顺序，用户自建商品排在其后
 */
function ensureCommoditiesWithBurden() {
  const findByName = db.prepare("SELECT id, burden FROM dict_items WHERE type = 'commodity' AND name = ?");
  const insert = db.prepare(
    'INSERT INTO dict_items (type, name, sort_order, burden) VALUES (?, ?, ?, ?)'
  );

  COMMODITY_SEED.forEach((c, i) => {
    const row = findByName.get(c.name);
    if (row) {
      if (row.burden !== c.burden) {
        db.prepare('UPDATE dict_items SET burden = ?, sort_order = ? WHERE id = ?').run(c.burden, i + 1, row.id);
      }
    } else {
      insert.run('commodity', c.name, i + 1, c.burden);
    }
  });

  // 重新对齐排序：内置 1..N，用户自建的按原顺序接在后面
  const names = COMMODITY_SEED.map(c => c.name);
  const extras = db.prepare(
    `SELECT id FROM dict_items WHERE type = 'commodity' AND name NOT IN (${names.map(() => '?').join(',')})
      ORDER BY sort_order, id`
  ).all(...names);
  extras.forEach((row, i) => {
    db.prepare('UPDATE dict_items SET sort_order = ? WHERE id = ?').run(names.length + i + 1, row.id);
  });
}
ensureCommoditiesWithBurden();

// 历史流水只保留最近 2000 条
function trimHistory() {
  db.prepare(
    `DELETE FROM price_history WHERE id NOT IN (
       SELECT id FROM price_history ORDER BY id DESC LIMIT 2000
     )`
  ).run();
}
trimHistory();

/* ------------------------------ 通用工具 ------------------------------ */

function nowText() {
  return db.prepare("SELECT datetime('now', 'localtime') AS t").get().t;
}

/** 按名称取/建区服 */
function upsertServer(name) {
  db.prepare(
    `INSERT INTO servers (name, created_at, updated_at) VALUES (?, datetime('now','localtime'), datetime('now','localtime'))
     ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now','localtime')`
  ).run(name);
  return db.prepare('SELECT id FROM servers WHERE name = ?').get(name).id;
}

function findServerId(name) {
  const r = name == null ? null : db.prepare('SELECT id FROM servers WHERE name = ?').get(name);
  return r ? r.id : null;
}

function findDictId(type, name) {
  const r = db.prepare('SELECT id FROM dict_items WHERE type = ? AND name = ?').get(type, name);
  return r ? r.id : null;
}

/** 创建字典项（城池/商品可重复时抛冲突错误） */
function createDictItem(type, name, burden = null) {
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM dict_items WHERE type = ?').get(type).m;
  const info = db.prepare(
    'INSERT INTO dict_items (type, name, sort_order, burden) VALUES (?, ?, ?, ?)'
  ).run(type, name, maxSort + 1, burden == null || burden === '' ? null : Number(burden));
  return db.prepare('SELECT * FROM dict_items WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = {
  db,
  DB_FILE,
  DATA_DIR,
  nowText,
  upsertServer,
  findServerId,
  findDictId,
  createDictItem,
  calcProfit,
  COMMODITY_LIST: COMMODITY_SEED.map(c => c.name),
  CITY_LIST,
};
