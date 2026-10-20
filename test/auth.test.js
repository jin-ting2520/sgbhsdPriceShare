'use strict';

/** 账号体系：卡密注册 / 到期 / 封禁 / 多设备会话 / 管理后台 / 数据隔离 */

const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `auth-test-${process.pid}-${Date.now()}.db`);
process.env.ADMIN_PASSWORD = 'test-admin-pass';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');
const db = require('../server/db');
const rateLimit = require('../server/ratelimit');
const {
  createClient, createAdmin, registerAccount, issueKeys, makeDeviceId,
} = require('./helpers');

const BASE_FILE = process.env.PRICE_DB;
let server;
let base = '';
let admin;

async function accountId(name) {
  const row = await db.get('SELECT id FROM accounts WHERE name = ?', [name]);
  return row && row.id;
}

async function login(baseName, password, extra = {}) {
  const c = createClient(base, extra);
  const r = await c.login({ name: baseName, password, ...extra });
  if (r.status === 200) c.token = r.json.data.session;
  return { client: c, res: r };
}

before(async () => {
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = createAdmin(base);
  const r = await admin.login();
  assert.equal(r.status, 200);
});

after(async () => {
  require('../server/scheduler').stop();
  await new Promise(res => server.close(res));
  await db.close().catch(() => {});
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(BASE_FILE + suffix); } catch { /* ignore */ }
  }
});

/* ------------------------------ 管理后台入口 ------------------------------ */

test('管理后台：密码错误 401，未带 token 401', async () => {
  const wrong = await createAdmin(base).login('bad-password');
  assert.equal(wrong.status, 401);
  const anon = createAdmin(base);
  const r = await anon.get('/api/admin/overview');
  assert.equal(r.status, 401);
  const overview = await admin.get('/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.json.data.accounts >= 0);
});

test('卡密批量生成 / 列表 / 导出 / 作废', async () => {
  const made = await admin.post('/api/admin/keys', { type: 'month', count: 2, note: '批量测试' });
  assert.equal(made.status, 200);
  assert.equal(made.json.data.codes.length, 2);
  const { batchId, codes } = made.json.data;

  const list = await admin.get(`/api/admin/keys?batch=${batchId}`);
  assert.equal(list.json.data.total, 2);
  assert.equal(list.json.data.items[0].typeName, '1 月');

  const csv = await admin.get(`/api/admin/keys/export?batch=${batchId}`);
  assert.equal(csv.status, 200);
  assert.ok(csv.json === null, '导出应为 CSV 而非 JSON');

  const exportText = await fetch(`${base}/api/admin/keys/export?batch=${batchId}`, {
    headers: { 'X-Admin-Token': admin.token },
  }).then(res => res.text());
  assert.ok(exportText.includes(codes[0]));

  const revoked = await admin.post('/api/admin/keys/revoke', { batchId });
  assert.equal(revoked.json.data.revoked, 2);

  const big = await admin.post('/api/admin/keys', { type: 'day', count: 999, note: '大批量' });
  assert.equal(big.status, 200);
  assert.equal(big.json.data.codes.length, 500, '批量生成上限为 500');
  assert.equal(new Set(big.json.data.codes).size, 500);
  assert.equal((await admin.post('/api/admin/keys/revoke', { batchId: big.json.data.batchId })).json.data.revoked, 500);

  const attempt = createClient(base);
  const r = await attempt.login({ name: '作废测试', password: 'pass-1234', key: codes[0] });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /作废/);
});

/* ------------------------------ 卡密注册 ------------------------------ */

test('卡密启用前可无卡密注册试用，有效卡密正常注册', async () => {
  const trialClient = createClient(base);
  const noKey = await trialClient.login({ name: '试用测试', password: 'pass-1234' });
  assert.equal(noKey.status, 200, noKey.json && noKey.json.message);
  assert.equal(noKey.json.data.created, true);
  assert.equal(noKey.json.data.hasKey, false);
  assert.equal(noKey.json.data.trial, true);
  assert.ok(noKey.json.data.expiresAt, '试用账号应带试用截止时间');
  const trialMe = await trialClient.get('/api/auth/me');
  assert.equal(trialMe.status, 200);
  assert.equal(trialMe.json.data.hasKey, false);

  const fakeKey = await createClient(base).login({ name: '假卡密', password: 'pass-1234', key: 'AAAA-BBBB-CCCC-DDDD' });
  assert.equal(fakeKey.status, 400);

  const [code] = await issueKeys(admin, 'day', 1);
  const first = createClient(base);
  const okRes = await first.login({ name: '卡密测试', password: 'pass-1234', key: code });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.data.created, true);
  assert.equal(okRes.json.data.hasKey, true);
  assert.ok(okRes.json.data.expiresAt, '1 天卡密应有到期时间');

  const reuse = await createClient(base).login({ name: '卡密复用', password: 'pass-1234', key: code });
  assert.equal(reuse.status, 400);
  assert.match(reuse.json.message, /已被使用/);
});

