'use strict';

/** 定时同步设置：GET/PUT /api/sync-settings + 立即同步 + 运行日志 */

const express = require('express');
const cron = require('node-cron');
const { get, query } = require('../db');
const { setAccountToken, requireAccount } = require('../auth');
const scheduler = require('../scheduler');
const { ok, fail, asyncHandler, cleanName } = require('../util');

const router = express.Router();

/** GET /api/sync-settings —— 当前配置与上次运行状态（不返回 token 明文） */
router.get('/', asyncHandler(async (req, res) => {
  const s = await scheduler.getSettings();
  return ok(res, await scheduler.publicSettings(s));
}));

/** PUT /api/sync-settings { enabled, cron, token?, server?, operator? }（需登录；token 存本账号） */
router.put('/', requireAccount, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const patch = {};

  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.cron !== undefined) {
    const expr = String(body.cron || '').trim();
    if (!cron.validate(expr)) return fail(res, 400, `cron 表达式无效：${expr || '(空)'}`);
    patch.cron = expr;
  }
  if (body.token !== undefined) {
    const token = String(body.token || '').trim();
    if (token && token.length < 60) return fail(res, 400, '登录 token 格式不正确（长度过短）');
    const acc = await get('SELECT token FROM accounts WHERE id = ?', [req.account.id]);
    const saved = (acc && acc.token) || '';
    if (token !== saved) {
      await setAccountToken(req.account.id, token);
      req.account.token = token;
      patch.token = '';
      patch.tokenAccountId = req.account.id;
    }
  }
  if (body.server !== undefined) patch.server = cleanName(body.server, 50);
  if (body.operator !== undefined) patch.operator = cleanName(body.operator, 20) || '自动同步';

  const cur = await scheduler.getSettings();
  const next = { ...cur, ...patch };

  if (next.enabled && req.account) {
    const boundRow = next.tokenAccountId
      ? await get('SELECT token FROM accounts WHERE id = ?', [next.tokenAccountId])
      : null;
    const boundToken = next.tokenAccountId ? (boundRow && boundRow.token) : next.token;
    if (!boundToken) {
      const own = await get('SELECT token FROM accounts WHERE id = ?', [req.account.id]);
      if (own && own.token) {
        patch.tokenAccountId = req.account.id;
        patch.token = '';
        next.tokenAccountId = req.account.id;
        next.token = '';
      }
    }
  }

  if (next.enabled) {
    const row = next.tokenAccountId
      ? await get('SELECT token FROM accounts WHERE id = ?', [next.tokenAccountId])
      : null;
    const effective = next.tokenAccountId ? (row && row.token) : next.token;
    if (!effective || !next.server) {
      return fail(res, 400, '启用自动同步需要先保存登录 token 与区服名称');
    }
  }

  const saved = await scheduler.saveSettings(patch);
  return ok(res, await scheduler.publicSettings(saved));
}));

/** POST /api/sync-settings/run —— 使用已保存配置立即同步一次（需登录） */
router.post('/run', requireAccount, asyncHandler(async (req, res) => {
  try {
    const result = await scheduler.runNow('manual');
    return ok(res, result);
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return fail(res, status, err.message || '同步失败');
  }
}));

/** GET /api/sync-settings/logs?limit= —— 最近的同步运行记录 */
router.get('/logs', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const items = await query(
    `SELECT id, trigger_type AS triggerType, server_name AS server, started_at AS startedAt,
            finished_at AS finishedAt, status, queried, saved, failed_count AS failedCount, message
       FROM sync_log ORDER BY id DESC LIMIT ?`,
    [limit]
  );
  return ok(res, { total: items.length, items });
}));

module.exports = router;
