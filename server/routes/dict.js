'use strict';

/** 字典管理：城池 / 商品 */

const express = require('express');
const { db, createDictItem, nowText } = require('../db');
const {
  ok, fail, asyncHandler, cleanName, isBlank,
  isUniqueConstraintError,
} = require('../util');

const router = express.Router();

const VALID_TYPES = new Set(['city', 'commodity']);
const TYPE_NAMES = { city: '城池', commodity: '商品' };

/** 负重校验：空 -> null；否则须为 0 < x <= 9999 的数字 */
function parseBurden(v) {
  if (v === '' || v == null) return { value: null, error: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return { value: null, error: '负重必须是大于 0 的数字' };
  if (n > 9999) return { value: null, error: '负重不能超过 9999' };
  return { value: Math.round(n * 100) / 100, error: null };
}

/** GET /api/dict?type=city  —— 下拉数据源（可按 keyword 过滤） */
router.get('/', asyncHandler((req, res) => {
  const type = String(req.query.type || '');
  if (!VALID_TYPES.has(type)) return fail(res, 400, '字典类型必须为 city 或 commodity');

  const keyword = cleanName(req.query.keyword, 30);
  const onlyEnabled = req.query.enabled !== '0';

  let rows;
  if (keyword) {
    rows = db.prepare(
      `SELECT id, type, name, burden, sort_order, status FROM dict_items
       WHERE type = ? ${onlyEnabled ? 'AND status = 1' : ''} AND name LIKE ?
       ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, sort_order, id LIMIT 50`
    ).all(type, `%${keyword}%`, keyword, `${keyword}%`);
  } else {
    rows = db.prepare(
      `SELECT id, type, name, burden, sort_order, status FROM dict_items
       WHERE type = ? ${onlyEnabled ? 'AND status = 1' : ''}
       ORDER BY sort_order, id`
    ).all(type);
  }
  return ok(res, { type, typeName: TYPE_NAMES[type], total: rows.length, items: rows });
}));

/** GET /api/dict/summary —— 管理弹窗使用（含价格引用计数） */
router.get('/summary', asyncHandler((req, res) => {
  const list = (type) => db.prepare(
    `SELECT d.id, d.type, d.name, d.sort_order, d.status, d.burden,
            (SELECT COUNT(*) FROM prices p WHERE p.city_id = d.id) AS city_used,
            (SELECT COUNT(*) FROM prices p WHERE p.commodity_id = d.id) AS commodity_used
       FROM dict_items d WHERE d.type = ? ORDER BY d.sort_order, d.id`
  ).all(type);
  return ok(res, {
    city: list('city'),
    commodity: list('commodity'),
  });
}));

/** POST /api/dict { type, name, burden } —— 新增城池 / 商品（不可重复） */
router.post('/', asyncHandler((req, res) => {
  const type = String(req.body.type || '');
  const name = cleanName(req.body.name);
  const burden = parseBurden(req.body.burden);
  if (!VALID_TYPES.has(type)) return fail(res, 400, '字典类型必须为 city 或 commodity');
  if (isBlank(name)) return fail(res, 400, `请输入${TYPE_NAMES[type]}名称`);
  if (name.length > 20) return fail(res, 400, '名称不能超过 20 个字符');
  if (burden.error) return fail(res, 400, burden.error);

  try {
    const item = createDictItem(type, name, burden.value);
    return ok(res, item);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return fail(res, 409, `${TYPE_NAMES[type]}「${name}」已存在，不能重复添加`, 40901);
    }
    throw err;
  }
}));

/** PUT /api/dict/:id —— 重命名 / 启停 / 排序 */
router.put('/:id', asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM dict_items WHERE id = ?').get(id);
  if (!item) return fail(res, 404, '字典项不存在');

  const patches = [];

  if (req.body.name !== undefined) {
    const name = cleanName(req.body.name);
    if (isBlank(name)) return fail(res, 400, '名称不能为空');
    if (name.length > 20) return fail(res, 400, '名称不能超过 20 个字符');
    patches.push({ sql: 'name = ?', v: name });
  }
  if (req.body.burden !== undefined) {
    const burden = parseBurden(req.body.burden);
    if (burden.error) return fail(res, 400, burden.error);
    patches.push({ sql: 'burden = ?', v: burden.value });
  }
  if (req.body.status !== undefined) {
    patches.push({ sql: 'status = ?', v: req.body.status ? 1 : 0 });
  }
  if (req.body.sort_order !== undefined) {
    patches.push({ sql: 'sort_order = ?', v: Number(req.body.sort_order) || 0 });
  }
  if (!patches.length) return fail(res, 400, '没有需要更新的字段');

  try {
    db.prepare(`UPDATE dict_items SET ${patches.map(p => p.sql).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...patches.map(p => p.v), nowText(), id);
  } catch (err) {
    if (isUniqueConstraintError(err)) return fail(res, 409, '同名项已存在，不能重复', 40901);
    throw err;
  }
  return ok(res, db.prepare('SELECT * FROM dict_items WHERE id = ?').get(id));
}));

/** DELETE /api/dict/:id —— 已被价格引用的项不允许删除 */
router.delete('/:id', asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM dict_items WHERE id = ?').get(id);
  if (!item) return fail(res, 404, '字典项不存在');

  const used = item.type === 'city'
    ? db.prepare('SELECT COUNT(*) AS n FROM prices WHERE city_id = ?').get(id).n
    : db.prepare('SELECT COUNT(*) AS n FROM prices WHERE commodity_id = ?').get(id).n;
  if (used > 0) {
    return fail(res, 409, `「${item.name}」已被 ${used} 条价格记录引用，不能删除（可停用）`, 40902);
  }
  db.prepare('DELETE FROM dict_items WHERE id = ?').run(id);
  return ok(res, { id, deleted: true });
}));

module.exports = router;
