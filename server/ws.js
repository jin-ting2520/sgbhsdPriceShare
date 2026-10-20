'use strict';

/** WebSocket 实时协作：需登录（token + device 校验），广播按账号隔离 */

const { WebSocketServer } = require('ws');
const auth = require('./auth');

let wss = null;

function attach(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', async (ws, req) => {
    let account = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token') || '';
      const device = url.searchParams.get('device') || '';
      account = await auth.loadSession(token);
      if (!account) {
        try { ws.close(4401, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      if (auth.accountBlocked(account)) {
        try { ws.close(4403, 'forbidden'); } catch { /* ignore */ }
        return;
      }
      if (account.deviceId && device && account.deviceId !== device) {
        try { ws.close(4401, 'device-mismatch'); } catch { /* ignore */ }
        return;
      }
    } catch {
      try { ws.close(4401, 'unauthorized'); } catch { /* ignore */ }
      return;
    }

    ws.accountId = account.id;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', time: Date.now() })); } catch { /* ignore */ }
      }
    });
    try {
      ws.send(JSON.stringify({ type: 'hello', account: account.name, time: Date.now() }));
    } catch { /* ignore */ }
  });

  const timer = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!ws.isAlive) { try { ws.terminate(); } catch { /* ignore */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  if (timer.unref) timer.unref();
  wss.on('close', () => clearInterval(timer));

  return wss;
}

/** 广播：accountId 提供时仅发给该账号的在线设备 */
function broadcast(type, payload, { except, accountId } = {}) {
  if (!wss) return;
  const text = JSON.stringify({ type, ...payload, time: Date.now() });
  for (const ws of wss.clients) {
    if (ws === except) continue;
    if (accountId != null && Number(ws.accountId) !== Number(accountId)) continue;
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(text); } catch { /* ignore */ }
  }
}

function clientCount() {
  return wss ? wss.clients.size : 0;
}

function close() {
  if (!wss) return;
  for (const ws of wss.clients) {
    try { ws.close(); } catch { /* ignore */ }
  }
  try { wss.close(); } catch { /* ignore */ }
  wss = null;
}

module.exports = { attach, broadcast, clientCount, close };
