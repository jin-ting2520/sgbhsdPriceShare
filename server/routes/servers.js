'use strict';

/** 区服：自由文本输入 + 自动登记 */

const express = require('express');
const { db, findServerId } = require('../db');
const { ok, fail, asyncHandler, cleanName } = require('../util');

const router = express.Router();

/** GET /api/servers?keyword= —— 已登记区服列表（按最近更新时间倒序） */
router.get('/', asyncHandler((req, res) => {
  const keyword = cleanName(req.query.keyword, 30);
  const rows = keyword
    ? db.prepare(
        `SELECT s.id, s.name,
                (SELECT MAX(updated_at) FROM prices p WHERE p.server_id = s.id) AS last_used_at,
                (SELECT COUNT(*) FROM prices p WHERE p.server_id = s.id) AS price_count
           FROM servers s WHERE s.name LIKE ?
          ORDER BY last_used_at IS NULL, last_used_at DESC, s.id DESC LIMIT 20`
      ).all(`%${keyword}%`)
    : db.prepare(
        `SELECT s.id, s.name,
                (SELECT MAX(updated_at) FROM prices p WHERE p.server_id = s.id) AS last_used_at,
                (SELECT COUNT(*) FROM prices p WHERE p.server_id = s.id) AS price_count
           FROM servers s
          ORDER BY last_used_at IS NULL, last_used_at DESC, s.id DESC LIMIT 50`
      ).all();

  return ok(res, {
    total: rows.length,
    items: rows.map(r => ({
      id: r.id,
      name: r.name,
      lastUsedAt: r.last_used_at,
      priceCount: r.price_count,
    })),
  });
}));

/** DELETE /api/servers/:id —— 删除区服及其全部价格 */
router.delete('/:id', asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!s) return fail(res, 404, '区服不存在');
  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  return ok(res, { id, deleted: true, name: s.name });
}));

module.exports = router;
