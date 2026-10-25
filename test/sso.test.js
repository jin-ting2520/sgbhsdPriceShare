'use strict';

/** 工具 SSO 测试：票据验签 / 一次性 / scope / 自动建号与后缀 / 到期跟随 / game-meta / game-ingest */

const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const BASE_FILE = nodePath.join(os.tmpdir(), `price-sso-test-${process.pid}-${Date.now()}.db`);
process.env.PRICE_DB = BASE_FILE;
process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.TOOL_SSO_SECRET = 'test-sso-secret-0123456789abcdef';
process.env.SSO_INGEST_MIN_INTERVAL_MS = '0';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(BASE_FILE + suffix); } catch { /* ignore */ }
}

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const app = require('../server');
const db = require('../server/db');
const sso = require('../server/sso');
const { createClient, createAdmin, registerAccount } = require('./helpers');

const SECRET = process.env.TOOL_SSO_SECRET;
let server;
let base = '';
let admin;

before(async () => {
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = createAdmin(base);
  assert.equal((await admin.login()).status, 200);
});

after(async () => {
  require('../server/scheduler').stop();
  await new Promise(res => server.close(res));
  await db.close().catch(() => {});
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(BASE_FILE + suffix); } catch { /* ignore */ }
  }
});

/* ------------------------------ 辅助 ------------------------------ */

let subSeq = 0;
const nextSubject = () => `tool-user-${++subSeq}-${crypto.randomBytes(3).toString('hex')}`;

/** 生成票据；now 可回拨来模拟过期。默认昵称/主体带序号，避免用例之间互相占用昵称 */
function makeTicket(overrides = {}, { secret = SECRET, now = Date.now() } = {}) {
  const seq = subSeq + 1;
  return sso.buildTicket({
    scope: 'login',
    sub: nextSubject(),
    name: `工具账号${seq}`,
    accountExpiresAt: null,
    ...overrides,
  }, { secret, now });
}

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

const login = (ticket, extra = {}) => post('/api/sso/tool-login', {
  ticket, deviceId: `sso-dev-${crypto.randomBytes(4).toString('hex')}`, deviceName: '工具子窗口', ...extra,
});

/** 用 login 票据把 sub 绑定成价格站账号（返回 { account, client }） */
async function bindSubject({ sub = nextSubject(), name, accountExpiresAt = null } = {}) {
  const res = await login(makeTicket({ sub, name: name || `绑定账号${sub}`, accountExpiresAt }));
  assert.equal(res.status, 200, `绑定失败：${JSON.stringify(res.json)}`);
  const account = await db.get('SELECT * FROM accounts WHERE sso_subject = ?', [sub]);
  assert.ok(account, 'SSO 账号已创建');
  const client = createClient(base, { token: res.json.data.session, deviceId: res.json.data.deviceId });
  return { sub, account, client, data: res.json.data };
}

