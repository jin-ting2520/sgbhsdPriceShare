'use strict';

/** 三国冰河时代富甲天下跑商价格分享 —— Express 入口 */

const express = require('express');
const nodePath = require('node:path');

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
// OCR：Tesseract.js 浏览器端识别（引擎/核心/语言模型全部本地托管，无外网 CDN）
app.use('/vendor/tesseract', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=604800');
  next();
}, express.static(nodePath.join(__dirname, '..', 'node_modules', 'tesseract.js', 'dist')));
app.use('/vendor/tesseract-core', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=604800');
  next();
}, express.static(nodePath.join(__dirname, '..', 'node_modules', 'tesseract.js-core')));
// 语言模型（chi_sim / eng 的 int8 量化版，体积小适合浏览器）
const TESSDATA_ROOT = nodePath.join(__dirname, '..', 'node_modules', '@tesseract.js-data');
app.get('/vendor/tessdata/:lang.traineddata.gz', (req, res, next) => {
  const lang = req.params.lang;
  if (!/^[a-z_]+$/.test(lang)) return next();
  const file = nodePath.join(TESSDATA_ROOT, lang, '4.0.0_best_int', `${lang}.traineddata.gz`);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(file, err => { if (err) next(); });
});
app.use(express.static(nodePath.join(__dirname, '..', 'public')));
app.use('/public', express.static(nodePath.join(__dirname, '..', 'public')));

/* ------------------------------ API ------------------------------ */
app.use('/api/dict', require('./routes/dict'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/prices', require('./routes/prices'));

app.get('/api/health', (req, res) => res.json({ code: 0, message: 'ok', data: { uptime: process.uptime() } }));

app.use('/api', (req, res) => res.status(404).json({ code: 404, message: '接口不存在', data: null }));

/* ------------------------------ 错误处理 ------------------------------ */
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ code: status, message: err.message || '服务器内部错误', data: null });
});

// 供测试复用（不自动监听）
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`三国冰河时代富甲天下跑商价格分享已启动: http://localhost:${PORT}`);
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

module.exports = app;
