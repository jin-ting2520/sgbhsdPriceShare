'use strict';

/** 主账号价格共享：全局唯一主账号、查看偏好与共享广播 */

const { get, query } = require('./db');
const { broadcast } = require('./ws');

async function getMasterAccount() {
  const row = await get(
    `SELECT a.id, a.name, a.status
       FROM app_settings s
       JOIN accounts a ON a.id = s.master_account_id
      WHERE s.id = 1`
  );
  return row || null;
}

async function masterMeta(account) {
  const master = await getMasterAccount();
  const isMaster = !!(master && account && Number(master.id) === Number(account.id));
  const allowed = !!(account && Number(account.masterPricesAllowed ?? account.allow_master_prices ?? 1));
  const preference = !!(account && Number(account.viewMasterPrices ?? account.view_master_prices));
  return {
    master,
    masterAccountId: master ? Number(master.id) : null,
    masterAccountName: master ? master.name : '',
    isMaster,
    masterPricesAllowed: !isMaster && allowed,
    viewMasterPrices: !isMaster && !!master && allowed && preference,
  };
}

async function masterViewerIds() {
  const master = await getMasterAccount();
  if (!master) return [];
  const rows = await query(
    'SELECT id FROM accounts WHERE view_master_prices = 1 AND allow_master_prices = 1 AND id <> ?',
    [master.id]
  );
  return rows.map(r => Number(r.id));
}

async function notifyMasterPriceChange(accountId, payload) {
  const master = await getMasterAccount();
  if (!master || Number(master.id) !== Number(accountId)) return;
  const accountIds = await masterViewerIds();
  if (!accountIds.length) return;
  broadcast('price.updated', {
    ...payload,
    shared: true,
    masterAccountName: master.name,
  }, { accountIds });
}

module.exports = {
  getMasterAccount,
  masterMeta,
  masterViewerIds,
  notifyMasterPriceChange,
};
