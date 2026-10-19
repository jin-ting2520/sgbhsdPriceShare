'use strict';

/**
 * Redis 缓存（可选）：REDIS_URL 未配置或连接失败时自动退化为无缓存。
 * 目前用于字典数据（城池/商品），写操作后按前缀失效。
 */

const REDIS_URL = process.env.REDIS_URL || '';

let client = null;
let state = REDIS_URL ? 'idle' : 'off';
let connecting = null;
let warned = false;

function status() {
  return state;
}

async function connect() {
  if (!REDIS_URL || state === 'ok' || connecting) return connecting;
  state = 'connecting';
  connecting = (async () => {
    try {
      const { createClient } = require('redis');
      client = createClient({ url: REDIS_URL, socket: { connectTimeout: 3000, reconnectStrategy: retries => (retries > 5 ? false : Math.min(retries * 500, 3000)) } });
      client.on('error', err => {
        if (!warned) {
          console.error(`[cache] Redis 不可用，已退化为无缓存：${err.message}`);
          warned = true;
        }
        state = 'error';
      });
      client.on('ready', () => { state = 'ok'; warned = false; });
      client.on('end', () => { if (state === 'ok') state = 'error'; });
      await client.connect();
      state = 'ok';
      console.log(`[cache] Redis 已连接：${REDIS_URL}`);
    } catch (err) {
      if (!warned) {
        console.error(`[cache] Redis 连接失败，已退化为无缓存：${err.message}`);
        warned = true;
      }
      state = 'error';
    }
  })();
  return connecting;
}

/** 读取缓存；miss 时调用 loader 并回填 */
async function getOrSet(key, ttlSeconds, loader) {
  if (state === 'ok') {
    try {
      const v = await client.get(key);
      if (v != null) return JSON.parse(v);
    } catch { /* fallthrough */ }
  }
  const data = await loader();
  if (state === 'ok') {
    try {
      await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
    } catch { /* ignore */ }
  }
  return data;
}

/** 按前缀删除缓存（字典变更时调用） */
async function invalidate(prefix) {
  if (state !== 'ok') return;
  try {
    let cursor = '0';
    do {
      const res = await client.scan(cursor, { MATCH: `${prefix}*`, COUNT: 200 });
      cursor = res.cursor;
      if (res.keys.length) await client.del(res.keys);
    } while (cursor !== '0');
  } catch { /* ignore */ }
}

async function close() {
  if (client && state === 'ok') {
    try { await client.quit(); } catch { /* ignore */ }
  }
}

module.exports = { connect, getOrSet, invalidate, status, close, REDIS_URL };
