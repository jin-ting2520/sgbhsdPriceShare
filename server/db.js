'use strict';

/**
 * 数据层：SQLite（Node 内置 node:sqlite，零原生编译依赖）
 * 表结构：
 *  - dict_items    字典表（城池 / 商品）
 *  - servers       区服表（自由文本输入的区服自动登记）
 *  - prices        价格表（区服 + 城池 + 商品 唯一，买价 / 卖价）
 *  - price_history 价格变更流水
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = nodePath.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = nodePath.join(DATA_DIR, 'price.db');

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
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_history_scope ON price_history(server_id, city_id, created_at DESC);
`);

/* ------------------------------ 种子数据 ------------------------------ */

const CITY_LIST = [
  '桂阳', '浈阳', '曲江', '赣县', '柴桑', '谢沐', '营浦', '梆县', '茶陵',
  '庐陵', '宜春', '蕲春', '宛陵', '谭成', '零陵', '泉陵', '酃县', '江陵',
  '临湘', '西陵', '戈阳', '安丰', '鄱阳', '钱塘', '芜湖', '西阳', '章陵',
  '襄阳', '夷陵', '巫县', '白帝城', '涪陵', '江州', '辰阳', '昭陵', '酉阳',
  '广汉', '朐县', '西城', '房陵',
];

const COMMODITY_LIST = [
  '谷物', '黏土', '葡萄', '铁矿石', '铜矿石', '硬木', '棉花', '茶叶', '药材',
  '香料', '蜂蜜', '盐', '米酒', '陶器', '葡萄酒', '兵器', '铜器', '工具',
  '布帛', '蜀锦', '漆器', '玉器', '海南珍珠', '金银器',
];

function seedIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM dict_items').get();
  if (row.n > 0) return;
  const insert = db.prepare(
    'INSERT INTO dict_items (type, name, sort_order) VALUES (?, ?, ?)'
  );
  CITY_LIST.forEach((name, i) => insert.run('city', name, i + 1));
  COMMODITY_LIST.forEach((name, i) => insert.run('commodity', name, i + 1));
}
seedIfEmpty();

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
function createDictItem(type, name) {
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM dict_items WHERE type = ?').get(type).m;
  const info = db.prepare(
    'INSERT INTO dict_items (type, name, sort_order) VALUES (?, ?, ?)'
  ).run(type, name, maxSort + 1);
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
  CITY_LIST,
  COMMODITY_LIST,
};
