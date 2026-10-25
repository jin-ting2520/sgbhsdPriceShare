'use strict';

/**
 * 工具（SgbhsdTool）SSO 入口：不走会话 HMAC 签名，自行校验一次性票据。
 *
 *   POST /api/sso/tool-login   { ticket, deviceId, deviceName, deviceMeta }  scope=login
 *   POST /api/sso/game-meta    ticket（body 或 x-sso-ticket 头）              scope=ingest
 *   POST /api/sso/game-ingest  { ticket, server, roleId, syncedAt, cities, news } scope=ingest
 *
 * 账号规则：同一 (sso_source='sgbhsd-tool', sso_subject=ticket.sub) 永远映射到同一个价格站账号；
 * 昵称取工具昵称（重名自动加 _2/_3…），到期时间严格跟随工具授权（accountExpiresAt），
 * 密码为随机不可用值（SSO 账号只能用票据登录），默认权限：看/录价格 + 看主账号价格。
 *
 * 写权限边界（安全修复 F1）：game-ingest 永远只写当前 SSO 账号自身，绝不代写他人（含区服主账号）；
 * 仅当该账号本身被管理员设为该区服主账号时，才按主账号共享广播（scope='master'）。
 */

const express = require('express');
const crypto = require('node:crypto');

const { ok, fail, asyncHandler, cleanName, parsePrice, isUniqueConstraintError } = require('../util');
const {
  get, run, nowText, formatTime, parseTime, upsertServer, findDictId,
  setCityTax, saveCityEvents, setCurrentServer,
} = require('../db');
const {
  normalizeDeviceMeta, deviceFingerprint, resolveDeviceId,
  ensureDevice, createSession, countDevices, removeDevice, accountBlocked,
} = require('../auth');
const { publicAccount } = require('../account-view');
const { broadcast, closeSessions } = require('../ws');
const { getServerMaster, notifyMasterPriceChange } = require('../master');
const { saveCityProducts } = require('../game/price-save');
const { CITY_MAP, ensureCityId, productName, newsCity, newsTimeMs } = require('../game/sync');
const { invalidateDict } = require('../dict-cache');
const rateLimit = require('../ratelimit');
const sso = require('../sso');

const router = express.Router();

const SSO_SOURCE = 'sgbhsd-tool';
const SSO_ACCOUNT_NAME_FALLBACK = '工具用户';
const SSO_OPERATOR = '工具同步';
const MAX_CITIES = 200;
const MAX_PRODUCTS_PER_CITY = 300;
const MAX_NEWS = 2000;
const MAX_NAME_LEN = 20;
const MAX_SERVER_LEN = 50;

/** 同一账号 ingest 最小间隔（毫秒）：避免工具侧重试风暴刷库；环境变量便于测试关闭 */
function ingestMinIntervalMs() {
  const raw = process.env.SSO_INGEST_MIN_INTERVAL_MS;
  if (raw == null || raw === '') return 10 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : 10 * 1000;
}

const CITY_BY_NAME = new Map(CITY_MAP.map(c => [c.name, c]));

/* ------------------------------ 票据读取 ------------------------------ */

/** ticket 可放 body.ticket 或请求头 x-sso-ticket（game-meta 无 body 时用头） */
function readTicket(req) {
  const body = req.body || {};
  const fromBody = typeof body.ticket === 'string' ? body.ticket.trim() : '';
  const fromHeader = String(req.get('x-sso-ticket') || '').trim();
  return fromBody || fromHeader;
}

/** 统一处理验签失败 */
function rejectTicket(res, error) {
  return fail(res, error.status, error.message, error.code);
}

/* ------------------------------ 账号绑定 ------------------------------ */

/** 随机不可用密码：不是 scrypt$ 格式，verifyPassword 永远返回 false */
function unusablePasswordHash() {
  return `sso$${crypto.randomBytes(32).toString('hex')}`;
}

