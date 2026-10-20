'use strict';

/** 游戏数据同步（按账号）：识别 token 区服 / 实时抓取富甲天下价格 */

const express = require('express');
const { ok, fail, asyncHandler, cleanName } = require('../util');
const { syncPrices, inspectToken, CITY_MAP } = require('../game/sync');
const { setAccountToken, requireAccount } = require('../auth');
const { setCurrentServer } = require('../db');
const scheduler = require('../scheduler');
const rateLimit = require('../ratelimit');
const { broadcast } = require('../ws');
const { invalidateDict } = require('../dict-cache');

const router = express.Router();

router.use(requireAccount);

/** GET /api/game/meta —— 同步支持范围（城池清单，供前端展示） */
router.get('/meta', asyncHandler(async (req, res) => {
  return ok(res, { cities: CITY_MAP.map(c => c.name) });
}));

/** POST /api/game/token-info { token? } —— 识别 token 所属区服（仅展示，不保存 token） */
router.post('/token-info', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const provided = typeof body.token === 'string' ? body.token.trim() : '';
  const token = provided || String(req.account.token || '');
  if (!token) return fail(res, 400, '请提供登录 token（x-game-token-pcweb），或先在设置中保存 token');
  if (token.length < 60) return fail(res, 400, '登录 token 格式不正确');
  if (!rateLimit.allow(`token-info:${req.account.id}`, 10, 5 * 60 * 1000)) {
    return fail(res, 429, '区服识别过于频繁，请稍后再试');
  }
  try {
    return ok(res, await inspectToken(token));
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return fail(res, status, err.message || '区服识别失败');
  }
}));

/** POST /api/game/sync { token?, operator?, cities?, server? } —— 默认从 token 自动识别区服；
 *  server 仅管理员为该账号开启 allow_sync_server 后可用。 */
router.post('/sync', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const provided = typeof body.token === 'string' ? body.token.trim() : '';
  const owner = String(req.account.token || '');
  const token = provided || owner;
  const operator = cleanName(body.operator, 20) || cleanName(req.account.name, 20) || '游戏同步';
  const serverOverride = cleanName(body.server, 50);

  if (serverOverride && !Number(req.account.allowSyncServer)) {
    return fail(res, 403, '该账号未开启区服参数权限，区服将由登录 token 自动识别');
  }
  if (!token) return fail(res, 400, '请提供登录 token（x-game-token-pcweb），或先在设置中保存 token');
  if (token.length < 60) return fail(res, 400, '登录 token 格式不正确');
  if (!rateLimit.allow(`sync:${req.account.id}`, 1, 30 * 1000)) {
    return fail(res, 429, '同步过于频繁，请 30 秒后再试');
  }

  const log = await scheduler.logStart(req.account.id, 'manual', serverOverride || req.account.currentServer);
  let result;
  try {
    result = await syncPrices({
      accountId: req.account.id,
      token,
      operator,
      cities: body.cities,
      server: serverOverride || undefined,
    });
  } catch (err) {
    await scheduler.logFinish(log.id, 'failed', null, err.message);
    broadcast('sync.failed', { trigger: 'manual', message: err.message }, { accountId: req.account.id });
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return fail(res, status, err.message || '同步失败');
  }
  if (provided && provided !== owner) await setAccountToken(req.account.id, provided);
  if (result.newCities.length) await invalidateDict();
  await setCurrentServer(req.account.id, result.server);
  const status = result.failed.length ? 'partial' : 'success';
  await scheduler.logFinish(log.id, status, result,
    result.failed.length ? `失败城池：${result.failed.map(f => f.city).join('、')}` : null, result.server);
  broadcast('sync.finished', { trigger: 'manual', server: result.server, result }, { accountId: req.account.id });
  return ok(res, result);
}));

module.exports = router;
