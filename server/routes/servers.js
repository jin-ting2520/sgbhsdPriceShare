'use strict';

/** 区服（只读）：已登记区服下拉；维护入口在管理后台；价格数据按账号隔离 */

const express = require('express');
const { query } = require('../db');
const { requireAccount } = require('../auth');
const { ok, asyncHandler, cleanName } = require('../util');

const router = express.Router();

router.use(requireAccount);

/** GET /api/servers?keyword= —— 本账号使用过的区服列表（按最近更新时间倒序） */
router.get('/', asyncHandler(async (req, res) => {
  const accountId = req.account.id;
  const keyword = cleanName(req.query.keyword, 30);
  const rows = keyword
    ? await query(
      `SELECT s.id, s.name,
              (SELECT MAX(updated_at) FROM prices p WHERE p.server_id = s.id AND p.account_id = ?) AS last_used_at,
              (SELECT COUNT(*) FROM prices p WHERE p.server_id = s.id AND p.account_id = ?) AS price_count
         FROM servers s WHERE s.name LIKE ?
        ORDER BY last_used_at IS NULL, last_used_at DESC, s.id DESC LIMIT 20`,
      [accountId, accountId, `%${keyword}%`]
    )
    : await query(
      `SELECT s.id, s.name,
              (SELECT MAX(updated_at) FROM prices p WHERE p.server_id = s.id AND p.account_id = ?) AS last_used_at,
              (SELECT COUNT(*) FROM prices p WHERE p.server_id = s.id AND p.account_id = ?) AS price_count
         FROM servers s
        ORDER BY last_used_at IS NULL, last_used_at DESC, s.id DESC LIMIT 50`,
      [accountId, accountId]
    );

  return ok(res, {
    total: rows.length,
    items: rows.map(r => ({
      id: r.id,
      name: r.name,
      lastUsedAt: r.last_used_at,
      priceCount: Number(r.price_count) || 0,
    })),
  });
}));

module.exports = router;