/** 票据里的到期时间（ISO / YYYY-MM-DD HH:mm:ss / null=永久）→ 数据库文本 */
function normalizeAccountExpiry(value) {
  if (value == null || value === '') return { value: null };
  const ms = parseTime(String(value));
  if (!Number.isFinite(ms)) return { error: '票据中的账号到期时间格式不正确' };
  return { value: formatTime(ms) };
}

async function findSsoAccount(subject) {
  return get('SELECT * FROM accounts WHERE sso_source = ? AND sso_subject = ?', [SSO_SOURCE, subject]);
}

/** 昵称 = 工具昵称（≤20），已被占用时依次加 _2、_3…（保留后缀长度，避免超长） */
async function allocateAccountName(baseName) {
  const clean = cleanName(baseName, MAX_NAME_LEN) || SSO_ACCOUNT_NAME_FALLBACK;
  for (let i = 1; i <= 60; i += 1) {
    const suffix = i === 1 ? '' : `_${i}`;
    const candidate = `${clean.slice(0, MAX_NAME_LEN - suffix.length)}${suffix}`;
    // 两边驱动的 name 唯一约束都是大小写不敏感排序规则，直接等值查询即可
    // eslint-disable-next-line no-await-in-loop
    if (!(await get('SELECT id FROM accounts WHERE name = ?', [candidate]))) return candidate;
  }
  return `tool_${crypto.randomBytes(4).toString('hex')}`;
}

/** 按绑定创建账号；并发下靠唯一索引兜底，冲突则重新读取绑定 */
async function createSsoAccount(ticket, expiryValue) {
  const passwordHash = unusablePasswordHash();
  const t = nowText();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const name = await allocateAccountName(ticket.name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const info = await run(
        `INSERT INTO accounts (name, password_hash, relief, status, expires_at, key_code, device_limit,
                               current_server, allow_sync_server, view_master_prices, allow_master_prices,
                               sso_source, sso_subject, created_at, updated_at)
         VALUES (?, ?, 5, 'active', ?, NULL, 3, '', 0, 1, 1, ?, ?, ?, ?)`,
        [name, passwordHash, expiryValue, SSO_SOURCE, ticket.sub, t, t]
      );
      // eslint-disable-next-line no-await-in-loop
      const row = await get('SELECT * FROM accounts WHERE id = ?', [info.insertId]);
      return { row, created: true };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // eslint-disable-next-line no-await-in-loop
      const bound = await findSsoAccount(ticket.sub);
      if (bound) return { row: bound, created: false };
    }
  }
  throw Object.assign(new Error('创建工具账号失败，请稍后重试'), { status: 500 });
}

/** 查找/创建绑定账号，并同步到期时间（昵称不覆盖） */
async function resolveSsoAccount(ticket) {
  const expiry = normalizeAccountExpiry(ticket.accountExpiresAt);
  if (expiry.error) return { error: expiry.error };
  const existing = await findSsoAccount(ticket.sub);
  if (!existing) return createSsoAccount(ticket, expiry.value);
  const current = existing.expires_at == null ? null : String(existing.expires_at);
  if (current === expiry.value) return { row: existing, created: false };
  await run('UPDATE accounts SET expires_at = ?, updated_at = ? WHERE id = ?', [expiry.value, nowText(), existing.id]);
  return { row: { ...existing, expires_at: expiry.value }, created: false };
}

/** 设备记录超上限时移除最久未使用的记录（工具窗口可能来自多台机器，避免登录被 409 卡住） */
async function ensureDeviceSlot(accountId, deviceId, limit) {
  const known = await get(
    'SELECT id FROM account_devices WHERE account_id = ? AND device_id = ?',
    [accountId, deviceId]
  );
  if (known) return;
  let used = await countDevices(accountId);
  while (used >= limit) {
    // eslint-disable-next-line no-await-in-loop
    const oldest = await get(
      `SELECT id FROM account_devices WHERE account_id = ?
        ORDER BY COALESCE(last_seen_at, created_at) ASC, id ASC`,
      [accountId]
    );
    if (!oldest) return;
    // eslint-disable-next-line no-await-in-loop
    const removed = await removeDevice(accountId, oldest.id);
    closeSessions(removed.sessionIds);
    used -= 1;
  }
}