/** 打开本账号的 WebSocket（实时广播断言用），返回 { ws, messages } */
async function openWs(client) {
  const r = await client.post('/api/auth/ws-ticket', {});
  assert.equal(r.status, 200, `ws-ticket 失败：${JSON.stringify(r.json)}`);
  const url = `${base.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(r.json.data.ticket)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('WebSocket 打开超时'));
    }, 5000);
    ws.on('message', raw => {
      try { messages.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    ws.on('open', () => { clearTimeout(timer); resolve({ ws, messages }); });
    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

/** 在已收到的广播里等待匹配消息 */
function waitForMessage(messages, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = messages.find(predicate);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`未收到预期广播；已收到：${JSON.stringify(messages.map(m => m.type))}`));
      }
    }, 25);
  });
}

function closeWs(handle) {
  try { handle.ws.close(); } catch { /* ignore */ }
}

/* ------------------------------ 1. 票据校验 ------------------------------ */

test('票据校验：缺失 / 格式 / 签名 / 签发方 / 版本', async () => {
  const missing = await login('');
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 40020);

  const badFormat = await login('not-a-ticket');
  assert.equal(badFormat.status, 401);
  assert.equal(badFormat.json.code, 40120);

  // 篡改 payload 但沿用旧签名
  const ticket = makeTicket();
  const [payload] = ticket.split('.');
  const tampered = `${payload}.${'0'.repeat(64)}`;
  const tamperedRes = await login(tampered);
  assert.equal(tamperedRes.status, 401);
  assert.equal(tamperedRes.json.code, 40121);

  // 用错误密钥签名
  const wrongSecret = await login(makeTicket({}, { secret: 'another-secret' }));
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.json.code, 40121);

  const wrongIss = await login(makeTicket({ iss: 'someone-else' }));
  assert.equal(wrongIss.status, 401);
  assert.equal(wrongIss.json.code, 40124);

  const wrongAud = await login(makeTicket({ aud: 'another-app' }));
  assert.equal(wrongAud.status, 401);
  assert.equal(wrongAud.json.code, 40125);

  const oldVersion = await login(makeTicket({ v: 2 }));
  assert.equal(oldVersion.status, 401);
  assert.equal(oldVersion.json.code, 40123);

  // 缺 sub
  const noSub = await login(makeTicket({ sub: '' }));
  assert.equal(noSub.status, 401);
  assert.equal(noSub.json.code, 40130);
});

test('票据校验：过期 / 未生效 / 有效期过长', async () => {
  const expired = await login(makeTicket({}, { now: Date.now() - 120 * 1000 }));
  assert.equal(expired.status, 401);
  assert.equal(expired.json.code, 40129);

  const future = await login(makeTicket({}, { now: Date.now() + 300 * 1000 }));
  assert.equal(future.status, 401);
  assert.equal(future.json.code, 40128);

  const tooLong = await login(makeTicket({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  assert.equal(tooLong.status, 401);
  assert.equal(tooLong.json.code, 40127);
});

test('票据校验：nonce 一次性（重放拒绝）', async () => {
  const ticket = makeTicket();
  const first = await login(ticket);
  assert.equal(first.status, 200);

  const replay = await login(ticket);
  assert.equal(replay.status, 401);
  assert.equal(replay.json.code, 40133);
  assert.match(replay.json.message, /已使用|重新打开/);
});

test('票据校验：scope 不匹配时拒绝（login 票据不能 ingest）', async () => {
  const loginTicket = makeTicket({ scope: 'login' });
  const meta = await post('/api/sso/game-meta', { ticket: loginTicket });
  assert.equal(meta.status, 403);
  assert.equal(meta.json.code, 40320);

  // login 票据调 game-ingest 也必须是 403（在写库前拒绝）
  const ingestWithLogin = await post('/api/sso/game-ingest', {
    ticket: loginTicket, server: '138', cities: [{ name: '桂阳', products: [] }],
  });
  assert.equal(ingestWithLogin.status, 403, 'login scope 票据不能调 ingest');
  assert.equal(ingestWithLogin.json.code, 40320);

  // ingest 票据不能当登录票据
  const wrongLogin = await login(makeTicket({ scope: 'ingest' }));
  assert.equal(wrongLogin.status, 403);
  assert.equal(wrongLogin.json.code, 40320);
});

/* ------------------------------ 2. 自动建号 ------------------------------ */

test('tool-login：自动建号返回与会话登录一致的结构，并绑定 sso_subject', async () => {
  const subject = nextSubject();
  const ticket = makeTicket({ sub: subject, name: '工具甲', accountExpiresAt: null });
  const res = await login(ticket);
  assert.equal(res.status, 200);
  const data = res.json.data;
  assert.equal(data.created, true);
  assert.equal(data.name, '工具甲');
  assert.equal(data.sso, true);
  assert.match(data.session, /^[a-f0-9]{64}$/);
  assert.equal(data.token, '');
  assert.equal(data.expiresAt, null);
  assert.ok(data.deviceId);
  assert.equal(data.relief, 5);
  assert.equal(data.deviceLimit, 3);
  assert.equal(data.viewMasterPrices !== undefined, true);

  // 结构对齐密码登录：密码登录的字段在 SSO 返回里都存在
  const client = createClient(base, { token: data.session, deviceId: data.deviceId });
  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200, 'SSO 会话可直接用于签名接口');
  assert.equal(me.json.data.name, '工具甲');

  const rows = await db.query('SELECT id, sso_source, sso_subject FROM accounts WHERE sso_subject = ?', [subject]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sso_source, 'sgbhsd-tool');

  // 同一 sub 再登录：复用账号（用户名不变）
  const again = await login(makeTicket({ sub: subject, name: '工具甲改名' }));
  assert.equal(again.status, 200);
  assert.equal(again.json.data.created, false);
  assert.equal(again.json.data.name, '工具甲');
  assert.equal(again.json.data.session === data.session, false);
  const rows2 = await db.query('SELECT id FROM accounts WHERE sso_subject = ?', [subject]);
  assert.equal(rows2.length, 1, '同一 sub 不允许重复建号');
});

test('tool-login：昵称重复自动加 _2/_3，且长度不超过 20', async () => {
  // 抢占一个普通账号昵称
  await db.run(
    "INSERT INTO accounts (name, password_hash, status) VALUES (?, 'scrypt$00$00', 'active')",
    ['工具乙']
  );
  const second = await login(makeTicket({ name: '工具乙' }));
  assert.equal(second.status, 200);
  assert.equal(second.json.data.name, '工具乙_2');

  const third = await login(makeTicket({ name: '工具乙' }));
  assert.equal(third.status, 200);
  assert.equal(third.json.data.name, '工具乙_3');

  const longName = '很长的工具账号昵称一二三四五六七八九十';
  const longRes = await login(makeTicket({ name: longName }));
  assert.equal(longRes.status, 200);
  assert.ok(longRes.json.data.name.length <= 20, `昵称应裁剪到 20 字符，实际 ${longRes.json.data.name.length}`);
});

test('tool-login：到期时间跟随工具授权，到期/封禁拒绝登录', async () => {
  const subject = nextSubject();
  const futureText = '2030-06-30 12:00:00';
  const ok = await login(makeTicket({ sub: subject, accountExpiresAt: futureText }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.expiresAt, futureText);

  const row = await db.get('SELECT * FROM accounts WHERE sso_subject = ?', [subject]);
  assert.equal(String(row.expires_at), futureText);

  // 工具续期后同步到价格站（同一个 sub）
  const extended = '2031-01-01 00:00:00';
  const renew = await login(makeTicket({ sub: subject, accountExpiresAt: extended }));
  assert.equal(renew.status, 200);
  assert.equal(renew.json.data.expiresAt, extended);

  // 工具票据里已过期 → 40301
  const expired = await login(makeTicket({ sub: subject, accountExpiresAt: '2020-01-01 00:00:00' }));
  assert.equal(expired.status, 403);
  assert.equal(expired.json.code, 40301);

  // 价格站侧封禁 → 40302
  await db.run("UPDATE accounts SET status = 'banned', expires_at = NULL WHERE sso_subject = ?", [subject]);
  const banned = await login(makeTicket({ sub: subject }));
  assert.equal(banned.status, 403);
  assert.equal(banned.json.code, 40302);

  // 非法到期时间 → 400
  await db.run("UPDATE accounts SET status = 'active' WHERE sso_subject = ?", [subject]);
  const invalid = await login(makeTicket({ sub: subject, accountExpiresAt: '不是时间' }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, 40021);
});

test('tool-login：设备记录超上限时自动腾位（不返回 409）', async () => {
  const subject = nextSubject();
  const first = await login(makeTicket({ sub: subject }));
  const accountId = (await db.get('SELECT id FROM accounts WHERE sso_subject = ?', [subject])).id;
  // 塞满 3 条设备记录
  for (let i = 0; i < 3; i += 1) {
    await db.run(
      `INSERT INTO account_devices (account_id, device_id, device_name, created_at, last_seen_at)
       VALUES (?, ?, ?, '2020-01-01 00:00:00', '2020-01-01 00:00:00')`,
      [accountId, `old-device-${i}`]
    );
  }
  const fourth = await login(makeTicket({ sub: subject }));
  assert.equal(fourth.status, 200);
  const used = await db.get('SELECT COUNT(*) AS n FROM account_devices WHERE account_id = ?', [accountId]);
  assert.equal(Number(used.n), 3, '仍然是 3 条（最旧的一条被替换）');
  assert.ok(first.json.data.session);
});

/* ------------------------------ 3. game-meta ------------------------------ */

test('game-meta：需账号已绑定且有效；支持 body / x-sso-ticket 头；返回 175 城映射', async () => {
  const { sub } = await bindSubject({ name: '工具丙' });
  const metaTicket = () => makeTicket({ scope: 'ingest', sub, name: '工具丙' });

  const viaBody = await post('/api/sso/game-meta', { ticket: metaTicket() });
  assert.equal(viaBody.status, 200);
  assert.equal(viaBody.json.data.total, 175);
  assert.equal(viaBody.json.data.cities.length, 175);
  const first = viaBody.json.data.cities[0];
  assert.ok(first.name);
  assert.equal(typeof first.nodeNo, 'number');
  assert.equal(typeof first.metaId, 'number');
  assert.equal(viaBody.json.data.ticketUser.name, '工具丙');
  assert.equal(viaBody.json.data.ticketUser.accountName, '工具丙');

  const viaHeader = await post('/api/sso/game-meta', undefined, { 'x-sso-ticket': metaTicket() });
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.json.data.cities.length, 175);

  const noTicket = await post('/api/sso/game-meta', {});
  assert.equal(noTicket.status, 400);
  assert.equal(noTicket.json.code, 40020);

  // 过期/伪造同样拒绝
  const bad = await post('/api/sso/game-meta', { ticket: `${makeTicket({ scope: 'ingest' }).split('.')[0]}.${'f'.repeat(64)}` });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 40121);
});

test('game-meta：未绑定账号 401、封禁/到期 403（W3 修复）', async () => {
  // 有效 ticket 但价格站侧从未绑定该 sub → 401
  const unbound = await post('/api/sso/game-meta', { ticket: makeTicket({ scope: 'ingest', sub: nextSubject() }) });
  assert.equal(unbound.status, 401);
  assert.equal(unbound.json.code, 40140);

  // 绑定后封禁 → 403/40302
  const banned = await bindSubject({ name: '被封禁工具号' });
  await db.run("UPDATE accounts SET status = 'banned' WHERE id = ?", [banned.account.id]);
  const bannedRes = await post('/api/sso/game-meta', { ticket: makeTicket({ scope: 'ingest', sub: banned.sub }) });
  assert.equal(bannedRes.status, 403);
  assert.equal(bannedRes.json.code, 40302);

  // 绑定后到期 → 403/40301
  const expired = await bindSubject({ name: '已到期工具号' });
  await db.run("UPDATE accounts SET expires_at = '2020-01-01 00:00:00' WHERE id = ?", [expired.account.id]);
  const expiredRes = await post('/api/sso/game-meta', { ticket: makeTicket({ scope: 'ingest', sub: expired.sub }) });
  assert.equal(expiredRes.status, 403);
  assert.equal(expiredRes.json.code, 40301);

  // 恢复正常后可再次读取
  await db.run(
    "UPDATE accounts SET status = 'active', expires_at = NULL WHERE id IN (?, ?)",
    [banned.account.id, expired.account.id]
  );
  const recovered = await post('/api/sso/game-meta', { ticket: makeTicket({ scope: 'ingest', sub: banned.sub }) });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.data.cities.length, 175);
});

/* ------------------------------ 4. game-ingest ------------------------------ */

async function ingest(ticket, body) {
  return post('/api/sso/game-ingest', { ticket, ...body });
}

test('game-ingest：参数校验与鉴权', async () => {
  assert.equal((await post('/api/sso/game-ingest', {})).status, 400);

  const noServer = await ingest(makeTicket({ scope: 'ingest' }), { cities: [{ name: '桂阳', products: [] }] });
  assert.equal(noServer.status, 400);
  assert.equal(noServer.json.code, 40022);

  const empty = await ingest(makeTicket({ scope: 'ingest' }), { server: '138' });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, 40023);

  const tooMany = await ingest(makeTicket({ scope: 'ingest' }), {
    server: '138',
    cities: Array.from({ length: 201 }, () => ({ name: '桂阳', products: [] })),
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.code, 40024);
});

test('game-ingest：写入价格 / 税率 / 事件，第二次为更新', async () => {
  const CITY_MAP = require('../server/game/sync').CITY_MAP;
  const guiyang = CITY_MAP.find(c => c.name === '桂阳');
  assert.ok(guiyang, 'city_map.json 应包含桂阳');
  const subject = nextSubject();
  const ticket = makeTicket({ scope: 'ingest', sub: subject, name: '工具丁' });
  const nowSec = Math.floor(Date.now() / 1000);
  const capitalId = String(138 * 1e11 + guiyang.nodeNo);

  const first = await ingest(ticket, {
    server: '138',
    roleId: '123456',
    syncedAt: new Date().toISOString(),
    cities: [{
      name: '桂阳',
      nodeNo: guiyang.nodeNo,
      metaId: guiyang.metaId,
      tax: 0.15,
      products: [
        { name: '谷物', buy: 1.23, sell: 4.56 },
        { name: '黏土', buy: null, sell: 2.5 },
        { name: '不存在的商品', buy: 1, sell: 2 },
      ],
    }, {
      name: '不存在的城',
      products: [{ name: '谷物', buy: 1, sell: 2 }],
    }],
    news: [
      { capitalId, productId: 1, startTime: nowSec - 60, endTime: nowSec + 3600, metaId: 'news-m1' },
      { capitalId, productId: 201, startTime: nowSec - 60, endTime: nowSec - 10, metaId: 'news-expired' },
    ],
  });
  assert.equal(first.status, 200);
  const data = first.json.data;
  assert.equal(data.server, '138');
  assert.equal(data.scope, 'self', '未设置主账号时写入工具账号自身');
  assert.equal(data.saved, 2);
  assert.equal(data.created, 2);
  assert.equal(data.events, 1, '已结束的事件不写入');
  assert.ok(data.failed.some(f => f.city === '不存在的城'));
  assert.ok(data.failed.some(f => String(f.error).includes('不存在的商品')));
  assert.ok(data.syncedAt);

  const account = await db.get('SELECT * FROM accounts WHERE sso_subject = ?', [subject]);
  assert.ok(account);
  assert.equal(account.current_server, '138');
  assert.equal(Number(data.accountId), Number(account.id), 'ingest 只写当前 SSO 账号自身');

  const serverRow = await db.get('SELECT id FROM servers WHERE name = ?', ['138']);
  const cityId = await db.findDictId('city', '桂阳');
  const commodityId = await db.findDictId('commodity', '谷物');
  const price = await db.get(
    'SELECT buy_price AS buy, sell_price AS sell, operator FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
    [account.id, serverRow.id, cityId, commodityId]
  );
  assert.ok(price, '价格已落库');
  assert.equal(Number(price.buy), 1.23);
  assert.equal(Number(price.sell), 4.56);
  assert.equal(price.operator, '工具同步');

  assert.equal(await db.getCityTax(account.id, serverRow.id, cityId), 0.15);

  const events = await db.getActiveCityEvents(serverRow.id, cityId);
  assert.equal(events.length, 1);
  assert.equal(events[0].metaId, 'news-m1');

  // 二次 ingest：同城改价 → updated
  const second = await ingest(makeTicket({ scope: 'ingest', sub: subject }), {
    server: '138',
    cities: [{ name: '桂阳', tax: 0.2, products: [{ name: '谷物', buy: 1.5, sell: 4.4 }] }],
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.data.updated, 1);
  assert.equal(second.json.data.created, 0);
  const price2 = await db.get(
    'SELECT buy_price AS buy, sell_price AS sell FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
    [account.id, serverRow.id, cityId, commodityId]
  );
  assert.equal(Number(price2.buy), 1.5);
  assert.equal(Number(price2.sell), 4.4);
  assert.equal(await db.getCityTax(account.id, serverRow.id, cityId), 0.2);

  // 价格历史有流水
  const history = await db.query(
    'SELECT field, old_value AS oldValue, new_value AS newValue FROM price_history WHERE account_id = ? AND city_id = ? ORDER BY id',
    [account.id, cityId]
  );
  assert.ok(history.length >= 2);
});

test('game-ingest：server 清洗后必须 1-50 字符（超长拒绝，不静默截断）', async () => {
  const { sub } = await bindSubject({ name: '区服校验账号' });
  const ticket = () => makeTicket({ scope: 'ingest', sub });
  const city = { name: '桂阳', products: [{ name: '谷物', buy: 1, sell: 2 }] };

  const longServer = 'x'.repeat(51);
  const tooLong = await ingest(ticket(), { server: longServer, cities: [city] });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.code, 40025);

  const blank = await ingest(ticket(), { server: '   ', cities: [city] });
  assert.equal(blank.status, 400);
  assert.equal(blank.json.code, 40022);

  // 恰好 50 字符可用，且首尾空白被清洗
  const okName = 'a'.repeat(50);
  const okRes = await ingest(ticket(), { server: `  ${okName}  `, cities: [city] });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.data.server, okName);
  assert.equal(okRes.json.data.scope, 'self');
});

test('game-ingest：普通 SSO 账号只写自己，绝不代写他人主账号（F1 修复）', async () => {
  const serverName = '188';
  await db.upsertServer(serverName);
  const serverRow = await db.get('SELECT id FROM servers WHERE name = ?', [serverName]);

  // 该区服已有「别人」的主账号
  await db.run(
    "INSERT INTO accounts (name, password_hash, status, current_server) VALUES ('主账号甲', 'scrypt$00$00', 'active', ?)",
    [serverName]
  );
  const master = await db.get('SELECT id FROM accounts WHERE name = ?', ['主账号甲']);
  const setMaster = await admin.post(`/api/admin/servers/${serverRow.id}/master`, { accountId: master.id });
  assert.equal(setMaster.status, 200);

  const { sub, account, client } = await bindSubject({ name: '普通工具账号' });
  const selfWs = await openWs(client);
  try {
    const res = await ingest(makeTicket({ scope: 'ingest', sub }), {
      server: serverName,
      cities: [{ name: '浈阳', tax: 0.1, products: [{ name: '铁矿石', buy: 9.99, sell: 19.99 }] }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.scope, 'self', '别人是主账号时，普通 SSO 账号只能写自己');
    assert.equal(Number(res.json.data.accountId), Number(account.id));

    const cityId = await db.findDictId('city', '浈阳');
    const commodityId = await db.findDictId('commodity', '铁矿石');
    const ownPrice = await db.get(
      'SELECT buy_price AS buy FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
      [account.id, serverRow.id, cityId, commodityId]
    );
    assert.ok(ownPrice, '价格写在 SSO 账号自身名下');
    assert.equal(Number(ownPrice.buy), 9.99);

    // ★ 核心断言：主账号名下的价格/税率/历史完全未被写入
    const masterPrice = await db.get(
      'SELECT buy_price AS buy FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ?',
      [master.id, serverRow.id, cityId]
    );
    assert.equal(masterPrice, undefined, '绝不代写他人主账号价格');
    assert.equal(await db.getCityTax(master.id, serverRow.id, cityId), null, '绝不代写他人主账号税率');
    const masterHistory = await db.get('SELECT COUNT(*) AS n FROM price_history WHERE account_id = ?', [master.id]);
    assert.equal(Number(masterHistory.n), 0, '绝不产生他人主账号的历史流水');

    // 非主账号：只广播给自己的会话
    const selfMsg = await waitForMessage(selfWs.messages, m => m.type === 'price.updated');
    assert.equal(selfMsg.server, serverName);
    assert.equal(selfMsg.city, '浈阳');
    assert.equal(selfMsg.source, 'tool-sync');
    assert.notEqual(selfMsg.shared, true, '非主账号不得发主账号共享广播');
  } finally {
    closeWs(selfWs);
  }
});

test('game-ingest：SSO 账号本身是主账号 → scope=master，自身广播 + 主账号共享广播', async () => {
  const serverName = '288';
  await db.upsertServer(serverName);
  const serverRow = await db.get('SELECT id FROM servers WHERE name = ?', [serverName]);

  const { sub, account, client: ssoClient } = await bindSubject({ name: '采集主账号' });

  // 1) 先同步一次（同时把账号当前区服设为该区服，满足设主账号的前置条件）
  const first = await ingest(makeTicket({ scope: 'ingest', sub }), {
    server: serverName,
    cities: [{ name: '曲江', products: [{ name: '铜矿石', buy: 3.5, sell: 7.5 }] }],
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.scope, 'self');

  // 2) 同区服普通查看者（在设主账号前先就位，才能自动获得共享查看权限）
  const viewer = await registerAccount(base, admin, { name: '共享查看者', password: 'pass-1234' });
  assert.equal((await viewer.put('/api/auth/server', { server: serverName })).status, 200);

  // 3) 管理员把 SSO 账号设为该区服主账号
  const setMaster = await admin.post(`/api/admin/servers/${serverRow.id}/master`, { accountId: account.id });
  assert.equal(setMaster.status, 200);
  const viewerMe = await viewer.get('/api/auth/me');
  assert.equal(!!viewerMe.json.data.viewMasterPrices, true, '查看者已开启主账号价格共享');

  const viewerWs = await openWs(viewer);
  const selfWs = await openWs(ssoClient);
  try {
    const second = await ingest(makeTicket({ scope: 'ingest', sub }), {
      server: serverName,
      city: 'ignored',
      cities: [{ name: '曲江', tax: 0.12, products: [{ name: '铜矿石', buy: 4.2, sell: 8.8 }] }],
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.data.scope, 'master');
    assert.equal(Number(second.json.data.accountId), Number(account.id), '写的是自己，不写别人');

    // 自身实时刷新
    const selfMsg = await waitForMessage(selfWs.messages, m => m.type === 'price.updated' && m.source === 'tool-sync');
    assert.equal(selfMsg.city, '曲江');

    // 主账号共享广播（shared=true）发给开启共享的查看者
    const shared = await waitForMessage(viewerWs.messages, m => m.type === 'price.updated' && m.shared === true);
    assert.equal(shared.server, serverName);
    assert.equal(shared.masterAccountName, account.name);

    // 查看者查询走主账号回退，能看到本次同步的价格
    const prices = await viewer.get(`/api/prices?server=${serverName}&city=${encodeURIComponent('曲江')}`);
    assert.equal(prices.status, 200);
    const item = prices.json.data.items.find(i => i.commodity === '铜矿石');
    assert.ok(item, '查看者列表包含该商品');
    assert.equal(item.source, 'master');
    assert.notEqual(item.buy, null);

    // 价格确实写在主账号（= SSO 账号自己）名下
    const cityId = await db.findDictId('city', '曲江');
    const commodityId = await db.findDictId('commodity', '铜矿石');
    const row = await db.get(
      'SELECT buy_price AS buy FROM prices WHERE account_id = ? AND server_id = ? AND city_id = ? AND commodity_id = ?',
      [account.id, serverRow.id, cityId, commodityId]
    );
    assert.equal(Number(row.buy), 4.2);
  } finally {
    closeWs(viewerWs);
    closeWs(selfWs);
  }
});

test('game-ingest：同账号高频调用被限流（429）', async () => {
  const previous = process.env.SSO_INGEST_MIN_INTERVAL_MS;
  process.env.SSO_INGEST_MIN_INTERVAL_MS = '60000';
  try {
    const subject = nextSubject();
    const payload = {
      server: '138',
      cities: [{ name: '桂阳', products: [{ name: '谷物', buy: 1, sell: 2 }] }],
    };
    const first = await ingest(makeTicket({ scope: 'ingest', sub: subject }), payload);
    assert.equal(first.status, 200);
    const second = await ingest(makeTicket({ scope: 'ingest', sub: subject }), payload);
    assert.equal(second.status, 429);
    assert.equal(second.json.code, 42901);
  } finally {
    if (previous === undefined) delete process.env.SSO_INGEST_MIN_INTERVAL_MS;
    else process.env.SSO_INGEST_MIN_INTERVAL_MS = previous;
  }
});
