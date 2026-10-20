'use strict';

/**
 * 前端加固构建：esbuild 打包（external: vue / element-plus）→ javascript-obfuscator 混淆
 * 产物写入 public/dist/{app.js,admin.js}；依赖缺失或失败时不阻塞服务（服务端会回退源码）。
 *
 * 用法：node scripts/build-ui.js [--force] [--quiet]
 */

const fs = require('node:fs');
const nodePath = require('node:path');

const ROOT = nodePath.join(__dirname, '..');
const SRC_DIR = nodePath.join(ROOT, 'public', 'js');
const OUT_DIR = nodePath.join(ROOT, 'public', 'dist');
const ENTRIES = ['app.js', 'admin.js'];
const EXTERNAL = ['vue', 'element-plus', 'element-plus/locale/zh-cn'];

function loadDeps() {
  try {
    return {
      esbuild: require('esbuild'),
      obfuscator: require('javascript-obfuscator'),
    };
  } catch {
    return null;
  }
}

function listSources() {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  if (fs.existsSync(SRC_DIR)) walk(SRC_DIR);
  return out;
}

function isStale() {
  if (!fs.existsSync(OUT_DIR)) return true;
  const sources = listSources();
  const newestSource = sources.reduce((max, f) => Math.max(max, fs.statSync(f).mtimeMs), 0);
  for (const name of ENTRIES) {
    if (!fs.existsSync(nodePath.join(SRC_DIR, name))) continue;
    const out = nodePath.join(OUT_DIR, name);
    if (!fs.existsSync(out)) return true;
    if (fs.statSync(out).mtimeMs < newestSource) return true;
  }
  return false;
}

async function buildWith(deps) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  for (const name of ENTRIES) {
    const src = nodePath.join(SRC_DIR, name);
    if (!fs.existsSync(src)) continue;
    // eslint-disable-next-line no-await-in-loop
    const bundled = await deps.esbuild.build({
      entryPoints: [src],
      bundle: true,
      format: 'esm',
      target: ['es2020'],
      minify: true,
      write: false,
      external: EXTERNAL,
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'silent',
    });
    const code = bundled.outputFiles[0].text;
    const obfuscated = deps.obfuscator.obfuscate(code, {
      compact: true,
      target: 'browser',
      sourceMap: false,
      selfDefending: false,
      debugProtection: false,
      stringArray: true,
      stringArrayThreshold: 0.75,
      stringArrayEncoding: ['base64'],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      splitStrings: true,
      splitStringsChunkLength: 12,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.2,
      deadCodeInjection: false,
      numbersToExpressions: true,
      simplify: true,
      identifierNamesGenerator: 'hexadecimal',
      identifiersPrefix: 'sg',
      transformObjectKeys: true,
      unicodeEscapeSequence: false,
    }).getObfuscatedCode();
    fs.writeFileSync(nodePath.join(OUT_DIR, name), obfuscated, 'utf8');
    files.push(name);
  }
  return files;
}

/** 确保产物存在且不比源码旧；依赖缺失/失败时静默降级（返回 built:false） */
async function ensureBuild({ force = false, quiet = false } = {}) {
  if (!force && !isStale()) return { built: false, files: [], reason: 'up-to-date' };
  const deps = loadDeps();
  if (!deps) {
    const reason = '缺少构建依赖（npm i -D esbuild javascript-obfuscator）';
    if (!quiet) console.warn(`[build] ${reason}，将直接使用源码版本`);
    return { built: false, files: [], reason };
  }
  const files = await buildWith(deps);
  if (!quiet) console.log(`[build] 已生成加固产物: ${files.join(', ')}`);
  return { built: true, files };
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  const quiet = process.argv.includes('--quiet');
  ensureBuild({ force, quiet })
    .then(result => {
      if (!result.built && result.reason !== 'up-to-date') process.exitCode = 1;
    })
    .catch(err => {
      console.error('[build] 构建失败:', err.message);
      process.exitCode = 1;
    });
}

module.exports = { ensureBuild, buildWith, isStale, OUT_DIR, SRC_DIR, ENTRIES };
