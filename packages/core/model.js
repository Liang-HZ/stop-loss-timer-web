// packages/core/model.js
// v2 领域模型：Task / Session / Decision 的创建、校验与 id 生成。
// 纯 JS ESM，零依赖，不触碰 DOM / 微信 / 原生 API。
// 核心数据契约（v2）的领域模型。

export const SCHEMA_VERSION = 2;

export const TASK_STATUSES = ['active', 'ended', 'completed', 'later'];
export const ENTRY_MODES = ['planned', 'immediate'];
export const DECISION_KINDS = ['stop', 'switch', 'continue'];
export const END_REASONS = ['decision', 'early', 'cancelled', 'unknown'];

export const NAME_MAX = 100;
export const TEXT_MAX = 500;

// 个人重评规则用的场景标签。取值来自跨场景例子
// （比价／卡题／清洁手工细节／争论／排查），外加一个「其它」——
// 可选场景必须含「其他／不填写」，不得强制用户归类。
export const SCENES = ['compare', 'stuck', 'detail', 'argue', 'debug', 'other'];

// 一个模板最多存几个时长组合：够表达「5/15/30」这类组合，又不至于被灌成长数组。
export const TEMPLATE_DURATIONS_MAX = 6;

/* ---------------- id 生成与上下文注入 ---------------- */

let fallbackCounter = 0;

// 优先 crypto.randomUUID；不可用时回退「时间戳 + 计数器 + 随机」，
// 计数器保证同一毫秒内连续生成不撞号（回退路径同样要求唯一）。
export function defaultIdGen() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch (e) { /* 落到回退分支 */ }
  }
  fallbackCounter = (fallbackCounter + 1) % 1e6;
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultNow() { return Date.now(); }

// 所有可能产生副作用（时间、随机）的入口都接受 ctx，测试可完全确定化。
export function createContext(ctx) {
  const now = ctx && typeof ctx.now === 'function' ? ctx.now : defaultNow;
  const idGen = ctx && typeof ctx.idGen === 'function' ? ctx.idGen : defaultIdGen;
  return { now, idGen };
}

export function newId(prefix, ctx) {
  const { idGen } = createContext(ctx);
  const raw = String(idGen());
  return prefix ? `${prefix}_${raw}` : raw;
}

/* ---------------- 错误 ---------------- */

export class ValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'invalid';
    this.errors = errors || [];
  }
}

/* ---------------- 小工具 ---------------- */

const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);
const isPosNum = v => isFiniteNum(v) && v > 0;
const isNonNegNum = v => isFiniteNum(v) && v >= 0;

function cleanText(v, max) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

function put(obj, key, value) {
  if (value !== undefined && value !== null) obj[key] = value;
  return obj;
}

/* ---------------- 创建函数 ---------------- */

export function createState(input, ctx) {
  const { now } = createContext(ctx);
  const src = input || {};
  const at = isFiniteNum(src.updatedAt) ? src.updatedAt : now();
  const state = {
    schemaVersion: SCHEMA_VERSION,
    tasks: Array.isArray(src.tasks) ? src.tasks.slice() : [],
    sessions: Array.isArray(src.sessions) ? src.sessions.slice() : [],
    decisions: Array.isArray(src.decisions) ? src.decisions.slice() : [],
    updatedAt: at,
    rev: isNonNegNum(src.rev) ? src.rev : 0
  };
  // templates 是可选字段：没有模板时整个键不出现，老数据的内容指纹因此不变，
  // 不会因为「加了个字段」给每个用户白白产生一次 KV 写（见 functions/api/_schema.js 的指纹说明）。
  if (Array.isArray(src.templates) && src.templates.length) state.templates = src.templates.slice();
  put(state, 'legacy', src.legacy);
  put(state, 'sourceVersion', src.sourceVersion);
  return state;
}

