#!/usr/bin/env node
// scripts/build-core.mjs
// 把 packages/core 的 ESM 源码原样复制到 public/core/（Web 用 <script type="module"> 直接 import）。
// 零依赖，不引入打包器；模块图就是普通的相对路径 ESM，浏览器原生可跑。

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'core');
const OUT_ESM = join(ROOT, 'public', 'core');

const BANNER = '// 构建产物，勿手改。源码在 packages/core/，用 `npm run build:core` 重新生成。\n';

function listJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'test' || name === 'node_modules') continue;
      out.push(...listJs(full));
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

// outEsm 可覆盖：测试把产物建到临时目录再与仓库里已提交的那份逐字节比对，
// 绝不在测试里重写 public/core——它是别的测试文件正在 import 的共享产物，
// 而 node --test 是多进程并发跑的。
function build({ outEsm = OUT_ESM } = {}) {
  const files = listJs(SRC);
  if (!files.length) throw new Error('build-core: packages/core 下没有找到 .js 源文件');

  rmSync(outEsm, { recursive: true, force: true });
  mkdirSync(outEsm, { recursive: true });

  const written = [];
  for (const file of files) {
    const rel = relative(SRC, file);
    const source = readFileSync(file, 'utf8');

    const esmPath = join(outEsm, rel);
    mkdirSync(dirname(esmPath), { recursive: true });
    writeFileSync(esmPath, BANNER + source);
    written.push(rel);
  }

  writeFileSync(join(outEsm, 'README.txt'), '构建产物，勿手改。源码在 packages/core/，用 `npm run build:core` 重新生成。\n');
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const w = build();
  console.log(`build-core: public/core/ ${w.length} 个 ESM 文件`);
  console.log('  ' + w.join('\n  '));
}

export { build, listJs };
