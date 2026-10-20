'use strict';

/**
 * 数据层：MySQL（生产，docker-compose 内置） / SQLite（本地与测试回退）
 *
 * 选择规则：
 *   DB_DRIVER=mysql 或存在 MYSQL_HOST  → MySQL（mysql2 连接池）
 *   DB_DRIVER=sqlite 或未设置           → SQLite（node:sqlite，PRICE_DB 可指定文件）
 *
 * 所有查询统一使用 ? 占位符；时间统一存北京时间字符串 'YYYY-MM-DD HH:MM:SS'。
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const { DEFAULT_KEY_HELP_MD, DEFAULT_TOKEN_HELP_MD } = require('./markdown');

const DRIVER = (process.env.DB_DRIVER || (process.env.MYSQL_HOST ? 'mysql' : 'sqlite')).toLowerCase();
const IS_MYSQL = DRIVER === 'mysql';

const DATA_DIR = nodePath.join(__dirname, '..', 'data');
const DB_FILE = process.env.PRICE_DB
  ? nodePath.resolve(process.env.PRICE_DB)
  : nodePath.join(DATA_DIR, 'price.db');
const HISTORY_LIMIT = Math.max(1000, Number(process.env.HISTORY_LIMIT) || 20000);
const DEFAULT_KEY_REQUIRED_AT = '2026-10-22 00:00:00';

/* ------------------------------ 种子数据 ------------------------------ */

const CITY_LIST = [
  '桂阳', '浈阳', '曲江', '赣县', '柴桑', '谢沐', '营浦', '梆县', '茶陵',
  '庐陵', '宜春', '蕲春', '宛陵', '谭成', '零陵', '泉陵', '酃县', '江陵',
  '临湘', '西陵', '戈阳', '安丰', '鄱阳', '钱塘', '芜湖', '西阳', '章陵',
  '襄阳', '夷陵', '巫县', '白帝城', '涪陵', '江州', '辰阳', '昭陵', '酉阳',
  '广汉', '朐县', '西城', '房陵',
];

/** 内置商品及负重（负重为商品固有属性，比价时参考） */
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

/* ------------------------------ 连接 ------------------------------ */

let pool = null;
let sqlite = null;
let initPromise = null;

const MYSQL_CFG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || 'price',
  password: process.env.MYSQL_PASSWORD || 'price',
  database: process.env.MYSQL_DATABASE || 'price_share',
  waitForConnections: true,
  connectionLimit: Math.max(2, Number(process.env.MYSQL_POOL) || 10),
  charset: 'utf8mb4',
  dateStrings: true,
  decimalNumbers: true,
  multipleStatements: false,
};

function formatTime(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/** 解析按北京时间存储的 YYYY-MM-DD[ HH:mm:ss] 文本，避免服务器时区不同导致偏移 */
function parseTime(text) {
  const raw = String(text || '').trim();
  if (!raw) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00`
    : raw.replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`);
}

function nowText() {
  return formatTime(Date.now());
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------ 建表 ------------------------------ */

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS dict_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL CHECK (type IN ('city', 'commodity')),
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  burden     REAL,
  status     INTEGER NOT NULL DEFAULT 1,
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
  account_id   INTEGER NOT NULL DEFAULT 0,
  server_id    INTEGER NOT NULL REFERENCES servers(id)    ON DELETE CASCADE,
  city_id      INTEGER NOT NULL REFERENCES dict_items(id) ON DELETE CASCADE,
  commodity_id INTEGER NOT NULL REFERENCES dict_items(id) ON DELETE CASCADE,
  buy_price    REAL,
  sell_price   REAL,
  operator     TEXT,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (account_id, server_id, city_id, commodity_id)
);
CREATE INDEX IF NOT EXISTS idx_prices_lookup ON prices(account_id, server_id, city_id, commodity_id);

