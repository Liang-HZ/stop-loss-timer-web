// 止损计时 — 服务端共享工具（Cloudflare Pages Functions, KV）
// 文件名以 `_` 开头：Pages Functions 不把它注册成路由，只作为模块被其它 Functions import。
// 零 npm 依赖，只用 Workers 运行时自带的 Web Crypto / TextEncoder / btoa。
const enc = new TextEncoder();
export const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const json = (o, s = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...headers } });

// ---- 口令与摘要 ------------------------------------------------------------

// 30000 而非 100000：Workers 免费档 CPU 限额 10ms，30k 次 PBKDF2 约 3-4ms，留出余量
export async function hashPw(pw, saltB64) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: 30000 }, key, 256);
  return b64(bits);
}

export function newSalt() { return b64(crypto.getRandomValues(new Uint8Array(16))); }

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// 常量时间比较：长度不同直接返回 false（长度本身不是秘密），长度相同时不早退。
export function timingSafeEqual(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// 人眼友好的码：去掉 0/O/1/I 这类易混字符。12 位 × 32 字母 ≈ 60 bit 熵，够抗在线爆破（还叠了限流）。
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function randomCode(len = 12) {
  const buf = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}
export const normalizeCode = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

// ---- 会话 token ------------------------------------------------------------

// tokens:{user} 是反向索引，只为「改密码/找回后吊销该用户全部会话」存在。
// token 记录本身仍带 30 天 TTL；索引里可能留下已过期的 token 串，吊销时 delete 是幂等的，无所谓。
const TOKEN_TTL = 60 * 60 * 24 * 30;
const TOKEN_INDEX_MAX = 50;

export async function newToken(env, user) {
  const t = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await env.KV.put('token:' + t, JSON.stringify({ user, at: Date.now() }), { expirationTtl: TOKEN_TTL });
  const list = await readJson(env, 'tokens:' + user, []);
  list.push(t);
  await env.KV.put('tokens:' + user, JSON.stringify(list.slice(-TOKEN_INDEX_MAX)), { expirationTtl: TOKEN_TTL });
  return t;
}

export async function revokeAllTokens(env, user) {
  const list = await readJson(env, 'tokens:' + user, []);
  for (const t of list) await env.KV.delete('token:' + t);
  await env.KV.delete('tokens:' + user);
  return list.length;
}

export async function userOf(env, request) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const raw = await env.KV.get('token:' + m[1]);
  return raw ? JSON.parse(raw).user : null;
}

export function isAdmin(env, request) {
  if (!env.ADMIN_TOKEN) return false;
  const m = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  return !!m && timingSafeEqual(m[1], env.ADMIN_TOKEN);
}

// ---- KV 小工具 -------------------------------------------------------------

export async function readJson(env, key, fallback) {
  const raw = await env.KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ---- 防刷：进程内固定窗口限流（按 CF-Connecting-IP），压平突发与脚本滥用。
// 作用域是单个 Worker 实例（每机场/每实例各一份），全球级硬上限由套餐配额与边缘 WAF 规则兜底，见 README。
const buckets = new Map();
function prune(now) { for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }
export function rateLimit(request, kind, limit, windowMs, extraKey = '') {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now(), k = kind + ':' + ip + ':' + extraKey, b = buckets.get(k);
  if (!b || now > b.reset) {
    buckets.set(k, { n: 1, reset: now + windowMs });
    if (buckets.size > 20000) prune(now);
    return true;
  }
  b.n++;
  return b.n <= limit;
}
// 仅供测试用：清空进程内限流桶，避免用例之间互相把配额吃光。
export function _resetRateLimits() { buckets.clear(); }

export function tooBig(request, max) { return +(request.headers.get('Content-Length') || 0) > max; }
export const limited = () => json({ error: '请求太频繁，请稍后再试' }, 429); // 全局构造 Response 会被运行时拒绝，故为函数

// 邮箱绑定（找回用）：正向 email:{user} 给用户看，反向 emailhash:{sha256} 防同一邮箱重复绑定。
export const normalizeEmail = s => String(s || '').trim().toLowerCase();
export const isEmail = s => /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(s) && s.length <= 254;
export const emailKey = async email => 'emailhash:' + (await sha256hex(normalizeEmail(email)));
