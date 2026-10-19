'use strict';

/** 命令行同步：
 *   node server/scripts/game-sync.js <token> [区服名] [操作人]    —— 直接指定 token 同步
 *   node server/scripts/game-sync.js --settings                  —— 使用「同步设置」中保存的配置
 *   token 也可用环境变量 GAME_TOKEN 提供 */

const scheduler = require('../scheduler');
const { syncPrices } = require('../game/sync');

const args = process.argv.slice(2);

(async () => {
  let result;
  if (args[0] === '--settings') {
    result = await scheduler.runNow('cli');
  } else {
    const token = args[0] || process.env.GAME_TOKEN || '';
    const server = args[1] || 'S1';
    const operator = args[2] || '游戏同步';
    if (!token) {
      console.error('用法: node server/scripts/game-sync.js <x-game-token-pcweb> [区服名] [操作人]');
      console.error('   或: node server/scripts/game-sync.js --settings');
      process.exit(1);
    }
    const log = await scheduler.logStart('cli', server);
    try {
      result = await syncPrices({ token, server, operator });
      await scheduler.logFinish(log.id, result.failed.length ? 'partial' : 'success', result,
        result.failed.length ? `失败城池：${result.failed.map(f => f.city).join('、')}` : null);
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