test('卡密启用后新注册强制卡密，试用账号需补卡密登录', async () => {
  const changed = await admin.put('/api/admin/settings', { keyRequiredAt: '2000-01-01 00:00:00' });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.data.keyRequired, true);

  const noKey = await createClient(base).login({ name: '启用后无卡密', password: 'pass-1234' });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.code, 40010);

  const trialBlocked = await login('试用测试', 'pass-1234');
  assert.equal(trialBlocked.res.status, 403);
  assert.equal(trialBlocked.res.json.code, 40301);
  assert.match(trialBlocked.res.json.message, /试用已结束/);

  const [code] = await issueKeys(admin, 'month', 1);
  const renewed = await login('试用测试', 'pass-1234', { key: code });
  assert.equal(renewed.res.status, 200, renewed.res.json && renewed.res.json.message);
  assert.equal(renewed.res.json.data.renewed, true);
  assert.equal(renewed.res.json.data.hasKey, true);
  assert.ok(renewed.res.json.data.expiresAt);

  const restored = await admin.put('/api/admin/settings', { keyRequiredAt: '2099-01-01 00:00:00' });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.data.keyRequired, false);
});

test('后台配置卡密提示与 token 教程，公开接口返回清洗后的 Markdown', async () => {
  const keyHelpMd = '**还没有卡密？**\n\n[联系管理员](https://example.com/buy)';
  const tokenHelpMd = '1. 打开游戏网页端\n\n<script>alert(1)</script>\n\n![示意图](https://example.com/token.png)';
  const saved = await admin.put('/api/admin/settings', { keyHelpMd, tokenHelpMd });
  assert.equal(saved.status, 200, saved.json && saved.json.message);
  assert.match(saved.json.data.keyHelpHtml, /<strong>还没有卡密？<\/strong>/);
  assert.match(saved.json.data.keyHelpHtml, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(saved.json.data.tokenHelpHtml, /<script/i);
  assert.match(saved.json.data.tokenHelpHtml, /<img[^>]+src="https:\/\/example\.com\/token\.png"/);

  const pub = await fetch(`${base}/api/public/config`).then(r => r.json());
  assert.equal(pub.code, 0);
  assert.equal(pub.data.keyRequired, false);
  assert.match(pub.data.keyHelpHtml, /联系管理员/);
  assert.match(pub.data.tokenHelpHtml, /打开游戏网页端/);
  assert.doesNotMatch(pub.data.tokenHelpHtml, /script/i);

  const preview = await admin.post('/api/admin/markdown/preview', {
    text: '<img src="x" onerror="alert(1)">\n\n**预览**',
  });
  assert.equal(preview.status, 200);
  assert.doesNotMatch(preview.json.data.html, /onerror/i);
  assert.match(preview.json.data.html, /<strong>预览<\/strong>/);

  const badDate = await admin.put('/api/admin/settings', { keyRequiredAt: '2026/10/22' });
  assert.equal(badDate.status, 400);
});

test('永久卡密 expiresAt 为空，1 月卡密为 30 天', async () => {
  const forever = await registerAccount(base, admin, { name: '永久号', type: 'forever' });
  const me = await forever.get('/api/auth/me');
  assert.equal(me.json.data.expiresAt, null);
  assert.equal(me.json.data.hasKey, true);
  assert.equal(me.json.data.allowSyncServer, false);
  assert.equal(forever.registered.allowSyncServer, false, '登录响应也应返回权限标记');

  const month = await registerAccount(base, admin, { name: '月卡号', type: 'month' });
  const meMonth = await month.get('/api/auth/me');
  assert.ok(meMonth.json.data.expiresAt);
  const days = (db.parseTime(meMonth.json.data.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 29 && days <= 30, `月卡应约 30 天，实际 ${days}`);
});

test('密码登录校验：错误密码 401，过短密码 400', async () => {
  const ok = await login('月卡号', 'pass-1234');
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.json.data.created, false);

  const wrong = await login('月卡号', 'wrong-pass');
  assert.equal(wrong.res.status, 401);

  const short = await login('月卡号', '123');
  assert.equal(short.res.status, 400);
});

/* ------------------------------ 到期 / 封禁 ------------------------------ */

test('卡密到期锁定登录与在线会话，管理员续期后恢复', async () => {
  const user = await registerAccount(base, admin, { name: '到期测试' });
  const id = await accountId('到期测试');
  await admin.post(`/api/admin/accounts/${id}/expires`, { expiresAt: '2000-01-01 00:00:00' });

  const blocked = await login('到期测试', 'pass-1234');
  assert.equal(blocked.res.status, 403);
  assert.equal(blocked.res.json.code, 40301);

  const me = await user.get('/api/auth/me');
  assert.equal(me.status, 403, '已登录会话在到期后也应被拦截');

  const renewed = await admin.post(`/api/admin/accounts/${id}/expires`, { extendDays: 30 });
  assert.equal(renewed.status, 200);
  const back = await login('到期测试', 'pass-1234');
  assert.equal(back.res.status, 200);
});

test('封禁账号：登录 403，在线会话立即失效；解封恢复', async () => {
  const user = await registerAccount(base, admin, { name: '封禁测试' });
  const id = await accountId('封禁测试');

  await admin.post(`/api/admin/accounts/${id}/status`, { status: 'banned' });
  const blocked = await login('封禁测试', 'pass-1234');
  assert.equal(blocked.res.status, 403);
  assert.equal(blocked.res.json.code, 40302);
  assert.equal((await user.get('/api/auth/me')).status, 401, '封禁同时注销在线会话');

  await admin.post(`/api/admin/accounts/${id}/status`, { status: 'active' });
  const back = await login('封禁测试', 'pass-1234');
  assert.equal(back.res.status, 200);
});

/* ------------------------------ 多设备会话 ------------------------------ */

test('默认 3 台设备：第 4 台返回设备列表，踢出后可登录', async () => {
  const first = await registerAccount(base, admin, { name: '设备测试', deviceId: makeDeviceId('d1') });
  const second = await login('设备测试', 'pass-1234', { deviceId: makeDeviceId('d2'), deviceName: '第二台' });
  const third = await login('设备测试', 'pass-1234', { deviceId: makeDeviceId('d3'), deviceName: '第三台' });
  assert.equal(second.res.status, 200);
  assert.equal(third.res.status, 200);

  const fourthClient = createClient(base, { deviceId: makeDeviceId('d4') });
  const fourth = await fourthClient.login({ name: '设备测试', password: 'pass-1234' });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.json.code, 40910);
  assert.equal(fourth.json.data.limit, 3);
  assert.equal(fourth.json.data.sessions.length, 3);

  const kickAll = await fourthClient.login({ name: '设备测试', password: 'pass-1234', kick: 'all' });
  assert.equal(kickAll.status, 200, kickAll.json && kickAll.json.message);
  assert.equal((await first.get('/api/auth/me')).status, 401, '旧设备会话应被踢出');

  const sessions = await fourthClient.get('/api/auth/sessions');
  assert.equal(sessions.json.data.limit, 3);
  assert.equal(sessions.json.data.items.length, 1);
  assert.equal(sessions.json.data.items[0].current, true);

  const c5 = await login('设备测试', 'pass-1234', { deviceId: makeDeviceId('d5') });
  const c6 = await login('设备测试', 'pass-1234', { deviceId: makeDeviceId('d6') });
  assert.equal(c5.res.status, 200);
  assert.equal(c6.res.status, 200);

  const kickOthers = await c6.client.post('/api/auth/sessions/kick-others', {});
  assert.equal(kickOthers.json.data.count, 2);
  assert.equal((await c5.client.get('/api/auth/me')).status, 401);

  const own = await c6.client.get('/api/auth/sessions');
  const ownId = own.json.data.items.find(s => s.current).id;
  const removed = await c6.client.del(`/api/auth/sessions/${ownId}`);
  assert.equal(removed.status, 200);
  assert.equal((await c6.client.get('/api/auth/me')).status, 401);
});

