// public/app/reminders.js
// 提醒排期策略与按 sessionId 的去重调度。纯逻辑，不碰 Web Audio：
// 真正的响铃由调用方通过 scheduleFn/cancelFn 注入（浏览器里是 beepAt / silence）。
// 提醒契约：到点响一次，未响应时最多再提醒两次、间隔 60 秒；
// 确认决定、静音或取消后终止全部排队提醒。

export const DEFAULT_MAX_ALERTS = 3;   // 到点那次 + 之后两次
export const DEFAULT_INTERVAL_MS = 60000;

/**
 * 算出一次 session 要排哪几次铃（相对 now 的秒数）。
 * - 已经过了的那几次不补响（不制造一串立刻爆掉的铃）。
 * - muted 或 maxAlerts<=0 直接空数组。
 * - preAlertMs（Pro「预告提醒」）在到点**之前**先响一次，index 为 -1、kind 'pre'。
 *   预告不是决定时刻：它不改 deadlineAt，也不减少到点那次（
 *   「到点播放一次基础铃声；用户尚未响应时，最多再提醒两次」说的是到点之后的那几次）。
 * @returns {{index:number, kind:'pre'|'due', at:number, delaySec:number}[]}
 */
export function planReminders(input) {
  const o = input || {};
  const deadlineAt = Number(o.deadlineAt);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (!Number.isFinite(deadlineAt)) return [];
  if (o.muted === true) return [];
  const max = Number.isFinite(o.maxAlerts) ? Math.max(0, Math.round(o.maxAlerts)) : DEFAULT_MAX_ALERTS;
  const interval = Number.isFinite(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : DEFAULT_INTERVAL_MS;
  const out = [];
  const preMs = Number(o.preAlertMs);
  if (Number.isFinite(preMs) && preMs > 0) {
    const at = deadlineAt - preMs;
    // 预告已经过去（或设得比剩余时间还长）就不补响，也不把它挤到到点那次前面去。
    if (at >= now) out.push({ index: -1, kind: 'pre', at, delaySec: (at - now) / 1000 });
  }
  for (let i = 0; i < max; i++) {
    const at = deadlineAt + i * interval;
    if (at < now) continue;             // 错过的那次不追响
    out.push({ index: i, kind: 'due', at, delaySec: (at - now) / 1000 });
  }
  return out;
}

/**
 * 按 sessionId 去重的排期表。
 * 同一个 sessionId 重排会先取消旧的（改截止时刻、续时、刷新都靠这条保证不叠铃）。
 */
export class ReminderScheduler {
  /**
   * @param {{schedule:(delaySec:number, meta:object)=>any, cancel:(handle:any)=>void, now?:()=>number}} io
   */
  constructor(io) {
    const o = io || {};
    this.scheduleFn = typeof o.schedule === 'function' ? o.schedule : () => null;
    this.cancelFn = typeof o.cancel === 'function' ? o.cancel : () => {};
    this.now = typeof o.now === 'function' ? o.now : Date.now;
    this.entries = new Map(); // sessionId -> {deadlineAt, handles:[], plan:[]}
  }

  /** 排一个 session 的全部提醒；返回实际排上的计划。 */
  schedule(sessionId, deadlineAt, settings) {
    if (!sessionId) return [];
    this.cancel(sessionId);
    const s = settings || {};
    const plan = planReminders({
      deadlineAt,
      now: this.now(),
      maxAlerts: s.reminderMaxAlerts,
      intervalMs: s.reminderIntervalMs,
      preAlertMs: s.preAlertMs,
      muted: s.muted
    });
    const handles = [];
    for (const p of plan) {
      const h = this.scheduleFn(p.delaySec, { sessionId, index: p.index, kind: p.kind, at: p.at });
      if (h !== undefined && h !== null) handles.push(h);
    }
    this.entries.set(sessionId, { deadlineAt, handles, plan });
    return plan;
  }

  /** 确认决定、取消这一轮、静音——都走这里，把该 session 排队中的铃全部停掉。 */
  cancel(sessionId) {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    for (const h of e.handles) {
      try { this.cancelFn(h); } catch (err) { /* 单个句柄失效不影响其余取消 */ }
    }
    this.entries.delete(sessionId);
    return true;
  }

  cancelAll() {
    const ids = [...this.entries.keys()];
    ids.forEach(id => this.cancel(id));
    return ids.length;
  }

  has(sessionId) { return this.entries.has(sessionId); }
  get size() { return this.entries.size; }
  planOf(sessionId) {
    const e = this.entries.get(sessionId);
    return e ? e.plan : [];
  }

  /** 按当前 state 的未结束轮次重排全部提醒：多出来的取消，缺的补上（刷新后恢复用）。 */
  syncWith(openSessions, settings) {
    const wanted = new Set();
    for (const s of openSessions || []) {
      if (!s || !s.sessionId || !Number.isFinite(s.deadlineAt)) continue;
      wanted.add(s.sessionId);
      const cur = this.entries.get(s.sessionId);
      if (cur && cur.deadlineAt === s.deadlineAt) continue;   // 没变就不重排，避免每秒重建
      this.schedule(s.sessionId, s.deadlineAt, settings);
    }
    for (const id of [...this.entries.keys()]) if (!wanted.has(id)) this.cancel(id);
    return this.entries.size;
  }
}

/** 到点后已经等了多久——「超时待响应」单独显示，不计入有效投入。 */
export function overdueMs(session, now) {
  if (!session || !Number.isFinite(session.deadlineAt)) return 0;
  const end = Number.isFinite(session.endedAt) ? session.endedAt : now;
  return Math.max(0, end - session.deadlineAt);
}

/** 本轮的有效投入：开始到「截止时刻与结束时刻里更早的那个」，超时那段不算进来。 */
export function effectiveElapsedMs(session, now) {
  if (!session || !Number.isFinite(session.startedAt)) return null;
  const end = Number.isFinite(session.endedAt) ? session.endedAt : now;
  const cap = Number.isFinite(session.deadlineAt) ? Math.min(end, session.deadlineAt) : end;
  return Math.max(0, cap - session.startedAt);
}
