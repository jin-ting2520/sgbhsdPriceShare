'use strict';

/**
 * 注册卡密：一次性使用，三种有效期（1 天 / 1 月 / 永久）
 * 有效期从「使用卡密注册」时刻起算；到期后禁止登录，数据保留，管理员可续期或换卡。
 */

const crypto = require('node:crypto');
const { run, tx, formatTime, nowText } = require('./db');
const { isUniqueConstraintError } = require('./util');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去除 0/O/1/I，避免抄写歧义
const CHARS = 16;
const GROUP = 4;
const MAX_BATCH = 500;

const KEY_TYPES = {
  day: { days: 1, label: '1 天' },
  month: { days: 30, label: '1 月' },
  forever: { days: null, label: '永久' },
};

const KEY_TYPE_NAMES = Object.fromEntries(Object.entries(KEY_TYPES).map(([k, v]) => [k, v.label]));
const KEY_STATUS_NAMES = { unused: '未使用', used: '已使用', revoked: '已作废' };

function randomChars(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function generateCode() {
  const groups = [];
  for (let i = 0; i < CHARS / GROUP; i++) groups.push(randomChars(GROUP));
  return groups.join('-');
}

/** 归一化用户输入的卡密：大写、去分隔符、按 4 位重新分组 */
function normalizeCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CHARS);
  return raw ? raw.replace(new RegExp(`(.{${GROUP}})(?=.)`, 'g'), '$1-') : '';
}

/** 按卡密类型计算到期时间（NULL = 永久） */
function expiresAtFor(type, fromMs = Date.now()) {
  const spec = KEY_TYPES[type];
  if (!spec || spec.days == null) return null;
  return formatTime(fromMs + spec.days * 86400000);
}

/** 批量生成卡密 */
async function createBatch({ type, count = 1, note = '' }) {
  if (!KEY_TYPES[type]) throw Object.assign(new Error('卡密类型必须为 day / month / forever'), { status: 400 });
  const n = Math.min(Math.max(Number(count) || 1, 1), MAX_BATCH);
  const batchId = `B${Date.now().toString(36).toUpperCase()}${randomChars(4)}`;
  const t = nowText();
  const codes = [];
  await tx(async conn => {
    for (let i = 0; i < n; i++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = generateCode();
        try {
          // eslint-disable-next-line no-await-in-loop
          await conn.run(
            'INSERT INTO invite_keys (code, type, status, note, batch_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [code, type, 'unused', note || null, batchId, t]
          );
          codes.push(code);
          break;
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
        }
      }
    }
  });
  return { batchId, type, count: codes.length, codes };
}

/**
 * 校验卡密（事务内使用）：返回 { row } 或 { error }
 * 仅校验状态，不标记使用；创建账号后调用 useKey 标记。
 */
async function validateKey(conn, rawCode) {
  const code = normalizeCode(rawCode);
  if (code.replace(/-/g, '').length !== CHARS) {
    return { error: '卡密格式不正确（应为 16 位字符，可含分隔符）' };
  }
  const row = await conn.get('SELECT * FROM invite_keys WHERE code = ?', [code]);
  if (!row) return { error: '卡密不存在，请检查是否输入有误' };
  if (row.status === 'revoked') return { error: '卡密已被作废，请联系管理员' };
  if (row.status === 'used') return { error: '卡密已被使用，请联系管理员' };
  return { row };
}

/** 事务内标记卡密已使用并绑定账号（并发下仅一次成功） */
async function useKey(conn, keyId, accountId) {
  const res = await conn.run(
    "UPDATE invite_keys SET status = 'used', used_at = ?, account_id = ? WHERE id = ? AND status = 'unused'",
    [nowText(), accountId, keyId]
  );
  return res.affectedRows === 1;
}

module.exports = {
  KEY_TYPES,
  KEY_TYPE_NAMES,
  KEY_STATUS_NAMES,
  MAX_BATCH,
  generateCode,
  normalizeCode,
  expiresAtFor,
  createBatch,
  validateKey,
  useKey,
  ALPHABET,
};