test('设备已满时提交续期卡密不消耗卡密，踢出后重试成功', async () => {
  rateLimit.reset();
  const first = await registerAccount(base, admin, { name: '续期设备测试', deviceId: makeDeviceId('r1') });
  const second = await login('续期设备测试', 'pass-1234', { deviceId: makeDeviceId('r2') });
  const third = await login('续期设备测试', 'pass-1234', { deviceId: makeDeviceId('r3') });
  assert.equal(second.res.status, 200);
  assert.equal(third.res.status, 200);

  const id = await accountId('续期设备测试');
  await admin.post(`/api/admin/accounts/${id}/expires`, { expiresAt: '2000-01-01 00:00:00' });
  const [code] = await issueKeys(admin, 'month', 1);

  const fourth = await login('续期设备测试', 'pass-1234', {
    deviceId: makeDeviceId('r4'), key: code,
  });
  assert.equal(fourth.res.status, 409);
  assert.equal(fourth.res.json.code, 40910);
  const untouched = await db.get('SELECT account_id FROM invite_keys WHERE code = ?', [code]);
  assert.equal(untouched.account_id, null, '设备超限时不应消耗卡密');

  const retry = await login('续期设备测试', 'pass-1234', {
    deviceId: makeDeviceId('r5'), key: code, kick: 'all',
  });
  assert.equal(retry.res.status, 200, retry.res.json && retry.res.json.message);
  assert.equal(retry.res.json.data.renewed, true);
  const consumed = await db.get('SELECT account_id FROM invite_keys WHERE code = ?', [code]);
  assert.equal(consumed.account_id, id);
  assert.equal((await first.get('/api/auth/me')).status, 401, 'kick=all 应注销旧设备');
});

