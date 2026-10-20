'use strict';

/** 主账号价格共享：按区服配置主账号、查看偏好与共享广播 */

const { get, query } = require('./db');
const { broadcast } = require('./ws');
const { cleanName } = require('./util');

const currentServerOf = account => cleanName(account && (account.currentServer ?? account.current_server), 50);

async function getServerMaster(serverName) {
  const name = cleanName(serverName, 50);
  if (!name) return null;
  const row = await get(
    `SELECT a.id, a.name, a.status, s.name AS serverName
       FROM server_masters sm
       JOIN servers s  ON s.id = sm.server_id
       JOIN accounts a ON a.id = sm.account_id
      WHERE s.name = ?`,
    [name]
  );
  return row || null;
}

async function getServerMasterById(serverId) {
  const id = Number(serverId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await get(
    `SELECT a.id, a.name, a.status, s.name AS serverName
       FROM server_masters sm
       JOIN servers s  ON s.id = sm.server_id
       JOIN accounts a ON a.id = sm.account_id
      WHERE sm.server_id = ?`,
    [id]
  );
  return row || null;
}

async function masterMeta(account, serverName) {
  const currentServer = currentServerOf(account);
  const targetServer = cleanName(serverName, 50) || currentServer;
  const master = currentServer && targetServer === currentServer
    ? await getServerMaster(currentServer)
    : null;
  const isMaster = !!(master && account && Number(master.id) === Number(account.id));
  const allowed = !!(account && Number(account.masterPricesAllowed ?? account.allow_master_prices ?? 1));
  const preference = !!(account && Number(account.viewMasterPrices ?? account.view_master_prices));
  return {
    server: currentServer,
    master,
    masterAccountId: master ? Number(master.id) : null,
    masterAccountName: master ? master.name : '',
    isMaster,
    masterPricesAllowed: !isMaster && allowed,
    viewMasterPrices: !isMaster && !!master && allowed && preference,
  };
}

async function masterViewerIds(serverName) {
  const name = cleanName(serverName, 50);
  if (!name) return [];
  const master = await getServerMaster(name);
  if (!master) return [];
  const rows = await query(
    `SELECT id FROM accounts
      WHERE current_server = ? AND view_master_prices = 1 AND allow_master_prices = 1 AND id <> ?`,
    [name, master.id]
  );
  return rows.map(r => Number(r.id));
}

async function notifyMasterPriceChange(accountId, payload) {
  const server = cleanName(payload && payload.server, 50);
  if (!server) return;
  const master = await getServerMaster(server);
  if (!master || Number(master.id) !== Number(accountId)) return;
  const accountIds = await masterViewerIds(server);
  if (!accountIds.length) return;
  broadcast('price.updated', {
    ...payload,
    shared: true,
    masterAccountName: master.name,
  }, { accountIds });
}

module.exports = {
  getServerMaster,
  getServerMasterById,
  masterMeta,
  masterViewerIds,
  notifyMasterPriceChange,
};
