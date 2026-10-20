'use strict';

/** 账号体系：密码登录（首次自动注册）、会话、游戏 token 隔离（npm test） */

const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

process.env.PRICE_DB = nodePath.join(os.tmpdir(), `auth-test-${process.pid}-${Date.now()}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.PRICE_DB + suffix); } catch { /* ignore */ }
}

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

const BASE_FILE = process.env.PRICE_DB;
let server;
let base = '';

async function api(path, { method = 'GET', body, session } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['X-Account-Token'] = session;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function login(name, password) {
  const r = await api('/api/auth/login', { method: 'POST', body: { name, password } });
  assert.equal(r.status, 200, r.json && r.json.message);
  return r.json.data;
}

before(async () => {
  server = app.createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  require('../server/scheduler').stop();
  await new Promise(res => server.close(res));
  await require('../server/db').close().catch(() => {});
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(BASE_FILE + suffix); } catch { /* ignore */ }
  }
});

test('首次登录自动注册，再次登录校验密码', async () => {
  const created = await login('甲玩家', 'pass-1111');
  assert.equal(created.created, true);
  assert.equal(created.name, '甲玩家');
  assert.match(created.session, /^[a-f0-9]{64}$/);

  const again = await login('甲玩家', 'pass-1111');
  assert.equal(again.created, false);

  const wrong = await api('/api/auth/login', { method: 'POST', body: { name: '甲玩家', password: 'bad-pass' } });
  assert.equal(wrong.status, 401);

  const short = await api('/api/auth/login', { method: 'POST', body: { name: '乙玩家', password: '123' } });
  assert.equal(short.status, 400);
});

test('游戏 token 只对本人可见', async () => {
  const a = await login('甲玩家', 'pass-1111');
  const b = await login('乙玩家', 'pass-2222');

  const save = await api('/api/auth/token', { method: 'PUT', body: { token: 't'.repeat(80) }, session: a.session });
  assert.equal(save.status, 200);

  const meA = await api('/api/auth/me', { session: a.session });
  assert.equal(meA.json.data.token, 't'.repeat(80));

  const meB = await api('/api/auth/me', { session: b.session });
  assert.equal(meB.json.data.token, '');

  const settings = await api('/api/sync-settings', { session: b.session });
  assert.equal(settings.json.data.token, undefined);
  assert.equal(settings.json.data.tokenHint, undefined);
  assert.equal(settings.json.data.tokenOwner, null);

  const anon = await api('/api/auth/me');
  assert.equal(anon.status, 401);
});

test('定时同步绑定保存 token 的账号，其他账号不可见', async () => {
  const a = await login('甲玩家', 'pass-1111');
  const b = await login('乙玩家', 'pass-2222');

  const enable = await api('/api/sync-settings', {
    method: 'PUT',
    session: a.session,
    body: { enabled: true, server: '37795', cron: '0 */6 * * *', token: 't'.repeat(80) },
  });
  assert.equal(enable.status, 200, enable.json && enable.json.message);
  assert.equal(enable.json.data.enabled, true);
  assert.equal(enable.json.data.hasToken, true);
  assert.equal(enable.json.data.tokenOwner, '甲玩家');

  const other = await api('/api/sync-settings', { method: 'PUT', session: b.session, body: { enabled: true } });
  assert.equal(other.status, 200);
  assert.equal(other.json.data.tokenOwner, '甲玩家', '乙账号无 token 时沿用绑定账号');

  const takeOver = await api('/api/sync-settings', {
    method: 'PUT',
    session: b.session,
    body: { token: 'u'.repeat(80) },
  });
  assert.equal(takeOver.status, 200);
  assert.equal(takeOver.json.data.tokenOwner, '乙玩家');

  const disable = await api('/api/sync-settings', { method: 'PUT', session: b.session, body: { enabled: false } });
  assert.equal(disable.status, 200);

  const clear = await api('/api/sync-settings', { method: 'PUT', session: b.session, body: { token: '' } });
  assert.equal(clear.status, 200);
  assert.equal(clear.json.data.hasToken, false);

  const cannot = await api('/api/sync-settings', {
    method: 'PUT',
    session: b.session,
    body: { enabled: true, server: '37795' },
  });
  assert.equal(cannot.status, 400);

  const anon = await api('/api/sync-settings', { method: 'PUT', body: { enabled: false } });
  assert.equal(anon.status, 401);
});

test('退出登录后会话失效', async () => {
  const a = await login('丙玩家', 'pass-3333');
  const out = await api('/api/auth/logout', { method: 'POST', session: a.session });
  assert.equal(out.status, 200);
  const me = await api('/api/auth/me', { session: a.session });
  assert.equal(me.status, 401);
});
