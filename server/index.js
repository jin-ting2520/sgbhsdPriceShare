'use strict';

/** 三国冰河时代富甲天下跑商价格分享 —— Express 入口 */

const http = require('node:http');
const fs = require('node:fs');
const express = require('express');
const nodePath = require('node:path');

const db = require('./db');
const cache = require('./cache');
const ws = require('./ws');
const scheduler = require('./scheduler');
const sign = require('./sign');
const security = require('./security');
const rateLimit = require('./ratelimit');
const { renderMarkdown } = require('./markdown');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = nodePath.join(__dirname, '..', 'public');
const DIST_DIR = nodePath.join(PUBLIC_DIR, 'dist');
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'loopback,linklocal,uniquelocal');
const trustProxy = TRUST_PROXY === 'false'
  ? false
  : (/^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

app.disable('x-powered-by');
app.set('trust proxy', trustProxy);
app.set('query parser', 'simple');
app.set('json escape', true);
app.use(security.headers);
app.use(security.jsonOnly);

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

/* ------------------------------ 静态资源 ------------------------------ */
// 本地 node_modules 提供 Vue / Element Plus，避免外网 CDN 依赖
app.use('/vendor/vue', express.static(nodePath.join(__dirname, '..', 'node_modules', 'vue', 'dist')));
app.use('/vendor/element-plus', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=604800');
  next();
}, express.static(nodePath.join(__dirname, '..', 'node_modules', 'element-plus', 'dist')));
app.use('/vendor/xlsx', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=604800');
  next();
}, express.static(nodePath.join(__dirname, '..', 'node_modules', 'xlsx', 'dist')));

/* ------------------------------ 加固打包产物 ------------------------------ */
// 优先服务构建后的混淆/压缩产物；未构建时回退到源码（功能不受影响）
app.get('/bundle/:name', (req, res) => {
  const name = String(req.params.name || '').replace(/[^A-Za-z0-9_.-]/g, '');
  const file = nodePath.join(DIST_DIR, name);
  if (name && !name.startsWith('.') && file.startsWith(DIST_DIR) && fs.existsSync(file)) {
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(file);
  }
  const fallback = { 'app.js': '/js/app.js', 'admin.js': '/js/admin.js' }[name];
  if (fallback) {
    res.type('application/javascript');
    return res.send(`import ${JSON.stringify(fallback)};`);
  }
  return res.status(404).type('application/javascript').send('throw new Error("bundle not found");');
});

app.use(express.static(PUBLIC_DIR));
app.use('/public', express.static(PUBLIC_DIR));

app.get(['/admin', '/admin/'], (req, res) => res.sendFile(nodePath.join(PUBLIC_DIR, 'admin.html')));

/* ------------------------------ API ------------------------------ */
app.use('/api', rateLimit.middleware(600, 60 * 1000));
app.use('/api/admin', rateLimit.middleware(240, 60 * 1000));
app.use('/api/auth', rateLimit.middleware(120, 60 * 1000));

app.get('/api/public/config', async (req, res) => {
  try {
    await db.ready();
    const settings = await db.getAppSettings();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      code: 0,
      message: 'ok',
      data: {
        registrationEnabled: settings.registrationEnabled,
        announcement: settings.announcement,
        keyRequired: settings.keyRequired,
        keyRequiredAt: settings.keyRequiredAt,
        keyHelpHtml: renderMarkdown(settings.keyHelpMd),
        tokenHelpHtml: renderMarkdown(settings.tokenHelpMd),
      },
    });
  } catch (err) {
    res.status(503).json({ code: 503, message: `配置读取失败：${err.message}`, data: null });
  }
});

app.use(require('./auth').attach);
app.use(sign.requireSignature);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dict', require('./routes/dict'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/prices', require('./routes/prices'));
app.use('/api/game', require('./routes/game'));
app.use('/api/sync-settings', require('./routes/sync-settings'));
app.use('/api/reports', require('./routes/reports'));

app.get('/api/health', async (req, res) => {
  try {
    await db.ready();
    res.json({
      code: 0,
      message: 'ok',
      data: {
        uptime: process.uptime(),
        driver: db.DRIVER,
        cache: cache.status(),
        wsClients: ws.clientCount(),
        sync: scheduler.status(),
      },
    });
  } catch (err) {
    res.status(503).json({ code: 503, message: `数据库不可用：${err.message}`, data: null });
  }
});

app.use('/api', (req, res) => res.status(404).json({ code: 404, message: '接口不存在', data: null }));

/* ------------------------------ 错误处理 ------------------------------ */
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  const message = status >= 500 && process.env.NODE_ENV === 'production'
    ? '服务器内部错误'
    : (err.message || '服务器内部错误');
  res.status(status).json({ code: status, message, data: null });
});

/** 创建带 WebSocket 的 HTTP 服务（不自动监听端口） */
function createServer() {
  const server = http.createServer(app);
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  ws.attach(server);
  return server;
}

// 供测试复用（不自动监听）
if (require.main === module) {
  cache.connect().catch(() => {});
  try {
    const build = require('../scripts/build-ui');
    build.ensureBuild().then(result => {
      if (result && result.built) console.log(`[build] 前端加固产物已生成: ${result.files.join(', ')}`);
    }).catch(err => console.warn('[build] 前端加固构建跳过:', err.message));
  } catch { /* 构建脚本缺失时忽略 */ }
  const server = createServer();
  server.listen(PORT, HOST, async () => {
    console.log(`三国冰河时代富甲天下跑商价格分享已启动: http://localhost:${PORT}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[admin] 未设置 ADMIN_PASSWORD，管理后台已禁用（用户端不受影响）');
    }
    try {
      await scheduler.start();
    } catch (err) {
      console.error('[scheduler] 启动失败:', err.message);
    }
  });

  const shutdown = () => {
    console.log('[server] 正在退出…');
    scheduler.stop();
    ws.close();
    cache.close().catch(() => {});
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
module.exports.createServer = createServer;
module.exports.ready = () => db.ready();