/* ------------------------------ POST /api/sso/tool-login ------------------------------ */

router.post('/tool-login', rateLimit.middleware(60, 5 * 60 * 1000), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const verified = sso.verifyTicket(readTicket(req), 'login');
  if (verified.error) return rejectTicket(res, verified.error);
  const ticket = verified.payload;

  const resolved = await resolveSsoAccount(ticket);
  if (resolved.error) return fail(res, 400, resolved.error, 40021);
  const { row, created } = resolved;
  const blocked = accountBlocked(row);
  if (blocked) return fail(res, blocked.status, blocked.message, blocked.code);

  const deviceMeta = normalizeDeviceMeta(body.deviceMeta);
  const fingerprint = deviceFingerprint(deviceMeta, req.get('user-agent'));
  const deviceId = resolveDeviceId(body.deviceId, fingerprint)
    || `sso-${crypto.randomBytes(8).toString('hex')}`;
  const deviceName = String(body.deviceName || deviceMeta.platform || '工具窗口').trim().slice(0, 80);
  const limit = Math.max(1, Number(row.device_limit) || 3);
  await ensureDeviceSlot(row.id, deviceId, limit);

  const device = await ensureDevice(row.id, {
    deviceId, fingerprint, deviceName, platform: deviceMeta.platform, ip: req.ip,
  });
  const session = await createSession(row.id, {
    deviceId, deviceRefId: device.id, deviceName: device.deviceName || deviceName, ip: req.ip,
  });

  return ok(res, await publicAccount(row, created, session, { deviceId }));
}));

/* ------------------------------ POST /api/sso/game-meta ------------------------------ */

router.post('/game-meta', rateLimit.middleware(120, 5 * 60 * 1000), asyncHandler(async (req, res) => {
  const verified = sso.verifyTicket(readTicket(req), 'ingest');
  if (verified.error) return rejectTicket(res, verified.error);
  const ticket = verified.payload;
  // W3：票据只证明「工具授权有效」，还必须确认价格站侧账号已绑定且未被封禁/未到期
  const account = await findSsoAccount(ticket.sub);
  if (!account) return fail(res, 401, 'SSO 账号尚未绑定价格站账号，请先打开价格站完成登录', 40140);
  const blocked = accountBlocked(account);
  if (blocked) return fail(res, blocked.status, blocked.message, blocked.code);
  return ok(res, {
    ticketUser: {
      sub: ticket.sub,
      name: ticket.name,
      accountName: account.name,
    },
    total: CITY_MAP.length,
    cities: CITY_MAP.map(c => ({ name: c.name, nodeNo: c.nodeNo, metaId: c.metaId })),
  });
}));

/* ------------------------------ POST /api/sso/game-ingest ------------------------------ */

/**
 * 写入范围（安全边界，F1）：ingest **永远写当前 SSO 账号自身**，绝不代写他人账号（含区服主账号）。
 * 这里只返回广播/共享范围：仅当该账号本身就是该区服主账号时为 'master'（主账号共享按既有语义生效），
 * 否则为 'self'（只广播给账号自己的在线会话）。已删除 SSO_INGEST_TARGET 跨账号写能力。
 */
async function resolveIngestScope(account, server) {
  const master = await getServerMaster(server);
  return master && Number(master.id) === Number(account.id) ? 'master' : 'self';
}

/** 游戏内城池名 → 字典 id（缺失自动登记，与游戏直连同步一致） */
async function resolveCityId(name) {
  const mapped = CITY_BY_NAME.get(name);
  if (!mapped) return null;
  const { id, created } = await ensureCityId(name);
  return id ? { id, created } : null;
}