export function createTask(input, ctx) {
  const { now } = createContext(ctx);
  const src = input || {};
  const task = {
    taskId: src.taskId || newId('t', ctx),
    // 名称是可编辑文本；即时入口可以不填，用固定占位，不伪造内容。
    name: typeof src.name === 'string' ? src.name.trim().slice(0, NAME_MAX) : '',
    createdAt: isFiniteNum(src.createdAt) ? src.createdAt : now(),
    status: TASK_STATUSES.includes(src.status) ? src.status : 'active'
  };
  put(task, 'hypothesis', cleanText(src.hypothesis, TEXT_MAX));
  // scene / templateId 只在用户用自己的重评规则开一轮时出现；不填就没有这两个键，
  // 不替用户归类（高级复盘按它分组，分不了组就如实显示「其它」）。
  put(task, 'scene', SCENES.includes(src.scene) ? src.scene : undefined);
  put(task, 'templateId', typeof src.templateId === 'string' && src.templateId ? src.templateId.slice(0, 64) : undefined);
  put(task, 'updatedAt', isFiniteNum(src.updatedAt) ? src.updatedAt : task.createdAt);
  if (src.origin && typeof src.origin === 'object') {
    const origin = {};
    put(origin, 'legacyHistId', typeof src.origin.legacyHistId === 'string' ? src.origin.legacyHistId : undefined);
    if (Object.keys(origin).length) task.origin = origin;
  }
  assertValidTask(task);
  return task;
}

export function createSession(input, ctx) {
  const { now } = createContext(ctx);
  const src = input || {};
  const session = {
    sessionId: src.sessionId || newId('s', ctx),
    taskId: src.taskId,
    entryMode: ENTRY_MODES.includes(src.entryMode) ? src.entryMode : 'planned',
    deadlineChanges: Array.isArray(src.deadlineChanges) ? src.deadlineChanges.slice() : []
  };
  put(session, 'plannedMs', isPosNum(src.plannedMs) ? src.plannedMs : undefined);
  // legacyPlanned=true：plannedMs 来自旧版「计划时长」，不是实测投入。
  if (src.legacyPlanned === true) session.legacyPlanned = true;
  put(session, 'deadlineAt', isFiniteNum(src.deadlineAt) ? src.deadlineAt : undefined);
  // startedAt 缺失时绝不补造（旧数据没有真实开始时刻）。
  if (isFiniteNum(src.startedAt)) session.startedAt = src.startedAt;
  else if (src.startedAt === undefined && src.legacyPlanned !== true && src.legacy !== true) session.startedAt = now();
  put(session, 'endedAt', isFiniteNum(src.endedAt) ? src.endedAt : undefined);
  put(session, 'endReason', END_REASONS.includes(src.endReason) ? src.endReason : undefined);
  put(session, 'continuedFrom', typeof src.continuedFrom === 'string' ? src.continuedFrom : undefined);
  if (src.legacy === true) session.legacy = true;
  if (src.userEstimatedPriorMs && isNonNegNum(src.userEstimatedPriorMs.value)) {
    session.userEstimatedPriorMs = { value: src.userEstimatedPriorMs.value, source: 'user_estimate' };
  } else if (isNonNegNum(src.userEstimatedPriorMs)) {
    session.userEstimatedPriorMs = { value: src.userEstimatedPriorMs, source: 'user_estimate' };
  }
  assertValidSession(session);
  return session;
}

export function createDecision(input, ctx) {
  const { now } = createContext(ctx);
  const src = input || {};
  const decision = {
    decisionId: src.decisionId || newId('d', ctx),
    taskId: src.taskId,
    sessionId: typeof src.sessionId === 'string' ? src.sessionId : null,
    entryMode: ENTRY_MODES.includes(src.entryMode) ? src.entryMode : 'planned',
    at: isFiniteNum(src.at) ? src.at : now(),
    kind: src.kind
  };
  put(decision, 'continueMs', isPosNum(src.continueMs) ? src.continueMs : undefined);
  put(decision, 'note', cleanText(src.note, TEXT_MAX));
  put(decision, 'expectation', cleanText(src.expectation, TEXT_MAX));
  if (src.later === true) decision.later = true;
  if (src.completed === true) decision.completed = true;
  // 即时入口不设短提醒时没有 Session 可挂，用户自述的「之前已经花了多久」只能挂在决定上。
  // 它永远是用户估计值，与实测记录分开保存。
  if (src.userEstimatedPriorMs && isNonNegNum(src.userEstimatedPriorMs.value)) {
    decision.userEstimatedPriorMs = { value: src.userEstimatedPriorMs.value, source: 'user_estimate' };
  } else if (isNonNegNum(src.userEstimatedPriorMs)) {
    decision.userEstimatedPriorMs = { value: src.userEstimatedPriorMs, source: 'user_estimate' };
  }
  if (src.followUp && typeof src.followUp === 'object') {
    decision.followUp = normalizeFollowUp(src.followUp, decision.at);
  }
  assertValidDecision(decision);
  return decision;
}

