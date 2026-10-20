'use strict';

/** 游戏数据同步：POST /api/game/sync —— 用登录 token 实时抓取富甲天下价格 */

const express = require('express');
const { ok, fail, asyncHandler, cleanName } = require('../util');
const { syncPrices, CITY_MAP } = require('../game/sync');
const { setAccountToken } = require('../auth');
const scheduler = require('../scheduler');
const { broadcast } = require('../ws');
const { invalidateDict } = require('../dict-cache');

const router = express.Router();

/** GET /api/game/meta —— 同步支持范围（城池清单，供前端展示） */
router.get('/meta', asyncHandler(async (req, res) => {
  return ok(res, { cities: CITY_MAP.map(c => c.name) });
}));

/** POST /api/game/sync { token?, server?, operator?, cities? } —— token 缺省时使用本账号已保存的 token */
router.post('/sync', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const settings = await scheduler.getSettings();
  const provided = typeof body.token === 'string' ? body.token.trim() : '';
  const owner = req.account ? String(req.account.token || '') : '';
  const token = provided || owner;
  const server = cleanName(body.server, 50) || settings.server || '';
  const operator = cleanName(body.operator, 20) || (req.account && req.account.name) || settings.operator || '游戏同步';

  if (!token) return fail(res, 400, '请提供登录 token（x-game-token-pcweb），或先登录账号并保存 token');
  if (token.length < 60) return fail(res, 400, '登录 token 格式不正确');
  if (!server) return fail(res, 400, '请先输入区服');

  if (provided && req.account) await setAccountToken(req.account.id, provided);

  const log = await scheduler.logStart('manual', server);
  let result;
  try {
    result = await syncPrices({ token, server, operator, cities: body.cities });
  } catch (err) {
    await scheduler.logFinish(log.id, 'failed', null, err.message);
    broadcast('sync.failed', { trigger: 'manual', server, message: err.message });
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return fail(res, status, err.message || '同步失败');
  }
  if (result.newCities.length) await invalidateDict();
  const status = result.failed.length ? 'partial' : 'success';
  await scheduler.logFinish(log.id, status, result,
    result.failed.length ? `失败城池：${result.failed.map(f => f.city).join('、')}` : null);
  broadcast('sync.finished', { trigger: 'manual', server, result });
  return ok(res, result);
}));

module.exports = router;
