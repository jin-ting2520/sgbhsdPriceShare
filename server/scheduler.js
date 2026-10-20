'use strict';

/** 定时同步调度器：配置存于 sync_settings，使用 node-cron（Asia/Shanghai） */

const cron = require('node-cron');
const { get, run, query, nowText, ready } = require('./db');
const { syncPrices } = require('./game/sync');
const { broadcast } = require('./ws');
const { invalidateDict } = require('./dict-cache');

let task = null;
let running = false;
let currentTrigger = null;

async function getSettings() {
  const row = await get('SELECT * FROM sync_settings WHERE id = 1');
  if (!row) {
    return {
      enabled: false, cron: '0 */2 * * *', token: '', tokenAccountId: null, server: '', operator: '自动同步',
      lastRunAt: null, lastStatus: null, lastMessage: null,
    };
  }
  return {
    enabled: !!Number(row.enabled),
    cron: row.cron_expr,
    token: row.token || '',
    tokenAccountId: row.token_account_id == null ? null : Number(row.token_account_id),
    server: row.server_name || '',
    operator: row.operator || '自动同步',
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastMessage: row.last_message,
  };
}

/** 解析定时同步实际使用的 token：优先账号表，历史单行 token 仅作兜底 */
async function resolveToken(s) {
  if (s.tokenAccountId) {
    const row = await get('SELECT token FROM accounts WHERE id = ?', [s.tokenAccountId]);
    return (row && row.token) || '';
  }
  return s.token || '';
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await run(
    `UPDATE sync_settings SET enabled = ?, cron_expr = ?, token = ?, token_account_id = ?, server_name = ?, operator = ? WHERE id = 1`,
    [
      next.enabled ? 1 : 0, next.cron, next.token || null,
      next.tokenAccountId == null ? null : next.tokenAccountId,
      next.server || '', next.operator || '自动同步',
    ]
  );
  await reschedule();
  const saved = await getSettings();
  broadcast('settings.updated', { settings: await publicSettings(saved) });
  return saved;
}

async function publicSettings(s) {
  const token = await resolveToken(s);
  let tokenOwner = null;
  if (s.tokenAccountId) {
    const row = await get('SELECT name FROM accounts WHERE id = ?', [s.tokenAccountId]);
    tokenOwner = row ? row.name : null;
  }
  return {
    enabled: s.enabled,
    cron: s.cron,
    server: s.server,
    operator: s.operator,
    hasToken: !!token,
    tokenOwner,
    legacyToken: !s.tokenAccountId && !!s.token,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    lastMessage: s.lastMessage,
    running,
  };
}

async function reschedule() {
  if (task) {
    try { task.stop(); } catch { /* ignore */ }
    task = null;
  }
  const s = await getSettings();
  if (!s.enabled || !s.server) return;
  if (!(await resolveToken(s))) return;
  if (!cron.validate(s.cron)) {
    console.error(`[scheduler] 无效 cron 表达式：${s.cron}`);
    return;
  }
  task = cron.schedule(s.cron, () => {
    runNow('cron').catch(err => console.error('[scheduler] 自动同步失败:', err.message));
  }, { timezone: 'Asia/Shanghai' });
  console.log(`[scheduler] 已启用自动同步：${s.cron}（区服 ${s.server}）`);
}

async function logStart(trigger, server) {
  const t = nowText();
  const info = await run(
    `INSERT INTO sync_log (trigger_type, server_name, started_at, status) VALUES (?, ?, ?, 'running')`,
    [trigger, server || null, t]
  );
  return { id: info.insertId, startedAt: t };
}

async function logFinish(id, status, result, message) {
  await run(
    `UPDATE sync_log SET finished_at = ?, status = ?, queried = ?, saved = ?, failed_count = ?, message = ? WHERE id = ?`,
    [
      nowText(), status,
      result ? result.queried : 0, result ? result.saved : 0,
      result && result.failed ? result.failed.length : 0,
      message || null, id,
    ]
  );
}

async function markSettings(status, message) {
  await run('UPDATE sync_settings SET last_run_at = ?, last_status = ?, last_message = ? WHERE id = 1', [
    nowText(), status, (message || '').slice(0, 500),
  ]);
}

/**
 * 立即执行一次（自动任务 / 设置页「立即同步」）
 * @returns 同步结果
 */
async function runNow(trigger = 'manual') {
  if (running) {
    throw Object.assign(new Error('同步正在进行中，请稍后再试'), { status: 409 });
  }
  const s = await getSettings();
  const token = await resolveToken(s);
  if (!token) throw Object.assign(new Error('尚未保存游戏登录 token（请在「定时」中保存本账号 token）'), { status: 400 });
  if (!s.server) throw Object.assign(new Error('尚未设置同步区服'), { status: 400 });

  running = true;
  currentTrigger = trigger;
  const log = await logStart(trigger, s.server);
  try {
    const result = await syncPrices({
      token,
      server: s.server,
      operator: s.operator || '自动同步',
    });
    if (result.newCities.length) await invalidateDict();
    const status = result.failed.length ? 'partial' : 'success';
    await logFinish(log.id, status, result, result.failed.length ? `失败城池：${result.failed.map(f => f.city).join('、')}` : null);
    await markSettings(status, `同步 ${result.queried}/${result.cities} 城，保存 ${result.saved} 条`);
    broadcast('sync.finished', { trigger, result });
    return result;
  } catch (err) {
    await logFinish(log.id, 'failed', null, err.message);
    await markSettings('failed', err.message);
    broadcast('sync.failed', { trigger, message: err.message });
    throw err;
  } finally {
    running = false;
    currentTrigger = null;
  }
}

async function start() {
  await ready();
  await reschedule();
}

function stop() {
  if (task) {
    try { task.stop(); } catch { /* ignore */ }
    task = null;
  }
}

function status() {
  return { running, trigger: currentTrigger };
}

module.exports = {
  getSettings, saveSettings, publicSettings, reschedule, runNow, start, stop, status, logStart, logFinish,
};