export function normalizeFollowUp(input, fallbackAt) {
  const f = {};
  f.at = isFiniteNum(input.at) ? input.at : fallbackAt;
  if (typeof input.stillAgree === 'boolean') f.stillAgree = input.stillAgree;
  put(f, 'feeling', cleanText(input.feeling, TEXT_MAX));
  return f;
}

/* ---------------- 个人重评规则（模板） ---------------- */
// Template = 一组可复用的「投入边界 + 提醒语 + 时长组合」。它只是输入的预设值，
// 不参与任何「事项—轮次—决定」的语义判定：用模板开一轮和手填开一轮产生的记录完全一样。

export function createTemplate(input, ctx) {
  const { now } = createContext(ctx);
  const src = input || {};
  const at = isFiniteNum(src.createdAt) ? src.createdAt : now();
  const tpl = {
    templateId: src.templateId || newId('tpl', ctx),
    name: typeof src.name === 'string' ? src.name.trim().slice(0, NAME_MAX) : '',
    createdAt: at,
    updatedAt: isFiniteNum(src.updatedAt) ? src.updatedAt : at
  };
  put(tpl, 'hypothesis', cleanText(src.hypothesis, TEXT_MAX));   // 投入边界：什么情况就停下来／换个办法
  put(tpl, 'reminderText', cleanText(src.reminderText, TEXT_MAX)); // 提醒语：到点时想对自己说的一句
  put(tpl, 'scene', SCENES.includes(src.scene) ? src.scene : undefined);
  const durations = (Array.isArray(src.durationsMs) ? src.durationsMs : [])
    .filter(isPosNum)
    .map(v => Math.round(v))
    .filter((v, i, a) => a.indexOf(v) === i)          // 同一个时长写两遍是误操作，不是两个选项
    .sort((a, b) => a - b)
    .slice(0, TEMPLATE_DURATIONS_MAX);
  if (durations.length) tpl.durationsMs = durations;
  if (src.builtIn === true) tpl.builtIn = true;
  assertValidTemplate(tpl);
  return tpl;
}

export function validateTemplate(tpl) {
  const errors = [];
  if (!tpl || typeof tpl !== 'object') return { ok: false, errors: ['template: not an object'] };
  if (typeof tpl.templateId !== 'string' || !tpl.templateId) errors.push('template.templateId: required string');
  if (typeof tpl.name !== 'string' || !tpl.name.trim()) errors.push('template.name: required non-empty string');
  if (tpl.name && tpl.name.length > NAME_MAX) errors.push('template.name: too long');
  if (!isFiniteNum(tpl.createdAt)) errors.push('template.createdAt: required number');
  if (tpl.scene !== undefined && !SCENES.includes(tpl.scene)) errors.push(`template.scene: one of ${SCENES.join('|')}`);
  if (tpl.durationsMs !== undefined) {
    if (!Array.isArray(tpl.durationsMs) || !tpl.durationsMs.length) errors.push('template.durationsMs: non-empty array');
    else if (tpl.durationsMs.length > TEMPLATE_DURATIONS_MAX) errors.push('template.durationsMs: too many');
    else if (!tpl.durationsMs.every(isPosNum)) errors.push('template.durationsMs: positive numbers');
  }
  return { ok: errors.length === 0, errors };
}

/* ---------------- 校验函数 ---------------- */

