'use strict';

/**
 * 静态语法检查（无第三方依赖）：node --check 遍历服务端 / 脚本 / 测试 / 前端源码。
 *  - 服务端、脚本、测试为 CommonJS，直接 node --check；
 *  - public/js/*.js 是浏览器 ES Module，复制到临时 .mjs 后再 node --check（避免被当成 CJS 解析报 import 错）。
 * 用法：npm run check
 */

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = nodePath.join(__dirname, '..');
const CJS_DIRS = ['server', 'scripts', 'test'];
const ESM_DIRS = ['public/js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'data', 'backup', 'release']);

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function nodeCheck(target) {
  const res = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (res.error) return { ok: false, error: res.error.message };
  if (res.status === 0) return { ok: true };
  const detail = (res.stderr || res.stdout || '').split('\n').filter(Boolean).slice(-6).join('\n');
  return { ok: false, error: detail || `exit ${res.status}` };
}

/** ESM 文件复制成 .mjs 后再检查语法 */
function checkEsm(file) {
  const tmp = nodePath.join(os.tmpdir(), `sgbhsd-check-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  try {
    fs.copyFileSync(file, tmp);
    return nodeCheck(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function main() {
  const cjsFiles = [];
  for (const dir of CJS_DIRS) walk(nodePath.join(ROOT, dir), cjsFiles);
  const esmFiles = [];
  for (const dir of ESM_DIRS) walk(nodePath.join(ROOT, dir), esmFiles);

  const failures = [];
  let checked = 0;
  for (const file of cjsFiles) {
    checked += 1;
    const result = nodeCheck(file);
    if (!result.ok) failures.push({ file, error: result.error });
  }
  for (const file of esmFiles) {
    checked += 1;
    const result = checkEsm(file);
    if (!result.ok) failures.push({ file, error: result.error });
  }

  for (const failure of failures) {
    console.error(`\n[check] 语法错误：${nodePath.relative(ROOT, failure.file)}\n${failure.error}`);
  }
  const cjsCount = cjsFiles.length;
  console.log(`[check] 已检查 ${checked} 个文件（CJS ${cjsCount} / ESM ${esmFiles.length}），失败 ${failures.length} 个`);
  if (failures.length) process.exitCode = 1;
}

main();
