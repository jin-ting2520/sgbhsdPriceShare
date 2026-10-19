'use strict';

/** 三国冰河时代富甲天下跑商价格分享 —— Express 入口 */

const http = require('node:http');
const express = require('express');
const nodePath = require('node:path');

const db = require('./db');
const cache = require('./cache');
const ws = require('./ws');
const scheduler = require('./scheduler');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

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

app.use(express.static(nodePath.join(__dirname, '..', 'public')));
app.use('/public', express.static(nodePath.join(__dirname, '..', 'public')));

/* ------------------------------ API ------------------------------ */
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
  res.status(status).json({ code: status, message: err.message || '服务器内部错误', data: null });
});

/** 创建带 WebSocket 的 HTTP 服务（测试与生产共用） */
function createServer() {
  const server = http.createServer(app);
  ws.attach(server);
  return server;
}

// 供测试复用（不自动监听）
if (require.main === module) {
  cache.connect().catch(() => {});
  const server = createServer();
  server.listen(PORT, HOST, async () => {
    console.log(`三国冰河时代富甲天下跑商价格分享已启动: http://localhost:${PORT}`);
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