export function validateTask(task) {
  const errors = [];
  if (!task || typeof task !== 'object') return { ok: false, errors: ['task: not an object'] };
  if (typeof task.taskId !== 'string' || !task.taskId) errors.push('task.taskId: required string');
  if (typeof task.name !== 'string') errors.push('task.name: required string');
  if (task.name && task.name.length > NAME_MAX) errors.push('task.name: too long');
  if (!isFiniteNum(task.createdAt)) errors.push('task.createdAt: required number');
  if (!TASK_STATUSES.includes(task.status)) errors.push(`task.status: one of ${TASK_STATUSES.join('|')}`);
  if (task.scene !== undefined && !SCENES.includes(task.scene)) errors.push(`task.scene: one of ${SCENES.join('|')}`);
  return { ok: errors.length === 0, errors };
}

export function validateSession(session) {
  const errors = [];
  if (!session || typeof session !== 'object') return { ok: false, errors: ['session: not an object'] };
  if (typeof session.sessionId !== 'string' || !session.sessionId) errors.push('session.sessionId: required string');
  if (typeof session.taskId !== 'string' || !session.taskId) errors.push('session.taskId: required string');
  if (!ENTRY_MODES.includes(session.entryMode)) errors.push(`session.entryMode: one of ${ENTRY_MODES.join('|')}`);
  if (!Array.isArray(session.deadlineChanges)) errors.push('session.deadlineChanges: required array');
  if (session.plannedMs !== undefined && !isPosNum(session.plannedMs)) errors.push('session.plannedMs: positive number');
  if (session.deadlineAt !== undefined && !isFiniteNum(session.deadlineAt)) errors.push('session.deadlineAt: number');
  // 旧数据（legacy / legacyPlanned）允许没有 startedAt——不补造真实开始时间。
  if (session.startedAt === undefined) {
    if (session.legacy !== true && session.legacyPlanned !== true) errors.push('session.startedAt: required unless legacy');
  } else if (!isFiniteNum(session.startedAt)) errors.push('session.startedAt: number');
  if (session.endedAt !== undefined && !isFiniteNum(session.endedAt)) errors.push('session.endedAt: number');
  if (session.endReason !== undefined && !END_REASONS.includes(session.endReason)) errors.push(`session.endReason: one of ${END_REASONS.join('|')}`);
  if (isFiniteNum(session.startedAt) && isFiniteNum(session.endedAt) && session.endedAt < session.startedAt) {
    errors.push('session.endedAt: must not precede startedAt');
  }
  if (session.userEstimatedPriorMs !== undefined) {
    const u = session.userEstimatedPriorMs;
    if (!u || !isNonNegNum(u.value) || u.source !== 'user_estimate') errors.push('session.userEstimatedPriorMs: {value, source:"user_estimate"}');
  }
  return { ok: errors.length === 0, errors };
}

export function validateDecision(decision) {
  const errors = [];
  if (!decision || typeof decision !== 'object') return { ok: false, errors: ['decision: not an object'] };
  if (typeof decision.decisionId !== 'string' || !decision.decisionId) errors.push('decision.decisionId: required string');
  if (typeof decision.taskId !== 'string' || !decision.taskId) errors.push('decision.taskId: required string');
  if (!(decision.sessionId === null || typeof decision.sessionId === 'string')) errors.push('decision.sessionId: string or null');
  if (!ENTRY_MODES.includes(decision.entryMode)) errors.push(`decision.entryMode: one of ${ENTRY_MODES.join('|')}`);
  if (!isFiniteNum(decision.at)) errors.push('decision.at: required number');
  if (!DECISION_KINDS.includes(decision.kind)) errors.push(`decision.kind: one of ${DECISION_KINDS.join('|')}`);
  if (decision.kind === 'continue' && decision.continueMs !== undefined && !isPosNum(decision.continueMs)) {
    errors.push('decision.continueMs: positive number');
  }
  // 「以后再看」和「事项已完成」是互斥的两种结束形态，不能同时成立。
  if (decision.later === true && decision.completed === true) errors.push('decision: later and completed are mutually exclusive');
  if ((decision.later === true || decision.completed === true) && decision.kind !== 'stop') {
    errors.push('decision: later/completed only apply to kind="stop"');
  }
  if (decision.userEstimatedPriorMs !== undefined) {
    const u = decision.userEstimatedPriorMs;
    if (!u || !isNonNegNum(u.value) || u.source !== 'user_estimate') errors.push('decision.userEstimatedPriorMs: {value, source:"user_estimate"}');
  }
  return { ok: errors.length === 0, errors };
}