test('管理员可调整单账号设备上限并踢下线', async () => {
  const user = await registerAccount(base, admin, { name: '上限调整', deviceId: makeDeviceId('u1') });
  const id = await accountId('上限调整');

  const limited = await admin.post(`/api/admin/accounts/${id}/device-limit`, { limit: 1 });
  assert.equal(limited.status, 200);

  const second = await login('上限调整', 'pass-1234', { deviceId: makeDeviceId('u2') });
  assert.equal(second.res.status, 409);

  const kick = await admin.post(`/api/admin/accounts/${id}/kick`, {});
  assert.equal(kick.json.data.count, 1);
  assert.equal((await user.get('/api/auth/me')).status, 401);

  await admin.post(`/api/admin/accounts/${id}/device-limit`, { limit: 3 });
});

test('管理员重置密码会注销全部会话', async () => {
  const user = await registerAccount(base, admin, { name: '改密测试' });
  const id = await accountId('改密测试');

  const reset = await admin.post(`/api/admin/accounts/${id}/password`, { password: 'new-pass-99' });
  assert.equal(reset.status, 200);
  assert.equal((await user.get('/api/auth/me')).status, 401);

  const oldPass = await login('改密测试', 'pass-1234');
  assert.equal(oldPass.res.status, 401);
  const newPass = await login('改密测试', 'new-pass-99');
  assert.equal(newPass.res.status, 200);
});

/* ------------------------------ 设置 / 隔离 / 退出 ------------------------------ */

test('关闭注册后新账号无法注册（已有账号可登录）', async () => {
  await admin.put('/api/admin/settings', { registrationEnabled: false });
  const [code] = await issueKeys(admin, 'day', 1);
  const r = await createClient(base).login({ name: '关闭注册', password: 'pass-1234', key: code });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 40303);

  const existing = await login('永久号', 'pass-1234');
  assert.equal(existing.res.status, 200);

  await admin.put('/api/admin/settings', { registrationEnabled: true });
});

test('游戏 token / 赋税减免 / 同步设置均按账号隔离', async () => {
  const a = await registerAccount(base, admin, { name: '隔离甲' });
  const b = await registerAccount(base, admin, { name: '隔离乙' });

  const save = await a.put('/api/auth/token', { token: 't'.repeat(80) });
  assert.equal(save.status, 200);
  assert.equal((await a.get('/api/auth/me')).json.data.token, 't'.repeat(80));
  assert.equal((await b.get('/api/auth/me')).json.data.token, '');

  const settingsA = await a.get('/api/sync-settings');
  const settingsB = await b.get('/api/sync-settings');
  assert.equal(settingsA.json.data.hasToken, true);
  assert.equal(settingsB.json.data.hasToken, false);
  assert.equal(settingsA.json.data.token, undefined);

  const reliefA = await a.put('/api/auth/relief', { relief: 12 });
  assert.equal(reliefA.json.data.relief, 12);
  assert.equal((await b.get('/api/auth/me')).json.data.relief, 5);
  assert.equal((await a.get('/api/auth/me')).json.data.relief, 12);

  const enable = await a.put('/api/sync-settings', {
    enabled: true, cron: '0 */6 * * *',
  });
  assert.equal(enable.status, 200, enable.json && enable.json.message);
  assert.equal(enable.json.data.enabled, true);

  const logsA = await a.get('/api/sync-settings/logs');
  const logsB = await b.get('/api/sync-settings/logs');
  assert.deepEqual(logsA.json.data.items, []);
  assert.deepEqual(logsB.json.data.items, []);
});

test('退出登录后会话失效', async () => {
  const user = await registerAccount(base, admin, { name: '退出测试' });
  const out = await user.post('/api/auth/logout', {});
  assert.equal(out.status, 200);
  assert.equal((await user.get('/api/auth/me')).status, 401);
});
