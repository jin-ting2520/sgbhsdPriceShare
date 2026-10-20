'use strict';

/** 字典（只读）：城池 / 商品下拉数据源；维护入口在管理后台 */

const express = require('express');
const { query } = require('../db');
const cache = require('../cache');
const { requireAccount } = require('../auth');
const { ok, fail, asyncHandler, cleanName } = require('../util');

const router = express.Router();

router.use(requireAccount);

const VALID_TYPES = new Set(['city', 'commodity']);
const TYPE_NAMES = { city: '城池', commodity: '商品' };
const CACHE_TTL = 120;

/** GET /api/dict?type=city  —— 下拉数据源（可按 keyword 过滤） */
router.get('/', asyncHandler(async (req, res) => {
  const type = String(req.query.type || '');
  if (!VALID_TYPES.has(type)) return fail(res, 400, '字典类型必须为 city 或 commodity');

  const keyword = cleanName(req.query.keyword, 30);
  const onlyEnabled = req.query.enabled !== '0';
  const cacheKey = `dict:${type}:${onlyEnabled ? 1 : 0}:${keyword}`;

  const data = await cache.getOrSet(cacheKey, CACHE_TTL, async () => {
    let rows;
    if (keyword) {
      rows = await query(
        `SELECT id, type, name, burden, sort_order, status FROM dict_items
         WHERE type = ? ${onlyEnabled ? 'AND status = 1' : ''} AND name LIKE ?
         ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, sort_order, id LIMIT 50`,
        [type, `%${keyword}%`, keyword, `${keyword}%`]
      );
    } else {
      rows = await query(
        `SELECT id, type, name, burden, sort_order, status FROM dict_items
         WHERE type = ? ${onlyEnabled ? 'AND status = 1' : ''}
         ORDER BY sort_order, id`,
        [type]
      );
    }
    return { type, typeName: TYPE_NAMES[type], total: rows.length, items: rows };
  });

  return ok(res, data);
}));

module.exports = router;
