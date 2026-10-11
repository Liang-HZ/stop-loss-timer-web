import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../index.js';
import * as model from '../model.js';
import * as capacity from '../capacity.js';
import * as flow from '../flow.js';
import * as migrate from '../migrate.js';
import * as review from '../review.js';
import * as sync from '../sync.js';
import * as copy from '../copy.js';

const MODULES = { model, capacity, flow, migrate, review, sync, copy };

test('index.js 汇总导出每个模块的每一个名字', () => {
  // `export *` 遇到重名会静默丢弃该名字，这条断言就是防它复发。
  const missing = [];
  for (const [name, mod] of Object.entries(MODULES)) {
    for (const key of Object.keys(mod)) {
      if (!(key in core)) missing.push(`${name}.${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('模块之间没有重名导出', () => {
  const seen = new Map();
  const clashes = [];
  for (const [name, mod] of Object.entries(MODULES)) {
    for (const key of Object.keys(mod)) {
      if (seen.has(key)) clashes.push(`${key}: ${seen.get(key)} / ${name}`);
      else seen.set(key, name);
    }
  }
  assert.deepEqual(clashes, []);
});

// 宿主 API 的使用形态：成员访问（window.x / wx.foo）或调用（fetch(...)）。
// 两条刻意的收窄，两条都是被真实假阳性逼出来的：
//  1) 不匹配裸词——copy.js 的英文文案里有 'Floating window'，裸词匹配会把它当成 API 调用；
//  2) 名单里只放**不可能当局部变量名**的全局——`history` / `location` / `screen` 这类普通词不收，
//     migrate.js 里的 `history.push(...)` 就是 v1 的历史数组，不是 window.history。
// 扫描前还会先剥掉注释与字符串字面量：文案、注释里出现什么词都不该影响这条守卫。
const HOST_API = /(?:\b(?:window|document|localStorage|sessionStorage|navigator|wx|uni|globalThis\s*\.\s*document)\s*\.)|(?:\b(?:fetch|require|setTimeout|setInterval|importScripts)\s*\()|(?:\bnew\s+(?:XMLHttpRequest|WebSocket|Worker|Image|FileReader)\b)/;

// 剥掉行注释、块注释和字符串／模板字面量，只留可执行代码。
export function stripLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) { i += src[i] === '\\' ? 2 : 1; }
      i++;
      out += quote + quote;   // 留一对空引号，保持语句边界
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

test('core 不依赖 DOM / 微信 / 原生 API', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const offenders = [];
  for (const f of readdirSync(srcDir).filter(n => n.endsWith('.js'))) {
    const code = stripLiterals(readFileSync(join(srcDir, f), 'utf8'));
    if (HOST_API.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test('宿主 API 守卫仍然抓得到真的调用，也不再被文案与注释误伤', () => {
  // 真的会被抓到（反例）：这条断言在于证明守卫没被放宽到形同虚设
  for (const bad of [
    'const el = document.getElementById("x");',
    'window.addEventListener("click", f);',
    'localStorage.setItem("k", "v");',
    'wx.getStorageSync("data");',
    'await fetch("/api/data");',
    'const r = require("./x.js");',
    'new XMLHttpRequest();',
    'new WebSocket(url);',
    'setTimeout(f, 10);'
  ]) {
    assert.equal(HOST_API.test(stripLiterals(bad)), true, `应当被守卫拦下：${bad}`);
  }
  // 不该被抓到：文案、注释、以及只是同名的属性/变量
  for (const ok of [
    "export const COPY = { 'now.pip': 'Floating window' };",
    "const s = 'The floating window would not open — check browser permissions.';",
    '// window.localStorage 在这里只是注释里的说明',
    '/* document 与 navigator 只出现在这段块注释里 */',
    'const opts = { window: 5, document: null };',
    'history.push(row); history.sort(byDoneAt);',   // v1 的历史数组，不是 window.history
    'const tpl = `open the window then fetch(it)`;'
  ]) {
    assert.equal(HOST_API.test(stripLiterals(ok)), false, `不该被守卫误伤：${ok}`);
  }
});

test('core 零 npm 依赖：只 import 本目录内的相对模块', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bad = [];
  for (const f of readdirSync(srcDir).filter(n => n.endsWith('.js'))) {
    const text = readFileSync(join(srcDir, f), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('./')) bad.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});