/** cities[i].products[] → saveCityProducts 入参 */
function buildProductRows(products, failed, cityName) {
  const rows = [];
  for (const raw of Array.isArray(products) ? products.slice(0, MAX_PRODUCTS_PER_CITY) : []) {
    const commodity = cleanName(raw && raw.name, MAX_NAME_LEN);
    if (!commodity) continue;
    const buy = parsePrice(raw && raw.buy);
    const sell = parsePrice(raw && raw.sell);
    if (!buy.ok || !sell.ok) {
      failed.push({ city: cityName, error: `「${commodity}」价格不合法` });
      continue;
    }
    rows.push({ commodity, buy: buy.value, sell: sell.value });
  }
  return rows;
}

/** 2136 大事件：优先用已解析的 city/commodity，回退按 capitalId/productId 映射 */
async function buildEventRows(news, server, nowMs) {
  const numericServer = /^\d+$/.test(server);
  const base = numericServer ? BigInt(server) * 100000000000n : 0n;
  const rows = [];
  const seen = new Set();
  for (const raw of Array.isArray(news) ? news.slice(0, MAX_NEWS) : []) {
    if (!raw) continue;
    let cityName = cleanName(raw.city, MAX_NAME_LEN);
    let commodity = cleanName(raw.commodity, MAX_NAME_LEN);
    if ((!cityName || !commodity) && raw.capitalId != null && raw.productId != null) {
      const city = newsCity(raw.capitalId, base);
      if (city) cityName = city.name;
      const mapped = productName(Number(raw.productId));
      if (mapped) commodity = mapped;
    }
    if (!cityName || !commodity) continue;

    const startMs = newsTimeMs(raw.startTime) || nowMs;
    const endMs = newsTimeMs(raw.endTime);
    if (endMs && endMs <= nowMs) continue;          // 已结束的事件不再写入
    if (endMs && endMs <= startMs) continue;
    const metaId = (String(raw.metaId || '').trim()
      || `news:${raw.capitalId}:${raw.startTime}:${raw.endTime}`).slice(0, 128);
    const key = `${cityName}|${commodity}|${metaId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // eslint-disable-next-line no-await-in-loop
    const city = await resolveCityId(cityName);
    if (!city) continue;
    // eslint-disable-next-line no-await-in-loop
    const commodityId = await findDictId('commodity', commodity);
    if (!commodityId) continue;
    rows.push({
      cityId: city.id,
      commodityId,
      metaId,
      startsAt: formatTime(startMs),
      endsAt: endMs ? formatTime(endMs) : null,
    });
  }
  return rows;
}

router.post('/game-ingest', rateLimit.middleware(30, 5 * 60 * 1000), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const verified = sso.verifyTicket(readTicket(req), 'ingest');
  if (verified.error) return rejectTicket(res, verified.error);
  const ticket = verified.payload;

  // 区服：清洗（压缩空白/trim）后必须 1-50 字符；超长直接拒绝而不是静默截断。
  // 任意区服值都只影响本账号自身的价格数据（F1 修复后不再有跨账号写入）。
  const rawServer = typeof body.server === 'string'
    ? body.server
    : (body.server == null ? '' : String(body.server));
  const server = cleanName(rawServer, MAX_SERVER_LEN);
  if (!server) return fail(res, 400, '请提供区服（server）', 40022);
  if (rawServer.replace(/\s+/g, ' ').trim().length > MAX_SERVER_LEN) {
    return fail(res, 400, `区服名称过长（最多 ${MAX_SERVER_LEN} 个字符）`, 40025);
  }
  const cities = Array.isArray(body.cities) ? body.cities : [];
  const news = Array.isArray(body.news) ? body.news : [];
  if (!cities.length && !news.length) return fail(res, 400, '没有需要写入的价格数据', 40023);
  if (cities.length > MAX_CITIES) return fail(res, 400, `单次最多写入 ${MAX_CITIES} 个城池`, 40024);

  const resolved = await resolveSsoAccount(ticket);
  if (resolved.error) return fail(res, 400, resolved.error, 40021);
  const account = resolved.row;
  const blocked = accountBlocked(account);
  if (blocked) return fail(res, blocked.status, blocked.message, blocked.code);
  const minInterval = ingestMinIntervalMs();
  if (minInterval > 0 && !rateLimit.allow(`sso-ingest:${account.id}`, 1, minInterval)) {
    return fail(res, 429, '同步过于频繁，请稍后再试', 42901);
  }

  const serverId = await upsertServer(server);
  const scope = await resolveIngestScope(account, server);
  const accountId = Number(account.id);
  const operator = cleanName(body.operator, MAX_NAME_LEN) || SSO_OPERATOR;
  const at = nowText();
  const nowMs = Date.now();

  const result = {
    server,
    scope,
    accountId,
    cities: 0,
    saved: 0,
    created: 0,
    updated: 0,
    events: 0,
    newCities: [],
    failed: [],
    syncedAt: at,
  };
  const changedCities = [];

  for (const raw of cities) {
    // eslint-disable-next-line no-await-in-loop
    const cityName = cleanName(raw && raw.name, MAX_NAME_LEN);
    if (!cityName) continue;
    // eslint-disable-next-line no-await-in-loop
    const city = await resolveCityId(cityName);
    if (!city) {
      result.failed.push({ city: cityName, error: '不在城池映射表中' });
      continue;
    }
    if (city.created) result.newCities.push(cityName);

    const tax = raw && raw.tax == null ? null : Number(raw && raw.tax);
    if (Number.isFinite(tax) && tax > 0 && tax <= 1) {
      // eslint-disable-next-line no-await-in-loop
      await setCityTax(accountId, serverId, city.id, tax);
    }

    const rows = buildProductRows(raw && raw.products, result.failed, cityName);
    const commodityRows = [];
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const commodityId = await findDictId('commodity', row.commodity);
      if (!commodityId) {
        result.failed.push({ city: cityName, error: `商品「${row.commodity}」不在字典中` });
        continue;
      }
      commodityRows.push({ commodityId, commodity: row.commodity, buy: row.buy, sell: row.sell });
    }
    if (!commodityRows.length) {
      if (!rows.length) result.failed.push({ city: cityName, error: '该城池没有商品数据' });
      else result.cities += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const stat = await saveCityProducts({
      accountId,
      serverId,
      cityId: city.id,
      rows: commodityRows,
      operator,
      at,
    });
    result.cities += 1;
    result.saved += stat.saved;
    result.created += stat.created;
    result.updated += stat.updated;
    if (stat.saved) {
      changedCities.push({
        city: cityName,
        tax: Number.isFinite(tax) ? tax : null,
        items: commodityRows.map(row => ({
          commodityId: row.commodityId, commodity: row.commodity, buy: row.buy, sell: row.sell, updatedAt: at, operator,
        })),
      });
    }
  }

  if (news.length) {
    const eventRows = await buildEventRows(news, server, nowMs);
    if (eventRows.length) result.events = await saveCityEvents(serverId, eventRows);
  }

  await setCurrentServer(account.id, server);
  if (result.newCities.length) await invalidateDict();
  if (changedCities.length) {
    // 实时刷新：仅推给当前账号自己的在线会话（不会污染其他账号）
    for (const city of changedCities) {
      broadcast('price.updated', {
        server, city: city.city, operator, tax: city.tax, items: city.items, source: 'tool-sync',
      }, { accountId });
    }
    // 仅当本账号就是该区服主账号时，才按「主账号共享」推给开启共享的查看者
    if (scope === 'master') {
      await notifyMasterPriceChange(accountId, { server, city: '', operator, tax: null, items: [] });
    }
  }

  return ok(res, result);
}));

module.exports = router;
