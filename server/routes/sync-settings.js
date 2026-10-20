'use strict';

/** 定时同步设置（按账号）：GET/PUT /api/sync-settings + 立即同步 + 运行日志 */

const express = require('express');
const cron = require('node-cron');
const { get, query } = require('../db');
const { setAccountToken, requireAccount } = require('../auth');
const scheduler = require('../scheduler');
const rateLimit = require('../ratelimit');
const { broadcast } = require('../ws');
const { ok, fail, asyncHandler, cleanName } = require('../util');

const router = express.Router();

router.use(requireAccount);

/** GET /api/sync-settings —— 当前账号配置与上次运行状态（不返回 token 明文） */
router.get('/', asyncHandler(async (req, res) => {
  return ok(res, await scheduler.publicSettings(req.account.id));
}));

/** PUT /api/sync-settings { enabled, cron, token?, operator?, server? }
 *  默认由 token 自动识别区服；server 仅在管理员开启该账号区服参数权限后可用。 */
router.put('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  const account = await get(
    'SELECT token, allow_sync_server AS allowSyncServer FROM accounts WHERE id = ?',
    [req.account.id]
  );

  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.cron !== undefined) {
    const expr = String(body.cron || '').trim();
    if (!cron.validate(expr)) return fail(res, 400, `cron 表达式无效：${expr || '(空)'}`);
    patch.cron = expr;
  }
  if (body.server !== undefined) {
    const server = cleanName(body.server, 50);
    if (server && !Number(account && account.allowSyncServer)) {
      return fail(res, 403, '该账号未开启区服参数权限，区服将由登录 token 自动识别');
    }
    patch.serverOverride = server;
  }
  if (body.token !== undefined) {
    const token = String(body.token || '').trim();
    if (token && token.length < 60) return fail(res, 400, '登录 token 格式不正确（长度过短）');
    if (token !== ((account && account.token) || '')) {
      await setAccountToken(req.account.id, token);
      account.token = token;
      req.account.token = token;
    }
  }
  if (body.operator !== undefined) patch.operator = cleanName(body.operator, 20) || '定时同步';

  const next = { ...(await scheduler.getSettings(req.account.id)), ...patch };

  if (next.enabled && !(account && account.token)) {
    return fail(res, 400, '启用自动同步需要先保存登录 token');
  }

  const saved = await scheduler.saveSettings(req.account.id, patch);
  const view = await scheduler.publicSettings(req.account.id);
  broadcast('settings.updated', { settings: view }, { accountId: req.account.id });
  return ok(res, view);
}));

/** POST /api/sync-settings/run —— 使用已保存配置立即同步一次（同账号 30 秒一次） */
router.post('/run', asyncHandler(async (req, res) => {
  if (!rateLimit.allow(`sync:${req.account.id}`, 1, 30 * 1000)) {
    return fail(res, 429, '同步过于频繁，请 30 秒后再试');
  }
  try {
    const result = await scheduler.runNow(req.account.id, 'manual');
    return ok(res, result);
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return fail(res, status, err.message || '同步失败');
  }
}));

/** GET /api/sync-settings/logs?limit= —— 本账号最近的同步运行记录 */
router.get('/logs', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const items = await query(
    `SELECT id, trigger_type AS triggerType, server_name AS server, started_at AS startedAt,
            finished_at AS finishedAt, status, queried, saved, failed_count AS failedCount, message
       FROM sync_log WHERE account_id = ? ORDER BY id DESC LIMIT ?`,
    [req.account.id, limit]
  );
  return ok(res, { total: items.length, items });
}));

module.exports = router;
