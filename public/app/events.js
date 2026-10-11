// public/app/events.js
// 经同意的最小事件：构造、白名单过滤、批量缓冲。纯逻辑，不发请求。
// 硬约束：**任何自由文本都不进这里**——事项名、笔记、期待、感受一律不上传。

export const PLATFORM = 'web';
export const APP_VERSION = '2.0.0';

// 由 Web 客户端上报的最小事件集合，与服务端 functions/api/events 的白名单保持一致。
export const CLIENT_EVENTS = Object.freeze([
  'session_started',
  'reassessment_opened',
  'decision_confirmed',
  'resume_started',
  'reminder_scheduled',
  'reminder_trigger_observed'
]);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DECISION_KINDS = new Set(['stop', 'switch', 'continue']);
const ENTRY_MODES = new Set(['planned', 'immediate']);

/**
 * 造一条事件。只保留枚举与 id，其他字段一概丢弃。
 * @returns {object|null} 不在白名单就是 null（调用方不必自己判断）
 */
export function buildEvent(name, input) {
  if (!CLIENT_EVENTS.includes(name)) return null;
  const o = input || {};
  const e = {
    name,
    at: Number.isFinite(o.at) ? o.at : Date.now(),
    platform: PLATFORM,
    version: APP_VERSION
  };
  if (DECISION_KINDS.has(o.decisionKind)) e.decisionKind = o.decisionKind;
  if (ENTRY_MODES.has(o.entryMode)) e.entryMode = o.entryMode;
  if (typeof o.decisionId === 'string' && ID_RE.test(o.decisionId)) e.decisionId = o.decisionId;
  if (typeof o.sessionId === 'string' && ID_RE.test(o.sessionId)) e.sessionId = o.sessionId;
  return e;
}

/** 一条事件里有没有混进自由文本字段（测试用的断言口径，也给 UI 自检）。 */
export const EVENT_ALLOWED_FIELDS = Object.freeze([
  'name', 'at', 'platform', 'version', 'decisionKind', 'entryMode', 'decisionId', 'sessionId'
]);

export function hasFreeText(event) {
  if (!event || typeof event !== 'object') return false;
  return Object.keys(event).some(k => !EVENT_ALLOWED_FIELDS.includes(k));
}

/**
 * 事件缓冲：同意关闭时整个是空操作（不排队、不留痕，关掉也能完整用产品）。
 * 攒够 batchMax 或调用 flush() 时交给注入的 send(events)。
 */
export class EventBuffer {
  constructor(io) {
    const o = io || {};
    this.send = typeof o.send === 'function' ? o.send : async () => {};
    this.enabled = o.enabled === true;
    this.batchMax = Number.isFinite(o.batchMax) ? o.batchMax : 20;
    this.queue = [];
    this.sentCount = 0;
  }

  setEnabled(on) {
    this.enabled = on === true;
    if (!this.enabled) this.queue = [];   // 关掉就把没发出去的丢掉，不留到下次
    return this.enabled;
  }

  track(name, input) {
    if (!this.enabled) return null;
    const e = buildEvent(name, input);
    if (!e) return null;
    this.queue.push(e);
    if (this.queue.length >= this.batchMax) this.flush();
    return e;
  }

  async flush() {
    if (!this.enabled || !this.queue.length) return { sent: 0 };
    const batch = this.queue.splice(0, this.batchMax);
    try {
      await this.send(batch);
      this.sentCount += batch.length;
      return { sent: batch.length };
    } catch (e) {
      // 发不出去就算了：分析不是核心功能，不重试、不堆积、不影响使用。
      return { sent: 0, failed: batch.length };
    }
  }
}
