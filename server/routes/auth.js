'use strict';

/** 账号入口：密码登录（首次自动注册）/ 退出 / 当前账号 / 游戏 token / 赋税减免 */

const express = require('express');
const { ok, fail, asyncHandler, cleanName, isUniqueConstraintError } = require('../util');
const {
  hashPassword, verifyPassword, newSession, requireAccount,
  getAccountByName, setAccountSession, setAccountToken,
} = require('../auth');
const { get, run, nowText } = require('../db');
const { clampRelief } = require('../tax');

const router = express.Router();

const PASSWORD_MIN = 4;
const PASSWORD_MAX = 64;

function readCredentials(body) {
  const name = cleanName(body && body.name, 20);
  const password = body && typeof body.password === 'string' ? body.password : '';
  return { name, password };
}

function publicAccount(row, created) {
  return {
    name: row.name,
    session: row.session_token,
    token: row.token || '',
    relief: clampRelief(row.relief),
    created: !!created,
  };
}

/** POST /api/auth/login { name, password } 首次登录自动注册 */
router.post('/login', asyncHandler(async (req, res) => {
  const { name, password } = readCredentials(req.body);
  if (!name) return fail(res, 400, '请输入昵称');
  if (password.length < PASSWORD_MIN) return fail(res, 400, `密码至少 ${PASSWORD_MIN} 位`);
  if (password.length > PASSWORD_MAX) return fail(res, 400, `密码最长 ${PASSWORD_MAX} 位`);

  const existing = await getAccountByName(name);
  if (existing) {
    if (!(await verifyPassword(password, existing.password_hash))) {
      return fail(res, 401, '昵称或密码不正确');
    }
    const session = newSession();
    await setAccountSession(existing.id, session);
    existing.session_token = session;
    return ok(res, publicAccount(existing, false));
  }

  const passwordHash = await hashPassword(password);
  const session = newSession();
  try {
    const info = await run(
      'INSERT INTO accounts (name, password_hash, session_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [name, passwordHash, session, nowText(), nowText()]
    );
    const row = await get('SELECT * FROM accounts WHERE id = ?', [info.insertId]);
    return ok(res, publicAccount({ ...row, session_token: session }, true));
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const row = await getAccountByName(name);
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return fail(res, 401, '昵称或密码不正确');
    }
    await setAccountSession(row.id, session);
    row.session_token = session;
    return ok(res, publicAccount(row, false));
  }
}));

/** POST /api/auth/logout 注销当前会话 */
router.post('/logout', requireAccount, asyncHandler(async (req, res) => {
  await run('UPDATE accounts SET session_token = NULL, updated_at = ? WHERE id = ?', [nowText(), req.account.id]);
  return ok(res, null);
}));

/** GET /api/auth/me 当前账号与自己的游戏 token / 赋税减免 */
router.get('/me', requireAccount, asyncHandler(async (req, res) => {
  const row = await get('SELECT name, token, relief, created_at AS createdAt FROM accounts WHERE id = ?', [req.account.id]);
  return ok(res, { name: row.name, token: row.token || '', relief: clampRelief(row.relief), createdAt: row.createdAt });
}));

/** PUT /api/auth/relief { relief } 仅更新本账号的赋税减免（0~100） */
router.put('/relief', requireAccount, asyncHandler(async (req, res) => {
  const raw = req.body && req.body.relief;
  if (raw == null || raw === '' || !Number.isFinite(Number(raw))) {
    return fail(res, 400, '请提供 0~100 的赋税减免');
  }
  const relief = clampRelief(raw);
  await run('UPDATE accounts SET relief = ?, updated_at = ? WHERE id = ?', [relief, nowText(), req.account.id]);
  return ok(res, { relief });
}));

/** PUT /api/auth/token { token } 仅更新本账号的游戏登录 token */
router.put('/token', requireAccount, asyncHandler(async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (token && token.length < 60) return fail(res, 400, '登录 token 格式不正确，长度过短');
  await setAccountToken(req.account.id, token);
  return ok(res, { token });
}));

module.exports = router;
