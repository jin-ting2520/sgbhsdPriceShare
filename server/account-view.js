'use strict';

/** 账号公开视图：密码登录 / 工具 SSO 登录共用同一返回结构 */

const { clampRelief } = require('./tax');
const { masterMeta } = require('./master');

/**
 * @param {object} row accounts 表行
 * @param {boolean} created 本次是否新建账号
 * @param {string} session 会话 token（请求签名密钥）
 * @param {object} [extra] 附加字段（deviceId / keyType / renewed ...）
 */
async function publicAccount(row, created, session, extra = {}) {
  const meta = await masterMeta(row);
  return {
    name: row.name,
    session,
    token: row.token || '',
    relief: clampRelief(row.relief),
    created: !!created,
    currentServer: row.current_server || '',
    allowSyncServer: !!Number(row.allow_sync_server),
    deviceLimit: Math.max(1, Number(row.device_limit) || 3),
    expiresAt: row.expires_at || null,
    hasKey: !!row.key_code,
    trial: !row.key_code,
    keyType: row.key_code ? (extra.keyType || null) : null,
    masterAccountId: meta.masterAccountId,
    masterAccountName: meta.masterAccountName,
    isMaster: meta.isMaster,
    masterPricesAllowed: meta.masterPricesAllowed,
    viewMasterPrices: meta.viewMasterPrices,
    // 是否由工具 SSO 自动创建/绑定（密码登录的普通账号为 false）
    sso: !!row.sso_source,
    ...extra,
  };
}

module.exports = { publicAccount };
