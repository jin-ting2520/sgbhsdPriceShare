'use strict';

/** WebSocket 实时协作：价格变更 / 字典变更 / 同步完成 / 配置变更 广播 */

const { WebSocketServer } = require('ws');

let wss = null;

function attach(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', ws => {
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
      ws.send(JSON.stringify({ type: 'hello', clients: wss.clients.size, time: Date.now() }));
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

function broadcast(type, payload, { except } = {}) {
  if (!wss) return;
  const text = JSON.stringify({ type, ...payload, time: Date.now() });
  for (const ws of wss.clients) {
    if (ws === except) continue;
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
