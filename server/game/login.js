'use strict';

/**
 * 支付宝小游戏登录链路（Node 端直连，无需浏览器）
 *   JWT(x-game-token-pcweb) → authCode → SDK LoginBySnsIdNoVerify → v1/login → httpLoginInfo
 * httpLoginInfo 供 CgLogin 使用（userId / roleId / timestamp / sign / loginToken）
 */

const crypto = require('node:crypto');

const AUTH_URL = 'https://webgwmobiler.alipay.com/gamecenterhome/com.alipay.gamecenterhome.common.facade.service.GameCenterPcGameFacade/queryPcGameAuthInfo/uprodhatchstation66500008';
const SDK_LOGIN_URL = 'https://138-sanguo2-sdk-online01.bjxuejing.cn/open/v6/user/LoginBySnsIdNoVerify';
const HTTP_LOGIN_URL = 'https://138-sanguo2-login-online02.bjxuejing.cn/api/sanguo2/v1/login';

const APP_ID = '2021004173661702';
const GAME_ID = '20562';
const CLIENT_ID = 'H5_5.0_tyGuest,tyAccount.alipay.0-hall20562.aliminigame.sanguo2';
const INT_CLIENT_ID = 38465;
const APP_KEY = 'com.ninestudio.starlight.sg';
const APP_VERSION = '1.0.0';
const BUNDLE_ID = 'com.ninestudio.starlight.sg';
const RES_VER = '04fc3-de6d8-da169';

const TIMEOUT_MS = 15000;

function headers(token) {
  return {
    'content-type': 'application/json',
    origin: 'https://www.wanyiwan.top',
    referer: 'https://www.wanyiwan.top/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'x-webgw-appid': '180020010001270314',
    'x-webgw-version': '2.0',
    'x-webgw-ldc-uid': '91',
    'x-game-token-pcweb': token,
  };
}

async function readJson(res, what) {
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${what}返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(`${what}失败（HTTP ${res.status}）`);
  return json;
}

/** 用 x-game-token-pcweb 换取支付宝 authCode */
async function mintAuthCode(token) {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ appId: APP_ID }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await readJson(res, '支付宝登录');
  const authCode = json && json.data && json.data.authCode;
  if (!json.success || !authCode) {
    throw new Error(`登录态已失效（${json.errorMsg || json.errorCode || '无 authCode'}），请重新复制 x-game-token-pcweb`);
  }
  // data.userId 为支付宝账号 ID，CgLogin.deviceId 需要用它（游戏内 h.userId）
  return { authCode, alipayUserId: json.data.userId };
}

/** SDK 登录，返回 { sdkUid, authorCode } */
async function sdkLogin(authCode, deviceId) {
  const form = new URLSearchParams({
    ali_appId: APP_ID,
    ali_authcode: authCode,
    appId: GAME_ID,
    gameId: GAME_ID,
    clientId: CLIENT_ID,
    idfa: '',
    imei: 'null',
    original_deviceid: deviceId,
    osName: 'Android',
    scene_id: '',
    scene_param: 'e30AAA',
    sdk_channel_platform: 'Browser',
    sdk_login_track_id: crypto.randomBytes(16).toString('hex').toUpperCase(),
    sdk_session_id: crypto.randomBytes(16).toString('hex').toUpperCase(),
    snsId: 'ali.cn.minigame:' + authCode,
    uuid: deviceId,
  });
  const res = await fetch(SDK_LOGIN_URL, {
    method: 'POST',
    headers: { ...headers(''), 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await readJson(res, 'SDK 登录');
  const result = json.result || json;
  if (!result || result.code !== 0 || !result.authorCode) {
    throw new Error(`SDK 登录失败（code=${result && result.code}）`);
  }
  return { sdkUid: result.userId, authorCode: result.authorCode };
}

/** v1/login，返回 httpLoginInfo（含 serverHost/serverPort/serverId/sign/loginToken/roleId/userId） */
async function httpLogin(sdkUid, authorCode) {
  const q = new URLSearchParams({
    id: String(sdkUid),
    token: authorCode,
    platform: '21',
    deviceid: '',
    lang: 'Chinese',
    country: 'CN',
    serverId: '-1',
    channel: '',
    gaid: '',
    appversion: APP_VERSION,
    bundleid: BUNDLE_ID,
    sysLang: 'zh-CN',
    clientVer: '0.1.8.1',
    resVer: RES_VER,
    intClientId: String(INT_CLIENT_ID),
    wxOpenId: '',
    shareRoleId: 'undefined',
  });
  const res = await fetch(HTTP_LOGIN_URL + '?' + q.toString(), {
    headers: headers(''),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await readJson(res, '区服登录');
  if (json.ret !== 0 || !json.serverHost || !json.serverId) {
    throw new Error(`区服登录失败（ret=${json.ret}）`);
  }
  return json;
}

function newDeviceId() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

/**
 * 完整登录：JWT → authCode → SDK → v1/login
 * @returns {{login: object, sdkUid: number, alipayUserId: string, deviceId: string}}
 */
async function login(token) {
  const deviceId = process.env.GAME_DEVICE_ID || newDeviceId();
  const { authCode, alipayUserId } = await mintAuthCode(token);
  const { sdkUid, authorCode } = await sdkLogin(authCode, deviceId);
  const info = await httpLogin(sdkUid, authorCode);
  return { login: info, sdkUid, alipayUserId, deviceId };
}

module.exports = {
  APP_KEY, APP_VERSION, CLIENT_ID, INT_CLIENT_ID,
  login, mintAuthCode, sdkLogin, httpLogin,
};
