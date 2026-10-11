// 止损计时 — 经同意的最小事件（Cloudflare Pages Functions, KV）
// 契约：最小事件集 + 只收枚举与 id，不收任何自由文本。
// 硬约束：**不接受任何自由文本**。事项名、笔记、成果、音频一律不进这里；白名单之外的字段直接丢弃。
// 键位：agg:{YYYY-MM-DD}:{name}:{platform} 计数；evdedup:{decisionId} 去重（TTL 7 天）。
import { json, readJson, isAdmin, rateLimit, tooBig, limited } from '../_lib.js';

// 最小事件集，一个不多一个不少。加事件要同时改客户端白名单。
const EVENT_NAMES = new Set([
  'session_started', 'reassessment_opened', 'decision_confirmed', 'resume_started',
  'reminder_scheduled', 'reminder_trigger_observed'
]);
const PLATFORMS = new Set(['web', 'unknown']);
const DECISION_KIND = new Set(['stop', 'switch', 'continue']);
const ENTRY_MODE = new Set(['planned', 'immediate']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const BATCH_MAX = 50;
const DEDUP_TTL = 60 * 60 * 24 * 7;
const DAY_MS = 86400e3;

// 事件时间统一按 UTC 落到自然日（跨时区不重复算一天）。
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

// 只留白名单字段；其余（包含任何文本）丢弃。返回 null 表示整条不收。
function cleanEvent(e, now) {
  if (!e || typeof e !== 'object') return null;
  if (!EVENT_NAMES.has(e.name)) return null;
  const platform = PLATFORMS.has(e.platform) ? e.platform : 'unknown';
  // 客户端时钟可能偏，也可能被人伪造成去年以灌某一天的数：夹在 ±2 天内，越界就按服务端现在算。
  let at = Number.isFinite(e.at) ? e.at : now;
  if (Math.abs(at - now) > 2 * DAY_MS) at = now;
  const out = { name: e.name, at, platform };
  if (typeof e.version === 'string' && /^[A-Za-z0-9._-]{1,20}$/.test(e.version)) out.version = e.version;
  if (DECISION_KIND.has(e.decisionKind)) out.decisionKind = e.decisionKind;
  if (ENTRY_MODE.has(e.entryMode)) out.entryMode = e.entryMode;
  if (typeof e.decisionId === 'string' && ID_RE.test(e.decisionId)) out.decisionId = e.decisionId;
  if (typeof e.sessionId === 'string' && ID_RE.test(e.sessionId)) out.sessionId = e.sessionId;
  return out;
}

export async function onRequest({ request, env, params }) {
  const path = (params.path || []).join('/');
  const method = request.method;

  // ---- 上报 ----------------------------------------------------------------
  // 不要求登录：访客模式也要能用核心产品，同意分析与否都不影响功能。
  // 代价是只能靠限流防灌，聚合数因此只是量级参考，不是审计口径。
  if (path === '' && method === 'POST') {
    if (tooBig(request, 64 * 1024)) return json({ error: '请求体过大' }, 413);
    if (!rateLimit(request, 'events', 60, 60e3)) return limited();// 60 次/分钟/IP
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.events)) return json({ error: 'bad body' }, 400);
    if (b.events.length > BATCH_MAX) return json({ error: 'batch_too_large', limit: BATCH_MAX }, 413);

    // 免费档 KV 只有 1000 次写/天。一个请求里逐条 get+put 会把配额烧得飞快，
    // 所以先在请求内把事件按 agg 键累加成一张表，一个键只写一次；evdedup 同理，一个 decisionId 只写一次。
    // 一个请求的写次数上限 = 不同 agg 键数 + 不同 decisionId 数，与事件条数解耦。
    const now = Date.now();
    let accepted = 0, dropped = 0, deduped = 0;
    const bump = new Map();      // agg 键 → 本请求内的增量
    const dedup = new Map();     // decisionId → { seen:Set, dirty:boolean }

    for (const rawEvent of b.events) {
      const e = cleanEvent(rawEvent, now);
      if (!e) { dropped++; continue; }

      // 去重：同一 decisionId 下每种事件名只计一次（刷新、重复提交、离线补传都不该多算）。
      // 一个 decisionId 会带出多种事件（reassessment_opened / decision_confirmed），
      // 所以键值里存的是「这个 decisionId 已经计过哪些事件名」，而不是简单的存在性标记。
      // 同一请求内的重复也走这张表，不必回 KV 再读一次。
      let entry = null;
      if (e.decisionId) {
        entry = dedup.get(e.decisionId);
        if (!entry) {
          entry = { seen: new Set(await readJson(env, 'evdedup:' + e.decisionId, [])), dirty: false };
          dedup.set(e.decisionId, entry);
        }
        if (entry.seen.has(e.name)) { deduped++; continue; }
      }

      const key = 'agg:' + dayOf(e.at) + ':' + e.name + ':' + e.platform;
      bump.set(key, (bump.get(key) || 0) + 1);
      accepted++;
      if (entry) { entry.seen.add(e.name); entry.dirty = true; }
    }

    // KV 的 get+put 不是原子的：并发请求之间仍会丢计数。这是刻意接受的误差——
    // 这些数只用来看量级与趋势，不靠这里的绝对值做任何自动决策。
    // 要精确计数得换 Durable Object，超出当前阶段范围。请求内的合并把误差窗口缩小了，没有消除它。
    for (const [key, inc] of bump) {
      const cur = parseInt(await env.KV.get(key), 10) || 0;
      await env.KV.put(key, String(cur + inc));
    }
    for (const [decisionId, entry] of dedup) {
      if (!entry.dirty) continue;
      await env.KV.put('evdedup:' + decisionId, JSON.stringify([...entry.seen].slice(0, 20)), { expirationTtl: DEDUP_TTL });
    }
    return json({ ok: true, accepted, dropped, deduped, writes: bump.size + [...dedup.values()].filter(x => x.dirty).length });
  }

  // ---- 汇总（管理端）-------------------------------------------------------
  if (path === 'summary' && method === 'GET') {
    if (!isAdmin(env, request)) return json({ error: 'forbidden' }, 403);
    const q = new URL(request.url).searchParams;
    const today = dayOf(Date.now());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '') ? q.get('to') : today;
    if (from > to) return json({ error: 'bad_range' }, 400);
    const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) + 1;
    if (!Number.isFinite(days) || days > 92) return json({ error: 'range_too_long', maxDays: 92 }, 400);

    const rows = {}, totals = {};
    for (let i = 0; i < days; i++) {
      const day = dayOf(Date.parse(from + 'T00:00:00Z') + i * DAY_MS);
      const listed = await env.KV.list({ prefix: 'agg:' + day + ':' });
      for (const k of listed.keys) {
        const [, , name, platform] = k.name.split(':');
        const n = parseInt(await env.KV.get(k.name), 10) || 0;
        rows[day] = rows[day] || {};
        rows[day][name + ':' + platform] = n;
        totals[name] = (totals[name] || 0) + n;
      }
    }
    return json({ from, to, days, totals, byDay: rows, note: 'KV get+put 非原子，并发上报存在漏计，数值仅供看量级' });
  }

  return json({ error: 'not found' }, 404);
}
