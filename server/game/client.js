'use strict';

/**
 * 游戏 WebSocket 客户端：CgLogin 登录 + 富甲天下州府商品查询
 * 时序：open → 发 CgLogin(1) → 收 GcLogin(12).success → 发 CgMonopolyCapitalProductInfo(2103) → 收 2104
 */

const { encodeFrame, FrameParser } = require('./frame');
const { encode, decode } = require('./thrift');
const { APP_KEY, APP_VERSION, CLIENT_ID, INT_CLIENT_ID } = require('./login');

const MSG = {
  CG_LOGIN: 1,
  CG_ENTER_MAP: 2,
  GC_ENTER_MAP: 3,
  CG_SYNC_TIME: 4,
  GC_SYNC_TIME: 5,
  GC_GAME_ERROR: 11,
  GC_LOGIN: 12,
  GC_MIXED_KEYS: 15,
  GC_PLAYER_INFO: 100,
  GC_CITY_INFO: 200,
  GC_MONOPOLY_INFO: 2102,
  CG_MONOPOLY_PRODUCT: 2103,
  GC_MONOPOLY_PRODUCT: 2104,
  CG_REGION_CAPITAL_APPLY_LIST: 6905,
};

const DEBUG = process.env.GAME_DEBUG === '1';

class GameClient {
  constructor({ serverHost, serverPort, serverId }, { timeoutMs = 15000 } = {}) {
    this.serverHost = serverHost;
    this.serverPort = serverPort;
    this.serverId = serverId;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.ws = null;
    this.parser = new FrameParser();
    this.waiters = [];
    this.errors = [];
    this.heartbeatTimer = null;
    this.closed = false;
    this.strictErrors = true;
  }

  get url() {
    return `wss://${this.serverHost}:${this.serverPort}/websocket${this.serverId}`;
  }

  /** 建立连接（等待 open） */
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        reject(new Error('连接游戏服务器超时'));
        try { ws.close(); } catch { /* ignore */ }
      }, this.timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('连接游戏服务器失败'));
      };
      ws.onclose = () => {
        this.closed = true;
        this.stopHeartbeat();
        this.rejectAll(new Error('游戏连接已断开'));
      };
      ws.onmessage = ev => {
        const chunk = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);
        for (const frame of this.parser.push(chunk)) this.handleFrame(frame);
      };
    });
  }

  handleFrame({ msgType, body }) {
    let msg;
    try {
      msg = decode(msgType, body);
    } catch (err) {
      if (DEBUG) console.error('[game] 解码失败', msgType, err.message);
      return;
    }
    if (DEBUG) console.log('[game] <<', msgType, JSON.stringify(msg));

    if (msgType === MSG.GC_GAME_ERROR) {
      const text = msg.params && msg.params.length ? msg.params.join(' ') : '游戏服务器返回错误';
      this.errors.push({ messageId: msg.messageId, params: msg.params });
      // 登录阶段视为致命错误；批量查询阶段仅记录，避免个别城池失败拖垮整批
      if (this.strictErrors) this.rejectAll(new Error(text));
      return;
    }
    if (msgType === MSG.GC_LOGIN && msg.success === false) {
      this.rejectAll(new Error('游戏登录被拒绝（GcLogin.success=false）'));
      return;
    }

    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.msgType !== msgType) continue;
      if (w.pred && !w.pred(msg)) continue;
      this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  }

  rejectAll(err) {
    const list = this.waiters;
    this.waiters = [];
    for (const w of list) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  waitFor(msgType, pred, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== entry);
        reject(new Error(`等待消息 ${msgType} 超时`));
      }, timeoutMs);
      const entry = { msgType, pred, resolve, reject, timer };
      this.waiters.push(entry);
    });
  }

  send(msgType, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('游戏连接未就绪');
    this.seq = this.seq >= 32766 ? 1 : this.seq + 1;
    const body = encode(msgType, payload);
    if (DEBUG) console.log('[game] >>', msgType, JSON.stringify(payload, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    this.ws.send(encodeFrame(msgType, this.seq, body));
  }

  /** 发送 CgLogin 并等待 GcLogin */
  async login(info, deviceId) {
    this.seq = 0;
    this.strictErrors = true;
    const uid = info.userId;
    const payload = {
      uid,
      roleId: info.roleId,
      timestamp: info.timestamp,
      sign: info.sign,
      device: 1,
      language: 'Chinese',
      deviceId: deviceId || info.deviceId || 'BFE902A57C5730CA66E9068969ED2022',
      rollback: false,
      gaid: String(uid),
      appKey: APP_KEY,
      clientVersion: APP_VERSION,
      country: info.country || 'CN',
      platform: 1,
      channelF: '',
      loginToken: info.loginToken,
      serverType: 1,
      username: 'user_' + uid,
      head: 'test',
      clientIsHF: false,
      activityCountry: 'CN',
      pushPlatform: 8,
      wxOpenId: '',
      clientId: CLIENT_ID,
      intClientId: INT_CLIENT_ID,
      wxSessionKey: '',
      t: 'v20260709',
      earlyType: info.earlyType || 'A',
    };
    const wait = this.waitFor(MSG.GC_LOGIN, null, this.timeoutMs);
    this.send(MSG.CG_LOGIN, payload);
    const res = await wait;
    this.startHeartbeat();

    // 登录后需进入地图，服务器才会推送富甲天下数据
    const enter = this.waitFor(MSG.GC_ENTER_MAP, null, 5000).catch(() => null);
    this.send(MSG.CG_ENTER_MAP, {});
    this.send(MSG.CG_REGION_CAPITAL_APPLY_LIST, {});
    this.enterMap = await enter;
    this.strictErrors = false;
    return res;
  }

  /**
   * 查询州府商品（type=1 全量快照，含买卖两侧）
   * 注意：服务器还会推送 type=3 的增量更新（无关请求），必须按 type 过滤，避免误配
   */
  async queryCapitalProducts(capitalNodeId, type = 1, timeoutMs = 8000) {
    const id = Number(capitalNodeId);
    const wait = this.waitFor(
      MSG.GC_MONOPOLY_PRODUCT,
      m => Number(m.capitalNodeId) === id && Number(m.type) === type,
      timeoutMs
    );
    this.send(MSG.CG_MONOPOLY_PRODUCT, { capitalNodeId, type });
    return wait;
  }

  /** 取消州府订阅（type=2），避免服务器持续推送增量 */
  unsubscribeCapitalProducts(capitalNodeId) {
    try {
      this.send(MSG.CG_MONOPOLY_PRODUCT, { capitalNodeId, type: 2 });
    } catch { /* 连接已断时忽略 */ }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      try {
        this.send(MSG.CG_SYNC_TIME, {
          clientTime: Math.floor(Date.now() / 1000),
          clientUTCTime: Date.now(),
          ver: 'v20260709',
        });
      } catch { /* 连接已断时忽略 */ }
    }, 15000);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  close() {
    this.stopHeartbeat();
    this.rejectAll(new Error('连接已关闭'));
    try {
      if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    } catch { /* ignore */ }
  }
}

module.exports = { GameClient, MSG };
