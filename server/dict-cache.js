'use strict';

/** 字典缓存失效 + 广播（字典增删改、游戏同步自动登记新城池时共用） */

const cache = require('./cache');
const { broadcast } = require('./ws');

async function invalidateDict() {
  await cache.invalidate('dict:');
  broadcast('dict.changed', {});
}

module.exports = { invalidateDict };
