'use strict';

/** 命令行同步（按账号）：
 *   node server/scripts/game-sync.js <账号ID> <token> [操作人]   —— 直接指定 token 同步（区服自动识别）
 *   node server/scripts/game-sync.js --settings <账号ID>         —— 使用该账号「定时同步」配置
 *   token 也可用环境变量 GAME_TOKEN 提供 */

const scheduler = require('../scheduler');
const { setCurrentServer } = require('../db');
const { syncPrices } = require('../game/sync');

const args = process.argv.slice(2);

function usage() {
  console.error('用法: node server/scripts/game-sync.js <账号ID> <x-game-token-pcweb> [操作人]');
  console.error('   或: node server/scripts/game-sync.js --settings <账号ID>');
}

(async () => {
  let result;
  if (args[0] === '--settings') {
    const accountId = Number(args[1]);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      usage();
      process.exit(1);
    }
    result = await scheduler.runNow(accountId, 'cli');
  } else {
    const accountId = Number(args[0]);
    const token = args[1] || process.env.GAME_TOKEN || '';
    const operator = args[2] || '游戏同步';
    if (!Number.isInteger(accountId) || accountId <= 0 || !token) {
      usage();
      process.exit(1);
    }
    const log = await scheduler.logStart(accountId, 'cli');
    try {
      result = await syncPrices({ accountId, token, operator });
      await setCurrentServer(accountId, result.server);
      await scheduler.cacheServer(accountId, result.server);
      await scheduler.logFinish(log.id, result.failed.length ? 'partial' : 'success', result,
        result.failed.length ? `失败城池：${result.failed.map(f => f.city).join('、')}` : null, result.server);
    } catch (err) {
      await scheduler.logFinish(log.id, 'failed', null, err.message);
      throw err;
    }
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch(err => {
  console.error('同步失败:', err.message);
  process.exit(1);
});
