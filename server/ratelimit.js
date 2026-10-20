'use strict';

/** 简易内存限流（单实例）：key -> 滑动窗口计数 */

const buckets = new Map();

function allow(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

/** 生成 express 中间件：limit 次 / windowMs 毫秒，默认按 IP 计数 */
function middleware(limit, windowMs, keyFn) {
  return (req, res, next) => {
    const key = (keyFn ? keyFn(req) : req.ip) || 'unknown';
    if (!allow(`m:${limit}:${windowMs}:${key}`, limit, windowMs)) {
      res.status(429).json({ code: 429, message: '操作过于频繁，请稍后再试', data: null });
      return;
    }
    next();
  };
}

/** 账号维度限流（需在 attach 之后使用） */
function accountMiddleware(limit, windowMs) {
  return (req, res, next) => {
    const key = req.account ? `a${req.account.id}` : `ip${req.ip}`;
    if (!allow(`a:${limit}:${windowMs}:${key}`, limit, windowMs)) {
      res.status(429).json({ code: 429, message: '操作过于频繁，请稍后再试', data: null });
      return;
    }
    next();
  };
}

function reset() {
  buckets.clear();
}

const timer = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { allow, middleware, accountMiddleware, reset };
