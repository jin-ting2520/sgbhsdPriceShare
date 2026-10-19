'use strict';

/** 统一响应与校验工具 */

function ok(res, data) {
  res.json({ code: 0, message: 'success', data });
}

function fail(res, status, message, code = 1) {
  res.status(status).json({ code, message, data: null });
}

/** express 4 不捕获 async 异常，手动包装 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** 名称清洗：去首尾空白，压缩连续空白，限长 */
function cleanName(v, max = 50) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

/** 价格解析：空 -> null；非负数字 -> number；否则返回错误 */
function parsePrice(v) {
  if (v === '' || v == null) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '价格必须为不小于 0 的数字' };
  if (n > 999999999) return { ok: false, error: '价格超出允许范围' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** 判断唯一约束冲突（SQLite / MySQL） */
function isUniqueConstraintError(err) {
  return !!err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    err.code === 'ER_DUP_ENTRY' ||
    Number(err.errcode) === 2067 ||
    Number(err.errno) === 1062 ||
    String(err.message || '').includes('UNIQUE constraint failed') ||
    String(err.message || '').includes('Duplicate entry'));
}

module.exports = { ok, fail, asyncHandler, cleanName, isBlank, parsePrice, isUniqueConstraintError };
