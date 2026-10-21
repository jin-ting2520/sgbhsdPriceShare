'use strict';

/** WebSocket 实时协作：一次性票据 + 会话/设备校验，广播按账号隔离 */

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const auth = require('./auth');

let wss = null;
const TICKET_TTL_MS = 60 * 1000;
const tickets = new Map();

function issueTicket(account, session) {
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, {
    accountId: Number(account.id),
    sessionId: Number(session.id),
    sessionToken: session.token,
    deviceId: session.deviceId || '',
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return ticket;
}

function consumeTicket(value) {
  const ticket = String(value || '').trim();
  if (!ticket) return null;
  const record = tickets.get(ticket);
  tickets.delete(ticket);
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}

const ticketTimer = setInterval(() => {
  const now = Date.now();
  for (const [ticket, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(ticket);
  }
}, 30 * 1000);
if (ticketTimer.unref) ticketTimer.unref();

function attach(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', async (ws, req) => {
    let account = null;
    try {
      const origin = String(req.headers.origin || '').trim();
      if (origin) {
        const parsed = new URL(origin);
        if (parsed.host !== req.headers.host) {
          ws.close(4401, 'origin-mismatch');
          return;
        }
      }
      const url = new URL(req.url, 'http://localhost');
      const ticket = consumeTicket(url.searchParams.get('ticket'));
      if (!ticket) {
        ws.close(4401, 'unauthorized');
        return;
      }
      account = await auth.loadSession(ticket.sessionToken);
      if (!account || Number(account.id) !== ticket.accountId || Number(account.sessionId) !== ticket.sessionId) {
        ws.close(4401, 'unauthorized');
        return;
      }
      if (auth.accountBlocked(account)) {
        ws.close(4403, 'forbidden');
        return;
      }
      if (account.deviceId && ticket.deviceId && account.deviceId !== ticket.deviceId) {
        ws.close(4401, 'device-mismatch');
        return;
      }
    } catch {
      try { ws.close(4401, 'unauthorized'); } catch { /* ignore */ }
      return;
    }

    ws.accountId = account.id;
    ws.sessionId = account.sessionId;
    ws.deviceRefId = account.deviceRefId;
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

/** 广播：accountId / accountIds 提供时仅发给指定账号的在线会话 */
function broadcast(type, payload, { except, accountId, accountIds } = {}) {
  if (!wss) return;
  const text = JSON.stringify({ type, ...payload, time: Date.now() });
  const allowed = Array.isArray(accountIds) ? new Set(accountIds.map(Number)) : null;
  for (const ws of wss.clients) {
    if (ws === except) continue;
    if (accountId != null && Number(ws.accountId) !== Number(accountId)) continue;
    if (allowed && !allowed.has(Number(ws.accountId))) continue;
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(text); } catch { /* ignore */ }
  }
}

function clientCount() {
  return wss ? wss.clients.size : 0;
}

/** 会话或设备被移除后断开对应实时连接 */
function closeSessions(sessionIds) {
  if (!wss || !Array.isArray(sessionIds) || !sessionIds.length) return;
  const ids = new Set(sessionIds.map(Number));
  for (const ws of wss.clients) {
    if (!ids.has(Number(ws.sessionId))) continue;
    try { ws.close(4401, 'session-removed'); } catch { /* ignore */ }
  }
}

function close() {
  if (!wss) return;
  for (const ws of wss.clients) {
    try { ws.close(); } catch { /* ignore */ }
  }
  try { wss.close(); } catch { /* ignore */ }
  wss = null;
}

module.exports = {
  attach, broadcast, clientCount, closeSessions, close, issueTicket, consumeTicket, TICKET_TTL_MS,
};
