'use strict';

/** 定时同步调度器（按账号）：每个账号独立配置，按 cron 表达式分组注册 node-cron 任务 */

const cron = require('node-cron');
const { get, run, query, nowText, ready, setCurrentServer } = require('./db');
const { syncPrices } = require('./game/sync');
const { broadcast } = require('./ws');
const { notifyMasterPriceChange } = require('./master');
const { invalidateDict } = require('./dict-cache');

const tasks = new Map(); // cronExpr -> { task, accountIds: number[] }
const running = new Set(); // accountId
const currentTrigger = new Map(); // accountId -> trigger

const DEFAULT_CRON = '0 */2 * * *';

async function getSettings(accountId) {
  const row = await get('SELECT * FROM sync_settings WHERE account_id = ?', [accountId]);
  if (!row) {
    return {
      enabled: false, cron: DEFAULT_CRON, server: '', serverOverride: '', operator: '定时同步',
      lastRunAt: null, lastStatus: null, lastMessage: null,
    };
  }
  return {
    enabled: !!Number(row.enabled),
    cron: row.cron_expr || DEFAULT_CRON,
    server: row.server_name || '',
    serverOverride: row.server_override || '',
    operator: row.operator || '定时同步',
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastMessage: row.last_message,
  };
}

async function saveSettings(accountId, patch) {
  const cur = await getSettings(accountId);
  const next = { ...cur, ...patch };
  const exists = await get('SELECT account_id FROM sync_settings WHERE account_id = ?', [accountId]);
  const t = nowText();
  if (exists) {
    await run(
      'UPDATE sync_settings SET enabled = ?, cron_expr = ?, server_name = ?, server_override = ?, operator = ? WHERE account_id = ?',
      [next.enabled ? 1 : 0, next.cron, next.server || '', next.serverOverride || '', next.operator || '定时同步', accountId]
    );
  } else {
    await run(
      `INSERT INTO sync_settings (account_id, enabled, cron_expr, server_name, server_override, operator, last_run_at, last_status, last_message)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [accountId, next.enabled ? 1 : 0, next.cron, next.server || '', next.serverOverride || '', next.operator || '定时同步']
    );
  }
  await rescheduleAll();
  return getSettings(accountId);
}

/** 同步成功后缓存登录 token 所属区服，仅用于界面展示 */
async function cacheServer(accountId, server) {
  await run('UPDATE sync_settings SET server_name = ? WHERE account_id = ?', [server || '', accountId]);
}

async function publicSettings(accountId) {
  const s = await getSettings(accountId);
  const account = await get(
    `SELECT token, current_server AS currentServer, allow_sync_server AS allowSyncServer,
            status, expires_at AS expiresAt FROM accounts WHERE id = ?`,
    [accountId]
  );
  return {
    enabled: s.enabled,
    cron: s.cron,
    server: s.server || (account && account.currentServer) || '',
    serverOverride: s.serverOverride || '',
    allowSyncServer: !!(account && Number(account.allowSyncServer)),
    operator: s.operator,
    hasToken: !!(account && account.token),
    status: account ? account.status : 'missing',
    expiresAt: (account && account.expiresAt) || null,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    lastMessage: s.lastMessage,
    running: running.has(Number(accountId)),
    serverRegistered: !!s.server,
  };
}

/** 停止并清空全部定时任务 */
function clearTasks() {
  for (const { task } of tasks.values()) {
    try { task.stop(); } catch { /* ignore */ }
  }
  tasks.clear();
}

/** 依据各账号配置重建调度（按 cron 表达式分组，同表达式只注册一个任务） */
async function rescheduleAll() {
  clearTasks();
  const rows = await query(
    `SELECT ss.account_id AS accountId, ss.cron_expr AS cron,
            ss.operator, a.token, a.status, a.expires_at AS expiresAt
       FROM sync_settings ss JOIN accounts a ON a.id = ss.account_id
      WHERE ss.enabled = 1`
  );
  const now = nowText();
  const groups = new Map();
  for (const row of rows) {
    const accountId = Number(row.accountId);
    if (!row.token) continue;
    if (row.status !== 'active') continue;
    if (row.expiresAt && String(row.expiresAt) < now) continue;
    const expr = String(row.cron || '').trim();
    if (!cron.validate(expr)) {
      console.error(`[scheduler] 账号 ${accountId} 的 cron 表达式无效：${expr || '(空)'}`);
      continue;
    }
    if (!groups.has(expr)) groups.set(expr, []);
    groups.get(expr).push(accountId);
  }
  for (const [expr, accountIds] of groups) {
    const task = cron.schedule(expr, () => {
      for (const id of accountIds) {
        runNow(id, 'cron').catch(err => console.error(`[scheduler] 账号 ${id} 自动同步失败:`, err.message));
      }
    }, { timezone: 'Asia/Shanghai' });
    tasks.set(expr, { task, accountIds });
    console.log(`[scheduler] 已启用自动同步：${expr}（账号 ${accountIds.join(', ')}）`);
  }
}

async function logStart(accountId, trigger, server) {
  const t = nowText();
  const info = await run(
    "INSERT INTO sync_log (account_id, trigger_type, server_name, started_at, status) VALUES (?, ?, ?, ?, 'running')",
    [accountId, trigger, server || null, t]
  );
  return { id: info.insertId, startedAt: t };
}

async function logFinish(id, status, result, message, server) {
  await run(
    'UPDATE sync_log SET finished_at = ?, status = ?, queried = ?, saved = ?, failed_count = ?, message = ?, server_name = COALESCE(?, server_name) WHERE id = ?',
    [
      nowText(), status,
      result ? result.queried : 0, result ? result.saved : 0,
      result && result.failed ? result.failed.length : 0,
      message || null, server || null, id,
    ]
  );
}

async function markSettings(accountId, status, message) {
  await run('UPDATE sync_settings SET last_run_at = ?, last_status = ?, last_message = ? WHERE account_id = ?', [
    nowText(), status, (message || '').slice(0, 500), accountId,
  ]);
}

/** 立即为某账号执行一次同步（自动任务 / 手动同步共用） */
async function runNow(accountId, trigger = 'manual') {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('同步账号不正确'), { status: 400 });
  }
  if (running.has(id)) {
    throw Object.assign(new Error('同步正在进行中，请稍后再试'), { status: 409 });
  }
  const s = await getSettings(id);
  const account = await get(
    'SELECT token, status, expires_at AS expiresAt, allow_sync_server AS allowSyncServer FROM accounts WHERE id = ?',
    [id]
  );
  if (!account) throw Object.assign(new Error('账号不存在'), { status: 404 });
  if (account.status !== 'active') throw Object.assign(new Error('账号已被封禁'), { status: 403 });
  if (account.expiresAt && String(account.expiresAt) < nowText()) {
    throw Object.assign(new Error('卡密已到期，请联系管理员续期'), { status: 403 });
  }
  const token = String(account.token || '').trim();
  if (!token) throw Object.assign(new Error('尚未保存游戏登录 token'), { status: 400 });
  const serverOverride = Number(account.allowSyncServer) ? s.serverOverride : '';

  running.add(id);
  currentTrigger.set(id, trigger);
  const log = await logStart(id, trigger, serverOverride || s.server);
  try {
    const result = await syncPrices({
      accountId: id,
      token,
      operator: s.operator || '定时同步',
      server: serverOverride || undefined,
    });
    if (result.newCities.length) await invalidateDict();
    await setCurrentServer(id, result.server);
    await cacheServer(id, result.server);
    const status = result.failed.length ? 'partial' : 'success';
    await logFinish(log.id, status, result, result.failed.length ? `失败城池：${result.failed.map(f => f.city).join('、')}` : null, result.server);
    await markSettings(id, status, `同步 ${result.queried}/${result.cities} 城，保存 ${result.saved} 条`);
    broadcast('sync.finished', { trigger, server: result.server, result }, { accountId: id });
    if (result.queried > 0) {
      await notifyMasterPriceChange(id, {
        server: result.server, city: '', operator: s.operator || '定时同步', tax: null, items: [],
      });
    }
    return result;
  } catch (err) {
    await logFinish(log.id, 'failed', null, err.message);
    await markSettings(id, 'failed', err.message);
    broadcast('sync.failed', { trigger, message: err.message }, { accountId: id });
    throw err;
  } finally {
    running.delete(id);
    currentTrigger.delete(id);
  }
}

async function start() {
  await ready();
  await rescheduleAll();
}

function stop() {
  clearTasks();
}

function status() {
  return { running: running.size, accounts: [...running], triggers: Object.fromEntries(currentTrigger) };
}

module.exports = {
  getSettings, saveSettings, cacheServer, publicSettings, rescheduleAll, runNow, start, stop, status, logStart, logFinish,
};