CREATE TABLE IF NOT EXISTS price_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL DEFAULT 0,
  server_id    INTEGER NOT NULL,
  city_id      INTEGER NOT NULL,
  commodity_id INTEGER NOT NULL,
  field        TEXT    NOT NULL,
  old_value    REAL,
  new_value    REAL,
  operator     TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_history_scope ON price_history(account_id, server_id, city_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_time ON price_history(created_at);

CREATE TABLE IF NOT EXISTS city_taxes (
  account_id INTEGER NOT NULL DEFAULT 0,
  server_id  INTEGER NOT NULL,
  city_id    INTEGER NOT NULL,
  tax        REAL    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (account_id, server_id, city_id)
);

CREATE TABLE IF NOT EXISTS city_nodes (
  city_name TEXT PRIMARY KEY,
  cfg_name  TEXT,
  node_no   INTEGER,
  meta_id   INTEGER,
  grid_x    INTEGER,
  grid_y    INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT    NOT NULL,
  token         TEXT,
  session_token TEXT    UNIQUE,
  relief        REAL    NOT NULL DEFAULT 5,
  status        TEXT    NOT NULL DEFAULT 'active',
  expires_at    TEXT,
  key_code      TEXT,
  device_limit  INTEGER NOT NULL DEFAULT 3,
  current_server TEXT   NOT NULL DEFAULT '',
  allow_sync_server INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT    NOT NULL UNIQUE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id    TEXT,
  device_name  TEXT,
  ip           TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, id DESC);

CREATE TABLE IF NOT EXISTS invite_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  type       TEXT    NOT NULL CHECK (type IN ('day', 'month', 'forever')),
  status     TEXT    NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used', 'revoked')),
  note       TEXT,
  batch_id   TEXT,
  account_id INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_keys_status ON invite_keys(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_keys_batch ON invite_keys(batch_id);

CREATE TABLE IF NOT EXISTS app_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  registration_enabled INTEGER NOT NULL DEFAULT 1,
  announcement         TEXT    NOT NULL DEFAULT '',
  key_help_md          TEXT    NOT NULL DEFAULT '',
  token_help_md        TEXT    NOT NULL DEFAULT '',
  key_required_at      TEXT    NOT NULL DEFAULT '2026-10-22 00:00:00',
  default_device_limit INTEGER NOT NULL DEFAULT 3,
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sync_settings (
  account_id   INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 0,
  cron_expr    TEXT    NOT NULL DEFAULT '0 */2 * * *',
  server_name  TEXT    NOT NULL DEFAULT '',
  server_override TEXT NOT NULL DEFAULT '',
  operator     TEXT    NOT NULL DEFAULT '定时同步',
  last_run_at  TEXT,
  last_status  TEXT,
  last_message TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER,
  trigger_type  TEXT    NOT NULL,
  server_name   TEXT,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  status        TEXT    NOT NULL,
  queried       INTEGER NOT NULL DEFAULT 0,
  saved         INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  message       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_account ON sync_log(account_id, id DESC);
`;

const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS dict_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(16) NOT NULL,
    name VARCHAR(50) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    burden DECIMAL(10,2) NULL,
    status TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_dict_type_name (type, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS servers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_servers_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS prices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL DEFAULT 0,
    server_id INT NOT NULL,
    city_id INT NOT NULL,
    commodity_id INT NOT NULL,
    buy_price DECIMAL(12,2) NULL,
    sell_price DECIMAL(12,2) NULL,
    operator VARCHAR(20) NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_prices_scope (account_id, server_id, city_id, commodity_id),
    KEY idx_prices_lookup (account_id, server_id, city_id, commodity_id),
    CONSTRAINT fk_prices_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    CONSTRAINT fk_prices_city FOREIGN KEY (city_id) REFERENCES dict_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_prices_commodity FOREIGN KEY (commodity_id) REFERENCES dict_items(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS price_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL DEFAULT 0,
    server_id INT NOT NULL,
    city_id INT NOT NULL,
    commodity_id INT NOT NULL,
    field VARCHAR(16) NOT NULL,
    old_value DECIMAL(12,2) NULL,
    new_value DECIMAL(12,2) NULL,
    operator VARCHAR(20) NULL,
    created_at DATETIME NOT NULL,
    KEY idx_history_scope (account_id, server_id, city_id, created_at),
    KEY idx_history_time (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS city_taxes (
    account_id INT NOT NULL DEFAULT 0,
    server_id INT NOT NULL,
    city_id INT NOT NULL,
    tax DECIMAL(4,2) NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (account_id, server_id, city_id),
    CONSTRAINT fk_city_taxes_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    CONSTRAINT fk_city_taxes_city FOREIGN KEY (city_id) REFERENCES dict_items(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS city_nodes (
    city_name VARCHAR(20) PRIMARY KEY,
    cfg_name VARCHAR(20) NULL,
    node_no INT NULL,
    meta_id INT NULL,
    grid_x INT NULL,
    grid_y INT NULL,
    updated_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(20) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    token TEXT NULL,
    session_token VARCHAR(128) NULL,
    relief DECIMAL(5,2) NOT NULL DEFAULT 5,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    expires_at DATETIME NULL,
    key_code VARCHAR(32) NULL,
    device_limit INT NOT NULL DEFAULT 3,
    current_server VARCHAR(50) NOT NULL DEFAULT '',
    allow_sync_server TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_accounts_name (name),
    UNIQUE KEY uk_accounts_session (session_token)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(64) NOT NULL,
    account_id INT NOT NULL,
    device_id VARCHAR(64) NULL,
    device_name VARCHAR(80) NULL,
    ip VARCHAR(45) NULL,
    created_at DATETIME NOT NULL,
    last_seen_at DATETIME NULL,
    UNIQUE KEY uk_sessions_token (token),
    KEY idx_sessions_account (account_id, id),
    CONSTRAINT fk_sessions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS invite_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(32) NOT NULL,
    type VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'unused',
    note VARCHAR(200) NULL,
    batch_id VARCHAR(40) NULL,
    account_id INT NULL,
    created_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    UNIQUE KEY uk_keys_code (code),
    KEY idx_keys_status (status, id),
    KEY idx_keys_batch (batch_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    id TINYINT PRIMARY KEY,
    registration_enabled TINYINT NOT NULL DEFAULT 1,
    announcement VARCHAR(500) NOT NULL DEFAULT '',
    key_help_md MEDIUMTEXT NULL,
    token_help_md MEDIUMTEXT NULL,
    key_required_at VARCHAR(19) NOT NULL DEFAULT '2026-10-22 00:00:00',
    default_device_limit INT NOT NULL DEFAULT 3,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS sync_settings (
    account_id INT PRIMARY KEY,
    enabled TINYINT NOT NULL DEFAULT 0,
    cron_expr VARCHAR(64) NOT NULL DEFAULT '0 */2 * * *',
    server_name VARCHAR(50) NOT NULL DEFAULT '',
    server_override VARCHAR(50) NOT NULL DEFAULT '',
    operator VARCHAR(20) NOT NULL DEFAULT '定时同步',
    last_run_at DATETIME NULL,
    last_status VARCHAR(16) NULL,
    last_message VARCHAR(500) NULL,
    CONSTRAINT fk_sync_settings_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS sync_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NULL,
    trigger_type VARCHAR(16) NOT NULL,
    server_name VARCHAR(50) NULL,
    started_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    status VARCHAR(16) NOT NULL,
    queried INT NOT NULL DEFAULT 0,
    saved INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    message VARCHAR(500) NULL,
    KEY idx_sync_log_account (account_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/* ------------------------------ 基础操作 ------------------------------ */

function normalize(params) {
  return (params || []).map(v => (v === undefined ? null : v));
}

async function rawQuery(sql, params) {
  if (IS_MYSQL) {
    const [rows] = await pool.query(sql, normalize(params));
    return rows;
  }
  return sqlite.prepare(sql).all(...normalize(params));
}

async function rawRun(sql, params) {
  if (IS_MYSQL) {
    const [res] = await pool.query(sql, normalize(params));
    return { insertId: res.insertId, affectedRows: res.affectedRows };
  }
  const res = sqlite.prepare(sql).run(...normalize(params));
  return { insertId: Number(res.lastInsertRowid), affectedRows: res.changes };
}

/** 事务：fn 内只做同步数据库操作，避免长时间持锁 */
async function tx(fn) {
  await init();
  if (IS_MYSQL) {
    const conn = await pool.getConnection();
    const t = {
      query: async (sql, params = []) => {
        const [rows] = await conn.query(sql, normalize(params));
        return rows;
      },
      get: async (sql, params = []) => {
        const [rows] = await conn.query(sql, normalize(params));
        return rows[0];
      },
      run: async (sql, params = []) => {
        const [res] = await conn.query(sql, normalize(params));
        return { insertId: res.insertId, affectedRows: res.affectedRows };
      },
    };
    try {
      await conn.beginTransaction();
      const out = await fn(t);
      await conn.commit();
      return out;
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  sqlite.exec('BEGIN IMMEDIATE');
  const t = {
    query: async (sql, params = []) => sqlite.prepare(sql).all(...normalize(params)),
    get: async (sql, params = []) => sqlite.prepare(sql).get(...normalize(params)),
    run: async (sql, params = []) => {
      const res = sqlite.prepare(sql).run(...normalize(params));
      return { insertId: Number(res.lastInsertRowid), affectedRows: res.changes };
    },
  };
  try {
    const out = await fn(t);
    sqlite.exec('COMMIT');
    return out;
  } catch (err) {
    try { sqlite.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

const query = async (sql, params = []) => { await init(); return rawQuery(sql, params); };
const get = async (sql, params = []) => { await init(); const rows = await rawQuery(sql, params); return rows[0]; };
const run = async (sql, params = []) => { await init(); return rawRun(sql, params); };

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit() {
  if (IS_MYSQL) {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool(MYSQL_CFG);
    let lastErr;
    for (let i = 1; i <= 30; i++) {
      try {
        await pool.query('SELECT 1');
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (i % 5 === 1) {
          console.error(`[db] MySQL 连接失败（${MYSQL_CFG.host}:${MYSQL_CFG.port}/${MYSQL_CFG.database}），第 ${i} 次重试… ${err.message}`);
        }
        await sleep(2000);
      }
    }
    if (lastErr) throw new Error(`无法连接 MySQL：${lastErr.message}`);
    for (const sql of MYSQL_SCHEMA) await pool.query(sql);
    await migrateMysql();
  } else {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(nodePath.dirname(DB_FILE), { recursive: true });
    try {
      sqlite = new DatabaseSync(DB_FILE);
    } catch (err) {
      console.error(`[db] 无法打开数据库文件: ${DB_FILE}`);
      throw err;
    }
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    runSqliteSchema(true);
    migrateSqlite();
    runSqliteSchema(false);
  }
  await seed();
  console.log(`[db] 已就绪：${IS_MYSQL ? `MySQL ${MYSQL_CFG.host}:${MYSQL_CFG.port}/${MYSQL_CFG.database}` : `SQLite ${DB_FILE}`}`);
}

/** 逐条执行建表语句：老库可能缺列导致索引创建失败，先容错建表再迁移补列 */
function runSqliteSchema(tolerant) {
  for (const stmt of SQLITE_SCHEMA.split(';')) {
    const sql = stmt.trim();
    if (!sql) continue;
    try {
      sqlite.exec(sql);
    } catch (err) {
      if (!tolerant) console.warn(`[db] 建表/索引语句跳过：${err.message}`);
    }
  }
}

/** 存量 SQLite 库补列/改表（老版本升级） */
function migrateSqlite() {
  const colsOf = table => sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const hasCol = (table, col) => colsOf(table).includes(col);
  const hasTable = table => !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const legacyAccount = '(SELECT COALESCE(MIN(id), 0) FROM accounts)';

  // 更早版本的会话表（user_id/expires_at）无法复用，直接重建，强制重新登录
  if (hasTable('sessions') && !hasCol('sessions', 'account_id')) sqlite.exec('DROP TABLE sessions');

  if (!hasCol('price_history', 'operator')) sqlite.exec('ALTER TABLE price_history ADD COLUMN operator TEXT');
  if (!hasCol('dict_items', 'burden')) sqlite.exec('ALTER TABLE dict_items ADD COLUMN burden REAL');
  if (!hasCol('prices', 'operator')) sqlite.exec('ALTER TABLE prices ADD COLUMN operator TEXT');

  if (!hasCol('accounts', 'relief')) sqlite.exec('ALTER TABLE accounts ADD COLUMN relief REAL NOT NULL DEFAULT 5');
  if (!hasCol('accounts', 'status')) sqlite.exec("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!hasCol('accounts', 'expires_at')) sqlite.exec('ALTER TABLE accounts ADD COLUMN expires_at TEXT');
  if (!hasCol('accounts', 'key_code')) sqlite.exec('ALTER TABLE accounts ADD COLUMN key_code TEXT');
  if (!hasCol('accounts', 'device_limit')) sqlite.exec('ALTER TABLE accounts ADD COLUMN device_limit INTEGER NOT NULL DEFAULT 3');
  if (!hasCol('accounts', 'current_server')) sqlite.exec("ALTER TABLE accounts ADD COLUMN current_server TEXT NOT NULL DEFAULT ''");
  if (!hasCol('accounts', 'allow_sync_server')) sqlite.exec('ALTER TABLE accounts ADD COLUMN allow_sync_server INTEGER NOT NULL DEFAULT 0');

  if (!hasCol('app_settings', 'key_help_md')) {
    sqlite.exec("ALTER TABLE app_settings ADD COLUMN key_help_md TEXT NOT NULL DEFAULT ''");
    sqlite.prepare('UPDATE app_settings SET key_help_md = ? WHERE id = 1 AND key_help_md = ?').run(DEFAULT_KEY_HELP_MD, '');
  }
  if (!hasCol('app_settings', 'token_help_md')) {
    sqlite.exec("ALTER TABLE app_settings ADD COLUMN token_help_md TEXT NOT NULL DEFAULT ''");
    sqlite.prepare('UPDATE app_settings SET token_help_md = ? WHERE id = 1 AND token_help_md = ?').run(DEFAULT_TOKEN_HELP_MD, '');
  }
  if (!hasCol('app_settings', 'key_required_at')) {
    sqlite.exec(`ALTER TABLE app_settings ADD COLUMN key_required_at TEXT NOT NULL DEFAULT '${DEFAULT_KEY_REQUIRED_AT}'`);
  }

  if (!hasCol('price_history', 'account_id')) {
    sqlite.exec('ALTER TABLE price_history ADD COLUMN account_id INTEGER NOT NULL DEFAULT 0');
    sqlite.exec(`UPDATE price_history SET account_id = ${legacyAccount}`);
  }
  sqlite.exec('DROP INDEX IF EXISTS idx_history_scope');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_history_scope ON price_history(account_id, server_id, city_id, created_at DESC)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_history_time ON price_history(created_at)');

  if (!hasCol('prices', 'account_id')) {
    sqlite.exec('ALTER TABLE prices RENAME TO prices_legacy');
    sqlite.exec(`
      CREATE TABLE prices (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   INTEGER NOT NULL DEFAULT 0,
        server_id    INTEGER NOT NULL REFERENCES servers(id)    ON DELETE CASCADE,
        city_id      INTEGER NOT NULL REFERENCES dict_items(id) ON DELETE CASCADE,
        commodity_id INTEGER NOT NULL REFERENCES dict_items(id) ON DELETE CASCADE,
        buy_price    REAL,
        sell_price   REAL,
        operator     TEXT,
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (account_id, server_id, city_id, commodity_id)
      )`);
    sqlite.exec(`INSERT INTO prices (id, account_id, server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at)
      SELECT id, ${legacyAccount}, server_id, city_id, commodity_id, buy_price, sell_price, operator, updated_at FROM prices_legacy`);
    sqlite.exec('DROP TABLE prices_legacy');
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_prices_lookup ON prices(account_id, server_id, city_id, commodity_id)');

  if (!hasCol('city_taxes', 'account_id')) {
    sqlite.exec('ALTER TABLE city_taxes RENAME TO city_taxes_legacy');
    sqlite.exec(`
      CREATE TABLE city_taxes (
        account_id INTEGER NOT NULL DEFAULT 0,
        server_id  INTEGER NOT NULL,
        city_id    INTEGER NOT NULL,
        tax        REAL    NOT NULL,
        updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (account_id, server_id, city_id)
      )`);
    sqlite.exec(`INSERT INTO city_taxes (account_id, server_id, city_id, tax, updated_at)
      SELECT ${legacyAccount}, server_id, city_id, tax, updated_at FROM city_taxes_legacy`);
    sqlite.exec('DROP TABLE city_taxes_legacy');
  }

  if (!hasCol('sync_settings', 'account_id')) {
    let legacy = null;
    try { legacy = sqlite.prepare('SELECT * FROM sync_settings WHERE id = 1').get(); } catch { /* ignore */ }
    sqlite.exec('ALTER TABLE sync_settings RENAME TO sync_settings_legacy');
    sqlite.exec(`
      CREATE TABLE sync_settings (
        account_id   INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        enabled      INTEGER NOT NULL DEFAULT 0,
        cron_expr    TEXT    NOT NULL DEFAULT '0 */2 * * *',
        server_name  TEXT    NOT NULL DEFAULT '',
        server_override TEXT NOT NULL DEFAULT '',
        operator     TEXT    NOT NULL DEFAULT '定时同步',
        last_run_at  TEXT,
        last_status  TEXT,
        last_message TEXT
      )`);
    if (legacy && Number(legacy.token_account_id) > 0) {
      const owner = sqlite.prepare('SELECT id FROM accounts WHERE id = ?').get(Number(legacy.token_account_id));
      if (owner) {
        sqlite.prepare(`INSERT OR IGNORE INTO sync_settings
          (account_id, enabled, cron_expr, server_name, operator, last_run_at, last_status, last_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          owner.id, legacy.enabled ? 1 : 0, legacy.cron_expr || '0 */2 * * *',
          legacy.server_name || '', legacy.operator || '定时同步',
          legacy.last_run_at || null, legacy.last_status || null, legacy.last_message || null
        );
      }
    }
    sqlite.exec('DROP TABLE sync_settings_legacy');
  }
  if (!hasCol('sync_settings', 'server_override')) {
    sqlite.exec("ALTER TABLE sync_settings ADD COLUMN server_override TEXT NOT NULL DEFAULT ''");
  }

  if (!hasCol('sync_log', 'account_id')) sqlite.exec('ALTER TABLE sync_log ADD COLUMN account_id INTEGER');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_sync_log_account ON sync_log(account_id, id DESC)');
}

