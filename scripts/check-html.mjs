// 静态 HTML 自检：标签配对 + 基础 head 元素。
// 零依赖（仓库硬约束），用 node 跑：node scripts/check-html.mjs
// 检查对象默认是 public/*.html，也可以在命令行传文件路径。
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
// script/style 的内容是纯文本，里面的 `<` 不是标签。
const RAW_TEXT = new Set(['script', 'style']);

const files = process.argv.slice(2);
const root = resolve(process.cwd(), 'public');
const targets = (files.length ? files : readdirSync(root).filter(f => f.endsWith('.html')).map(f => join('public', f)))
  .map(p => resolve(process.cwd(), p));

const errors = [];
const summaries = [];

for (const file of targets) {
  const name = basename(file);
  const src = readFileSync(file, 'utf8');
  const stack = [];
  let i = 0;

  const lineAt = idx => src.slice(0, idx).split('\n').length;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { // 注释整块跳过
      const end = src.indexOf('-->', lt);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    // 找标签结束的 '>'：引号里的 '>' 不算（favicon 那行的 data:image/svg+xml 就带 '>'）。
    let gt = -1, quote = '';
    for (let k = lt + 1; k < src.length; k++) {
      const c = src[k];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') { gt = k; break; }
    }
    if (gt < 0) { errors.push(`${name}:${lineAt(lt)} 有一个 '<' 没有对应的 '>'`); break; }
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (!raw || /^[\s!?]/.test(raw) && !raw.startsWith('!doctype') && !raw.startsWith('!DOCTYPE')) continue;

    const closing = raw.startsWith('/');
    const tag = (closing ? raw.slice(1) : raw).trim().split(/[\s/>]/)[0].toLowerCase();
    if (!tag) continue;

    if (closing) {
      const top = stack.pop();
      if (!top) errors.push(`${name}:${lineAt(lt)} </${tag}> 多余，没有可配对的开标签`);
      else if (top.tag !== tag) errors.push(`${name}:${lineAt(lt)} </${tag}> 与第 ${top.line} 行的 <${top.tag}> 不配对`);
      continue;
    }

    if (VOID.has(tag) || raw.trimEnd().endsWith('/')) continue;
    stack.push({ tag, line: lineAt(lt) });

    if (RAW_TEXT.has(tag)) { // 跳到对应的闭标签，内容当纯文本
      const close = src.toLowerCase().indexOf(`</${tag}`, i);
      if (close < 0) { errors.push(`${name}:${lineAt(lt)} <${tag}> 没有闭合`); break; }
      i = close;
    }
  }
  for (const left of stack) errors.push(`${name}:${left.line} <${left.tag}> 没有闭合`);

  if (!/<html[^>]*\blang\s*=\s*"[^"]+"/.test(src)) errors.push(`${name} 缺少 <html lang="...">`);
  if (!/<title>/.test(src)) errors.push(`${name} 缺少 <title>`);
  if (!/<meta charset="utf-8">/i.test(src)) errors.push(`${name} 缺少 charset`);
  if (!/name="viewport"/.test(src)) errors.push(`${name} 缺少 viewport`);
  summaries.push({ name });
}

for (const s of summaries) console.log(`${s.name}: 标签配对 OK`);
if (errors.length) {
  console.error('\n检查未通过：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n全部通过：标签配对、html lang、title、charset、viewport。');
