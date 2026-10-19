'use strict';

/** 游戏数据同步：POST /api/game/sync —— 用登录 token 实时抓取富甲天下价格 */

const express = require('express');
const { ok, fail, asyncHandler, cleanName } = require('../util');
const { syncPrices, CITY_MAP } = require('../game/sync');
const scheduler = require('../scheduler');
const { broadcast } = require('../ws');

const router = express.Router();

/** GET /api/game/meta —— 同步支持范围（城池清单，供前端展示） */
router.get('/meta', asyncHandler(async (req, res) => {
  return ok(res, { cities: CITY_MAP.map(c => c.name) });
}));

/** POST /api/game/sync { token?, server?, operator?, cities? } —— token/区服缺省时取同步设置中的值 */
router.post('/sync', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const settings = await scheduler.getSettings();
  const token = (typeof body.token === 'string' && body.token.trim()) || settings.token || '';
  const server = cleanName(body.server, 50) || settings.server || '';
  const operator = cleanName(body.operator, 20) || settings.operator || '游戏同步';

  if (!token) return fail(res, 400, '请提供登录 token（x-game-token-pcweb），或在「同步设置」中保存');
  if (token.length < 60) return fail(res, 400, '登录 token 格式不正确');
  if (!server) return fail(res, 400, '请先输入区服');

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
  const status = result.failed.length ? 'partial' : 'success';
  await scheduler.logFinish(log.id, status, result,
    result.failed.length ? `失败城池：${result.failed.map(f => f.city).join('、')}` : null);
  broadcast('sync.finished', { trigger: 'manual', server, result });
  return ok(res, result);
}));

module.exports = router;