/** 存量 MySQL 库补列/改表（老版本升级） */
async function migrateMysql() {
  const colsOf = async table => {
    const [cols] = await pool.query(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [MYSQL_CFG.database, table]
    );
    return cols;
  };
  const hasCol = async (table, col) => (await colsOf(table)).some(c => c.name === col);
  const legacyAccount = '(SELECT COALESCE(MIN(id), 0) FROM accounts)';
  const tryQuery = async sql => { try { await pool.query(sql); } catch { /* 老库缺少对应索引时忽略 */ } };

  if (!(await hasCol('sessions', 'account_id'))) {
    await tryQuery('DROP TABLE sessions');
    await pool.query(`CREATE TABLE sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(64) NOT NULL,
      account_id INT NOT NULL,
      device_id VARCHAR(64) NULL,
      device_name VARCHAR(80) NULL,
      ip VARCHAR(45) NULL,
      created_at DATETIME NOT NULL,
      last_seen_at DATETIME NULL,
      UNIQUE KEY uk_sessions_token (token),
      KEY idx_sessions_account (account_id, id),
      CONSTRAINT fk_sessions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  if (!(await hasCol('accounts', 'relief'))) {
    await pool.query('ALTER TABLE accounts ADD COLUMN relief DECIMAL(5,2) NOT NULL DEFAULT 5');
  }
  if (!(await hasCol('accounts', 'status'))) {
    await pool.query("ALTER TABLE accounts ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active'");
  }
  if (!(await hasCol('accounts', 'expires_at'))) {
    await pool.query('ALTER TABLE accounts ADD COLUMN expires_at DATETIME NULL');
  }
  if (!(await hasCol('accounts', 'key_code'))) {
    await pool.query('ALTER TABLE accounts ADD COLUMN key_code VARCHAR(32) NULL');
  }
  if (!(await hasCol('accounts', 'device_limit'))) {
    await pool.query('ALTER TABLE accounts ADD COLUMN device_limit INT NOT NULL DEFAULT 3');
  }
  if (!(await hasCol('accounts', 'current_server'))) {
    await pool.query("ALTER TABLE accounts ADD COLUMN current_server VARCHAR(50) NOT NULL DEFAULT ''");
  }
  if (!(await hasCol('accounts', 'allow_sync_server'))) {
    await pool.query('ALTER TABLE accounts ADD COLUMN allow_sync_server TINYINT NOT NULL DEFAULT 0');
  }
  if (!(await hasCol('app_settings', 'key_help_md'))) {
    await pool.query('ALTER TABLE app_settings ADD COLUMN key_help_md MEDIUMTEXT NULL');
    await pool.query('UPDATE app_settings SET key_help_md = ? WHERE id = 1 AND (key_help_md IS NULL OR key_help_md = ?)', [DEFAULT_KEY_HELP_MD, '']);
  }
  if (!(await hasCol('app_settings', 'token_help_md'))) {
    await pool.query('ALTER TABLE app_settings ADD COLUMN token_help_md MEDIUMTEXT NULL');
    await pool.query('UPDATE app_settings SET token_help_md = ? WHERE id = 1 AND (token_help_md IS NULL OR token_help_md = ?)', [DEFAULT_TOKEN_HELP_MD, '']);
  }
  if (!(await hasCol('app_settings', 'key_required_at'))) {
    await pool.query(`ALTER TABLE app_settings ADD COLUMN key_required_at VARCHAR(19) NOT NULL DEFAULT '${DEFAULT_KEY_REQUIRED_AT}'`);
  }

  if (!(await hasCol('price_history', 'account_id'))) {
    await pool.query('ALTER TABLE price_history ADD COLUMN account_id INT NOT NULL DEFAULT 0 FIRST');
    await pool.query(`UPDATE price_history SET account_id = ${legacyAccount}`);
  }
  await tryQuery('ALTER TABLE price_history DROP KEY idx_history_scope');
  await pool.query('ALTER TABLE price_history ADD KEY idx_history_scope (account_id, server_id, city_id, created_at)');

  if (!(await hasCol('prices', 'account_id'))) {
    await tryQuery('ALTER TABLE prices DROP KEY uk_prices_scope');
    await pool.query('ALTER TABLE prices ADD COLUMN account_id INT NOT NULL DEFAULT 0 FIRST');
    await pool.query(`UPDATE prices SET account_id = ${legacyAccount}`);
    await pool.query('ALTER TABLE prices ADD UNIQUE KEY uk_prices_scope (account_id, server_id, city_id, commodity_id)');
    await tryQuery('ALTER TABLE prices DROP KEY idx_prices_lookup');
    await pool.query('ALTER TABLE prices ADD KEY idx_prices_lookup (account_id, server_id, city_id, commodity_id)');
  }

  if (!(await hasCol('city_taxes', 'account_id'))) {
    // 旧主键 (server_id, city_id) 同时支撑外键，必须先解除外键再改主键
    const [cityTaxFks] = await pool.query(
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'city_taxes' AND CONSTRAINT_TYPE = 'FOREIGN KEY'`
    );
    for (const fk of cityTaxFks) {
      const name = String(fk.name).replace(/`/g, '``');
      await pool.query(`ALTER TABLE city_taxes DROP FOREIGN KEY \`${name}\``);
    }
    await pool.query('ALTER TABLE city_taxes DROP PRIMARY KEY, ADD COLUMN account_id INT NOT NULL DEFAULT 0 FIRST, ADD PRIMARY KEY (account_id, server_id, city_id)');
    await pool.query(`UPDATE city_taxes SET account_id = ${legacyAccount}`);
  }
  const [existingCityTaxFks] = await pool.query(
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'city_taxes'
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND CONSTRAINT_NAME IN ('fk_city_taxes_server', 'fk_city_taxes_city')`
  );
  const cityTaxFkNames = new Set(existingCityTaxFks.map(fk => fk.name));
  if (!cityTaxFkNames.has('fk_city_taxes_server')) {
    await pool.query('ALTER TABLE city_taxes ADD CONSTRAINT fk_city_taxes_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE');
  }
  if (!cityTaxFkNames.has('fk_city_taxes_city')) {
    await pool.query('ALTER TABLE city_taxes ADD CONSTRAINT fk_city_taxes_city FOREIGN KEY (city_id) REFERENCES dict_items(id) ON DELETE CASCADE');
  }

  if (!(await hasCol('sync_settings', 'account_id'))) {
    let legacy = null;
    try {
      const [rows] = await pool.query('SELECT * FROM sync_settings WHERE id = 1');
      legacy = rows[0] || null;
    } catch { legacy = null; }
    await pool.query('RENAME TABLE sync_settings TO sync_settings_legacy');
    await pool.query(`CREATE TABLE sync_settings (
      account_id INT PRIMARY KEY,
      enabled TINYINT NOT NULL DEFAULT 0,
      cron_expr VARCHAR(64) NOT NULL DEFAULT '0 */2 * * *',
      server_name VARCHAR(50) NOT NULL DEFAULT '',
      server_override VARCHAR(50) NOT NULL DEFAULT '',
      operator VARCHAR(20) NOT NULL DEFAULT '定时同步',
      last_run_at DATETIME NULL,
      last_status VARCHAR(16) NULL,
      last_message VARCHAR(500) NULL,
      CONSTRAINT fk_sync_settings_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    if (legacy && Number(legacy.token_account_id) > 0) {
      const [ownerRows] = await pool.query('SELECT id FROM accounts WHERE id = ?', [Number(legacy.token_account_id)]);
      if (ownerRows[0]) {
        await pool.query(`INSERT IGNORE INTO sync_settings
          (account_id, enabled, cron_expr, server_name, operator, last_run_at, last_status, last_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ownerRows[0].id, legacy.enabled ? 1 : 0, legacy.cron_expr || '0 */2 * * *',
          legacy.server_name || '', legacy.operator || '定时同步',
          legacy.last_run_at || null, legacy.last_status || null, legacy.last_message || null]);
      }
    }
    await pool.query('DROP TABLE sync_settings_legacy');
  }
  if (!(await hasCol('sync_settings', 'server_override'))) {
    await pool.query("ALTER TABLE sync_settings ADD COLUMN server_override VARCHAR(50) NOT NULL DEFAULT ''");
  }

  if (!(await hasCol('sync_log', 'account_id'))) {
    await pool.query('ALTER TABLE sync_log ADD COLUMN account_id INT NULL AFTER id');
    await pool.query('ALTER TABLE sync_log ADD KEY idx_sync_log_account (account_id, id)');
  }
}

async function seed() {
  const row = await rawQuery('SELECT COUNT(*) AS n FROM dict_items');
  if (!Number(row[0].n)) {
    for (let i = 0; i < CITY_LIST.length; i++) {
      await rawRun(
        'INSERT INTO dict_items (type, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['city', CITY_LIST[i], i + 1, nowText(), nowText()]
      );
    }
    for (let i = 0; i < COMMODITY_SEED.length; i++) {
      const c = COMMODITY_SEED[i];
      await rawRun(
        'INSERT INTO dict_items (type, name, sort_order, burden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['commodity', c.name, i + 1, c.burden, nowText(), nowText()]
      );
    }
  }
  await ensureCommoditiesWithBurden();
  await seedCityNodes();
  await trimHistory();
  if (IS_MYSQL) {
    await rawRun(
      `INSERT IGNORE INTO app_settings
         (id, registration_enabled, announcement, key_help_md, token_help_md, key_required_at, default_device_limit, updated_at)
       VALUES (1, 1, ?, ?, ?, ?, 3, ?)`,
      ['', DEFAULT_KEY_HELP_MD, DEFAULT_TOKEN_HELP_MD, DEFAULT_KEY_REQUIRED_AT, nowText()]
    );
  } else {
    await rawRun(
      `INSERT OR IGNORE INTO app_settings
         (id, registration_enabled, announcement, key_help_md, token_help_md, key_required_at, default_device_limit, updated_at)
       VALUES (1, 1, ?, ?, ?, ?, 3, ?)`,
      ['', DEFAULT_KEY_HELP_MD, DEFAULT_TOKEN_HELP_MD, DEFAULT_KEY_REQUIRED_AT, nowText()]
    );
  }
}

async function ensureCommoditiesWithBurden() {
  const names = COMMODITY_SEED.map(c => c.name);
  const placeholders = names.map(() => '?').join(',');
  for (let i = 0; i < COMMODITY_SEED.length; i++) {
    const c = COMMODITY_SEED[i];
    const row = await rawQuery(
      "SELECT id, burden FROM dict_items WHERE type = 'commodity' AND name = ?",
      [c.name]
    );
    if (row.length) {
      if (Number(row[0].burden) !== c.burden) {
        await rawRun('UPDATE dict_items SET burden = ?, sort_order = ? WHERE id = ?', [c.burden, i + 1, row[0].id]);
      }
    } else {
      await rawRun(
        'INSERT INTO dict_items (type, name, sort_order, burden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['commodity', c.name, i + 1, c.burden, nowText(), nowText()]
      );
    }
  }
  const extras = await rawQuery(
    `SELECT id FROM dict_items WHERE type = 'commodity' AND name NOT IN (${placeholders})
      ORDER BY sort_order, id`,
    names
  );
  for (let i = 0; i < extras.length; i++) {
    await rawRun('UPDATE dict_items SET sort_order = ? WHERE id = ?', [names.length + i + 1, extras[i].id]);
  }
}

/** 城池坐标（用于路线体力估算与展示），来源 server/game/data/city_map.json */
async function seedCityNodes() {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(nodePath.join(__dirname, 'game', 'data', 'city_map.json'), 'utf8'));
  } catch { return; }
  const t = nowText();
  for (const c of list) {
    const existing = await rawQuery('SELECT city_name FROM city_nodes WHERE city_name = ?', [c.name]);
    const vals = [c.cfgName || c.name, c.nodeNo ?? null, c.metaId ?? null, c.gridX ?? null, c.gridY ?? null, t, c.name];
    if (existing.length) {
      await rawRun(
        'UPDATE city_nodes SET cfg_name = ?, node_no = ?, meta_id = ?, grid_x = ?, grid_y = ?, updated_at = ? WHERE city_name = ?',
        vals
      );
    } else {
      await rawRun(
        `INSERT INTO city_nodes (cfg_name, node_no, meta_id, grid_x, grid_y, updated_at, city_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        vals
      );
    }
  }
}

/** 历史流水裁剪（保留最近 N 条） */
async function trimHistory() {
  const rows = await rawQuery('SELECT id FROM price_history ORDER BY id DESC LIMIT 1 OFFSET ?', [HISTORY_LIMIT]);
  if (!rows.length) return;
  await rawRun('DELETE FROM price_history WHERE id <= ?', [rows[0].id]);
}

/* ------------------------------ 便捷方法 ------------------------------ */

async function upsertServer(name) {
  const t = nowText();
  const existing = await rawQuery('SELECT id FROM servers WHERE name = ?', [name]);
  if (existing.length) {
    await rawRun('UPDATE servers SET updated_at = ? WHERE id = ?', [t, existing[0].id]);
    return existing[0].id;
  }
  try {
    const info = await rawRun('INSERT INTO servers (name, created_at, updated_at) VALUES (?, ?, ?)', [name, t, t]);
    return info.insertId;
  } catch (err) {
    const again = await rawQuery('SELECT id FROM servers WHERE name = ?', [name]);
    if (again.length) return again[0].id;
    throw err;
  }
}

async function findServerId(name) {
  if (name == null) return null;
  const r = await rawQuery('SELECT id FROM servers WHERE name = ?', [name]);
  return r.length ? r[0].id : null;
}

async function findDictId(type, name) {
  const r = await rawQuery('SELECT id FROM dict_items WHERE type = ? AND name = ?', [type, name]);
  return r.length ? r[0].id : null;
}

async function getCityTax(accountId, serverId, cityId) {
  if (serverId == null || cityId == null) return null;
  const r = await rawQuery(
    'SELECT tax FROM city_taxes WHERE account_id = ? AND server_id = ? AND city_id = ?',
    [Number(accountId) || 0, serverId, cityId]
  );
  return r.length ? Number(r[0].tax) : null;
}

async function getCityTaxMap(accountId, serverId) {
  if (serverId == null) return new Map();
  const rows = await rawQuery(
    'SELECT city_id AS cityId, tax FROM city_taxes WHERE account_id = ? AND server_id = ?',
    [Number(accountId) || 0, serverId]
  );
  return new Map(rows.map(r => [Number(r.cityId), Number(r.tax)]));
}

/** 记录/更新城池税率（游戏同步写入，0.1~0.9） */
async function setCityTax(accountId, serverId, cityId, tax) {
  const value = Number(tax);
  if (!Number.isFinite(value) || value <= 0 || value > 1) return;
  const acc = Number(accountId) || 0;
  const t = nowText();
  const existing = await rawQuery(
    'SELECT tax FROM city_taxes WHERE account_id = ? AND server_id = ? AND city_id = ?',
    [acc, serverId, cityId]
  );
  if (existing.length) {
    await rawRun(
      'UPDATE city_taxes SET tax = ?, updated_at = ? WHERE account_id = ? AND server_id = ? AND city_id = ?',
      [value, t, acc, serverId, cityId]
    );
  } else {
    try {
      await rawRun(
        'INSERT INTO city_taxes (account_id, server_id, city_id, tax, updated_at) VALUES (?, ?, ?, ?, ?)',
        [acc, serverId, cityId, value, t]
      );
    } catch {
      await rawRun(
        'UPDATE city_taxes SET tax = ?, updated_at = ? WHERE account_id = ? AND server_id = ? AND city_id = ?',
        [value, t, acc, serverId, cityId]
      );
    }
  }
}

function normalizeKeyRequiredAt(value) {
  const s = String(value || '').trim().replace('T', ' ');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const hh = m[4] || '00';
  const mi = m[5] || '00';
  const ss = m[6] || '00';
  if (Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${hh}:${mi}:${ss}`;
}

function keyRequiredAtNow(value) {
  const at = normalizeKeyRequiredAt(value) || DEFAULT_KEY_REQUIRED_AT;
  return at <= nowText();
}

/** 全站设置（注册开关 / 公告 / 卡密帮助 / 默认设备数） */
async function getAppSettings() {
  let row = await get('SELECT * FROM app_settings WHERE id = 1');
  if (!row) {
    await run(
      `INSERT INTO app_settings
         (id, registration_enabled, announcement, key_help_md, token_help_md, key_required_at, default_device_limit, updated_at)
       VALUES (1, 1, ?, ?, ?, ?, 3, ?)`,
      ['', DEFAULT_KEY_HELP_MD, DEFAULT_TOKEN_HELP_MD, DEFAULT_KEY_REQUIRED_AT, nowText()]
    );
    row = await get('SELECT * FROM app_settings WHERE id = 1');
  }
  const keyRequiredAt = normalizeKeyRequiredAt(row.key_required_at) || DEFAULT_KEY_REQUIRED_AT;
  return {
    registrationEnabled: !!Number(row.registration_enabled),
    announcement: row.announcement || '',
    keyHelpMd: row.key_help_md || '',
    tokenHelpMd: row.token_help_md || '',
    keyRequiredAt,
    keyRequired: keyRequiredAtNow(keyRequiredAt),
    defaultDeviceLimit: Math.max(1, Math.min(Number(row.default_device_limit) || 3, 20)),
  };
}

async function setCurrentServer(accountId, name) {
  await run(
    'UPDATE accounts SET current_server = ?, updated_at = ? WHERE id = ?',
    [name || '', nowText(), accountId]
  );
}

/** 全站首个账号注册时接管旧版共享数据（account_id = 0） */
async function claimLegacyData(accountId) {
  const total = await get('SELECT COUNT(*) AS n FROM accounts');
  if (Number(total.n) !== 1) return false;
  const legacyPrices = await get('SELECT COUNT(*) AS n FROM prices WHERE account_id = 0');
  const legacyHistory = await get('SELECT COUNT(*) AS n FROM price_history WHERE account_id = 0');
  if (!Number(legacyPrices.n) && !Number(legacyHistory.n)) return false;
  await tx(async conn => {
    await conn.run('UPDATE prices SET account_id = ? WHERE account_id = 0', [accountId]);
    await conn.run('UPDATE price_history SET account_id = ? WHERE account_id = 0', [accountId]);
    await conn.run('UPDATE city_taxes SET account_id = ? WHERE account_id = 0', [accountId]);
    await conn.run('UPDATE sync_log SET account_id = ? WHERE account_id IS NULL OR account_id = 0', [accountId]);
  });
  return true;
}

async function createDictItem(type, name, burden = null) {
  const maxSortRow = await rawQuery(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM dict_items WHERE type = ?',
    [type]
  );
  const t = nowText();
  const info = await rawRun(
    'INSERT INTO dict_items (type, name, sort_order, burden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [type, name, Number(maxSortRow[0].m) + 1, burden == null || burden === '' ? null : Number(burden), t, t]
  );
  return get('SELECT * FROM dict_items WHERE id = ?', [info.insertId]);
}

/** 关闭连接（优雅退出、脚本自检使用） */
async function close() {
  if (IS_MYSQL) {
    if (pool) {
      const p = pool;
      pool = null;
      try { await p.end(); } catch { /* ignore */ }
    }
  } else if (sqlite) {
    try { sqlite.close(); } catch { /* ignore */ }
    sqlite = null;
  }
  initPromise = null;
}

module.exports = {
  IS_MYSQL,
  DRIVER,
  DB_FILE,
  DATA_DIR,
  HISTORY_LIMIT,
  DEFAULT_KEY_REQUIRED_AT,
  normalizeKeyRequiredAt,
  keyRequiredAtNow,
  ready: init,
  init,
  close,
  query,
  get,
  run,
  tx,
  nowText,
  formatTime,
  parseTime,
  upsertServer,
  findServerId,
  findDictId,
  getCityTax,
  getCityTaxMap,
  setCityTax,
  getAppSettings,
  setCurrentServer,
  claimLegacyData,
  createDictItem,
  COMMODITY_LIST: COMMODITY_SEED.map(c => c.name),
  CITY_LIST,
};