export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== 'object') return { ok: false, errors: ['state: not an object'] };
  if (state.schemaVersion !== SCHEMA_VERSION) errors.push(`state.schemaVersion: must be ${SCHEMA_VERSION}`);
  for (const key of ['tasks', 'sessions', 'decisions']) {
    if (!Array.isArray(state[key])) errors.push(`state.${key}: required array`);
  }
  if (errors.length) return { ok: false, errors };
  if (state.templates !== undefined) {
    if (!Array.isArray(state.templates)) errors.push('state.templates: array when present');
    else {
      const tplIds = new Set();
      for (const tpl of state.templates) {
        const r = validateTemplate(tpl);
        if (!r.ok) errors.push(...r.errors);
        else if (tplIds.has(tpl.templateId)) errors.push(`state.templates: duplicate templateId ${tpl.templateId}`);
        else tplIds.add(tpl.templateId);
      }
    }
  }
  const taskIds = new Set();
  for (const t of state.tasks) {
    const r = validateTask(t);
    if (!r.ok) errors.push(...r.errors);
    else if (taskIds.has(t.taskId)) errors.push(`state.tasks: duplicate taskId ${t.taskId}`);
    else taskIds.add(t.taskId);
  }
  const sessionIds = new Set();
  for (const s of state.sessions) {
    const r = validateSession(s);
    if (!r.ok) errors.push(...r.errors);
    else if (sessionIds.has(s.sessionId)) errors.push(`state.sessions: duplicate sessionId ${s.sessionId}`);
    else {
      sessionIds.add(s.sessionId);
      if (!taskIds.has(s.taskId)) errors.push(`state.sessions: orphan session ${s.sessionId}`);
    }
  }
  const decisionIds = new Set();
  for (const d of state.decisions) {
    const r = validateDecision(d);
    if (!r.ok) errors.push(...r.errors);
    else if (decisionIds.has(d.decisionId)) errors.push(`state.decisions: duplicate decisionId ${d.decisionId}`);
    else {
      decisionIds.add(d.decisionId);
      if (!taskIds.has(d.taskId)) errors.push(`state.decisions: orphan decision ${d.decisionId}`);
      if (d.sessionId && !sessionIds.has(d.sessionId)) errors.push(`state.decisions: unknown sessionId ${d.sessionId}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertWith(fn, value, label) {
  const r = fn(value);
  if (!r.ok) throw new ValidationError(`${label} invalid: ${r.errors.join('; ')}`, r.errors);
  return value;
}

export const assertValidTemplate = tpl => assertWith(validateTemplate, tpl, 'Template');
export const assertValidTask = t => assertWith(validateTask, t, 'Task');
export const assertValidSession = s => assertWith(validateSession, s, 'Session');
export const assertValidDecision = d => assertWith(validateDecision, d, 'Decision');
export const assertValidState = s => assertWith(validateState, s, 'State');

/* ---------------- 查询辅助（无副作用） ---------------- */

export const findTask = (state, taskId) => state.tasks.find(t => t.taskId === taskId) || null;
export const findSession = (state, sessionId) => state.sessions.find(s => s.sessionId === sessionId) || null;
export const findDecision = (state, decisionId) => state.decisions.find(d => d.decisionId === decisionId) || null;
export const findTemplate = (state, templateId) => (state.templates || []).find(x => x.templateId === templateId) || null;

export const isSessionOpen = s => !!s && s.endedAt === undefined;

export function openSessionsOf(state, taskId) {
  return state.sessions.filter(s => s.taskId === taskId && isSessionOpen(s));
}

export function sessionsOf(state, taskId) {
  return state.sessions.filter(s => s.taskId === taskId);
}

export function decisionsOf(state, taskId) {
  return state.decisions.filter(d => d.taskId === taskId);
}

// 实测经过时间：只有同时存在真实 startedAt 与 endedAt 才成立，否则为 null（不估算）。
export function sessionElapsedMs(session) {
  if (!session) return null;
  if (!isFiniteNum(session.startedAt) || !isFiniteNum(session.endedAt)) return null;
  return Math.max(0, session.endedAt - session.startedAt);
}
