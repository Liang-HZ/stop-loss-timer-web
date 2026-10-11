// 构建产物，勿手改。源码在 packages/core/，用 `npm run build:core` 重新生成。
// packages/core/flow.js
// 状态流：纯函数 reducer 风格，输入 state 不被修改，返回新的 state。
// 所有入口（到点、提前收尾、列表、全屏、画中画、即时重评）都走同一个 decide()。
// 重评流程的纯函数规则。

import {
  SCHEMA_VERSION, createState, createTask, createSession, createDecision, createTemplate,
  createContext, newId, normalizeFollowUp,
  findTask, findSession, findDecision, findTemplate, isSessionOpen, openSessionsOf, sessionsOf,
  ValidationError
} from './model.js';
import { assertCanAdd } from './capacity.js';

export class FlowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FlowError';
    this.code = code || 'flow_error';
  }
}

/* ---------------- 不可变更新小工具 ---------------- */

function baseState(state, ctx) {
  if (!state) return createState({}, ctx);
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new FlowError(`state.schemaVersion 必须为 ${SCHEMA_VERSION}，收到 ${state.schemaVersion}`, 'schema_mismatch');
  }
  return state;
}

function nextState(state, patch, at) {
  const out = {
    ...state,
    ...patch,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: at,
    rev: (Number(state.rev) || 0) + 1
  };
  return out;
}

function replaceIn(arr, idKey, id, updater) {
  let touched = false;
  const out = arr.map(x => {
    if (x[idKey] !== id) return x;
    touched = true;
    return updater(x);
  });
  if (!touched) throw new FlowError(`找不到 ${idKey}=${id}`, 'not_found');
  return out;
}

function touchTask(task, at) {
  return { ...task, updatedAt: at };
}

/* ---------------- 结束原因判定 ---------------- */
// 「提前结束」与「到点后确认」必须可区分：
// 决定时刻早于约定截止时刻 → 'early'；到点或超时后确认 → 'decision'；
// 没有截止时刻（即时入口的短提醒未设时）→ 'decision'。
export function computeEndReason(session, at) {
  if (!session) return 'unknown';
  if (typeof session.deadlineAt === 'number' && Number.isFinite(session.deadlineAt)) {
    return at < session.deadlineAt ? 'early' : 'decision';
  }
  return 'decision';
}

function closeSession(session, at, endReason) {
  return { ...session, endedAt: at, endReason };
}

/* ---------------- 入口：事前设点 ---------------- */

export function startPlanned(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = input || {};
  const plannedMs = resolvePlannedMs(opts, at);
  if (!plannedMs.deadlineAt) throw new FlowError('startPlanned 需要 plannedMs 或 deadlineAt', 'invalid_input');

  assertCanAdd(s0, { tasks: 1, sessions: 1 });

  const task = createTask({
    taskId: opts.taskId,
    name: opts.name,
    hypothesis: opts.hypothesis,
    scene: opts.scene,
    templateId: opts.templateId,
    createdAt: at,
    status: 'active'
  }, c);
  const session = createSession({
    sessionId: opts.sessionId,
    taskId: task.taskId,
    entryMode: 'planned',
    plannedMs: plannedMs.plannedMs,
    deadlineAt: plannedMs.deadlineAt,
    startedAt: at,
    userEstimatedPriorMs: opts.userEstimatedPriorMs
  }, c);

  return {
    state: nextState(s0, { tasks: [...s0.tasks, task], sessions: [...s0.sessions, session] }, at),
    task,
    session
  };
}

function resolvePlannedMs(opts, at) {
  const hasPlanned = Number.isFinite(opts.plannedMs) && opts.plannedMs > 0;
  const hasDeadline = Number.isFinite(opts.deadlineAt);
  if (hasPlanned && hasDeadline) return { plannedMs: opts.plannedMs, deadlineAt: opts.deadlineAt };
  if (hasPlanned) return { plannedMs: opts.plannedMs, deadlineAt: at + opts.plannedMs };
  if (hasDeadline) return { plannedMs: Math.max(1, opts.deadlineAt - at), deadlineAt: opts.deadlineAt };
  return { plannedMs: undefined, deadlineAt: undefined };
}

/* ---------------- 入口：已经纠结时直接进入 ---------------- */
// 即时入口默认不建 Session（没有真实计时就不生成伪造的开始／耗时）。
// 只有用户选择「从现在设一个短提醒」（withShortReminderMs）才建一个 immediate Session。
export function enterImmediate(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = input || {};
  const withReminder = Number.isFinite(opts.withShortReminderMs) && opts.withShortReminderMs > 0;

  assertCanAdd(s0, { tasks: 1, sessions: withReminder ? 1 : 0 });

  const task = createTask({
    taskId: opts.taskId,
    name: opts.name || '',
    hypothesis: opts.hypothesis,
    scene: opts.scene,
    templateId: opts.templateId,
    createdAt: at,
    status: 'active'
  }, c);

  let session = null;
  let sessions = s0.sessions;
  if (withReminder) {
    session = createSession({
      sessionId: opts.sessionId,
      taskId: task.taskId,
      entryMode: 'immediate',
      plannedMs: opts.withShortReminderMs,
      deadlineAt: at + opts.withShortReminderMs,
      startedAt: at,
      userEstimatedPriorMs: opts.userEstimatedPriorMs
    }, c);
    sessions = [...s0.sessions, session];
  }

  return {
    state: nextState(s0, { tasks: [...s0.tasks, task], sessions }, at),
    task,
    session
  };
}

/* ---------------- 改截止时刻 ---------------- */

export function changeDeadline(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = input || {};
  if (!Number.isFinite(opts.deadlineAt)) throw new FlowError('changeDeadline 需要 deadlineAt', 'invalid_input');
  const session = findSession(s0, opts.sessionId);
  if (!session) throw new FlowError(`找不到 sessionId=${opts.sessionId}`, 'not_found');
  if (!isSessionOpen(session)) throw new FlowError('已结束的轮次不能改截止时刻', 'session_closed');
  if (session.deadlineAt === opts.deadlineAt) return { state: s0, session, changed: false };

  const updated = {
    ...session,
    deadlineAt: opts.deadlineAt,
    deadlineChanges: [...session.deadlineChanges, { at, deadlineAt: opts.deadlineAt }]
  };
  return {
    state: nextState(s0, { sessions: replaceIn(s0.sessions, 'sessionId', session.sessionId, () => updated) }, at),
    session: updated,
    changed: true
  };
}

/* ---------------- 打开重评 ---------------- */
// 打开重评本身不改数据（不自动结束、归档或判定失败）。
// 它只产出一份 draft：decisionId 在这里生成，所有入口带着同一个 id 去 decide()，天然幂等。
export function openReassessment(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = input || {};
  const { task, session } = resolveTarget(s0, opts);
  const draft = {
    decisionId: opts.decisionId || newId('d', c),
    taskId: task.taskId,
    sessionId: session ? session.sessionId : null,
    entryMode: session ? session.entryMode : 'immediate',
    openedAt: at,
    overdue: !!(session && Number.isFinite(session.deadlineAt) && at >= session.deadlineAt)
  };
  return { state: s0, draft, task, session };
}

function resolveTarget(state, opts) {
  let session = null;
  let task = null;
  if (opts.sessionId) {
    session = findSession(state, opts.sessionId);
    if (!session) throw new FlowError(`找不到 sessionId=${opts.sessionId}`, 'not_found');
    task = findTask(state, session.taskId);
  } else if (opts.taskId) {
    task = findTask(state, opts.taskId);
    if (!task) throw new FlowError(`找不到 taskId=${opts.taskId}`, 'not_found');
    const open = openSessionsOf(state, task.taskId);
    session = open.length ? open[open.length - 1] : null;
  } else {
    throw new FlowError('需要 taskId 或 sessionId', 'invalid_input');
  }
  if (!task) throw new FlowError('找不到对应事项', 'not_found');
  return { task, session };
}

/* ---------------- 统一决定入口 ---------------- */

export function decide(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = input || {};
  const kind = opts.kind;
  if (!['stop', 'switch', 'continue'].includes(kind)) {
    throw new FlowError(`decide 的 kind 必须是 stop|switch|continue，收到 ${kind}`, 'invalid_input');
  }
  if (opts.later === true && opts.completed === true) {
    throw new ValidationError('later 与 completed 互斥', ['decision: later and completed are mutually exclusive']);
  }

  // 幂等：刷新、重复提交、重复同步都带同一个 decisionId，不重复归档。
  if (opts.decisionId) {
    const existing = findDecision(s0, opts.decisionId);
    if (existing) return { state: s0, decision: existing, idempotent: true, session: null, task: findTask(s0, existing.taskId) };
  }

  const { task, session } = resolveTarget(s0, opts);
  const entryMode = opts.entryMode || (session ? session.entryMode : 'immediate');

  const decision = createDecision({
    decisionId: opts.decisionId,
    taskId: task.taskId,
    sessionId: session ? session.sessionId : null,
    entryMode,
    at: Number.isFinite(opts.at) ? opts.at : at,
    kind,
    continueMs: kind === 'continue' ? opts.continueMs : undefined,
    note: opts.note,
    expectation: opts.expectation,
    later: kind === 'stop' ? opts.later === true : undefined,
    completed: kind === 'stop' ? opts.completed === true : undefined,
    // 即时入口没有 Session 时，用户估计的此前投入只能挂在这条决定上。
    userEstimatedPriorMs: opts.userEstimatedPriorMs
  }, c);

  let sessions = s0.sessions;
  let newSession = null;

  // 关闭当前轮（如果有）。已经结束的轮不再重复关闭，保持幂等。
  if (session && isSessionOpen(session)) {
    const closed = closeSession(session, decision.at, computeEndReason(session, decision.at));
    sessions = replaceIn(sessions, 'sessionId', session.sessionId, () => closed);
  }

  let status = task.status;
  if (kind === 'stop') {
    // 默认已结束；只有用户主动勾「以后再看」才进入待继续，只有明确说事项完成才是 completed。
    status = decision.later === true ? 'later' : (decision.completed === true ? 'completed' : 'ended');
  } else if (kind === 'switch') {
    // 换个办法：结束当前轮，事项结束，不新建 Session，不强制新建任务。
    status = 'ended';
  } else if (kind === 'continue') {
    status = 'active';
    const continueMs = Number.isFinite(opts.continueMs) && opts.continueMs > 0 ? opts.continueMs : null;
    if (!continueMs) throw new FlowError('continue 需要 continueMs（毫秒）', 'invalid_input');
    assertCanAdd(s0, { sessions: 1, decisions: 1 });
    newSession = createSession({
      sessionId: opts.newSessionId,
      taskId: task.taskId,
      entryMode: session ? session.entryMode : 'immediate',
      plannedMs: continueMs,
      deadlineAt: decision.at + continueMs,
      startedAt: decision.at,
      continuedFrom: session ? session.sessionId : undefined
    }, c);
    sessions = [...sessions, newSession];
  }

  assertCanAdd(s0, { decisions: 1 });

  const tasks = replaceIn(s0.tasks, 'taskId', task.taskId, t => ({ ...touchTask(t, at), status }));
  return {
    state: nextState(s0, { tasks, sessions, decisions: [...s0.decisions, decision] }, at),
    decision,
    session: newSession,
    closedSessionId: session ? session.sessionId : null,
    task: tasks.find(t => t.taskId === task.taskId),
    idempotent: false
  };
}

/* ---------------- 取消误建的轮次 ---------------- */
// 取消保留 'cancelled' 状态用于排除使用指标；取消提醒不自动取消任务。
export function cancelSession(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = input || {};
  const session = findSession(s0, opts.sessionId);
  if (!session) throw new FlowError(`找不到 sessionId=${opts.sessionId}`, 'not_found');
  if (!isSessionOpen(session)) return { state: s0, session, idempotent: true };
  const closed = closeSession(session, at, 'cancelled');
  return {
    state: nextState(s0, { sessions: replaceIn(s0.sessions, 'sessionId', session.sessionId, () => closed) }, at),
    session: closed,
    idempotent: false
  };
}

/* ---------------- 从「以后再看」接续 ---------------- */

export function resumeLater(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = typeof input === 'string' ? { taskId: input } : (input || {});
  const task = findTask(s0, opts.taskId);
  if (!task) throw new FlowError(`找不到 taskId=${opts.taskId}`, 'not_found');
  if (task.status !== 'later') {
    throw new FlowError('只有用户主动选择「以后再看」的事项才提供接续入口', 'not_later');
  }
  const planned = resolvePlannedMs(opts, at);
  if (!planned.deadlineAt) throw new FlowError('resumeLater 需要 plannedMs 或 deadlineAt', 'invalid_input');
  assertCanAdd(s0, { sessions: 1 });

  const prior = sessionsOf(s0, task.taskId);
  const last = prior.length ? prior[prior.length - 1] : null;
  const session = createSession({
    sessionId: opts.sessionId,
    taskId: task.taskId,
    entryMode: opts.entryMode === 'immediate' ? 'immediate' : 'planned',
    plannedMs: planned.plannedMs,
    deadlineAt: planned.deadlineAt,
    startedAt: at,
    continuedFrom: last ? last.sessionId : undefined,
    userEstimatedPriorMs: opts.userEstimatedPriorMs
  }, c);

  const tasks = replaceIn(s0.tasks, 'taskId', task.taskId, t => ({ ...touchTask(t, at), status: 'active' }));
  return {
    state: nextState(s0, { tasks, sessions: [...s0.sessions, session] }, at),
    task: tasks.find(t => t.taskId === task.taskId),
    session
  };
}

/* ---------------- 待启念头管理 (On Deck) ---------------- */

export function saveOnDeck(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = typeof input === 'string' ? { name: input } : (input || {});
  assertCanAdd(s0, { tasks: 1 });
  const task = createTask({
    taskId: opts.taskId,
    name: opts.name,
    hypothesis: opts.hypothesis,
    scene: opts.scene,
    templateId: opts.templateId,
    createdAt: at,
    status: 'later'
  }, c);
  return {
    state: nextState(s0, { tasks: [...s0.tasks, task] }, at),
    task
  };
}

export function dismissOnDeck(state, taskId, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const task = findTask(s0, taskId);
  if (!task) throw new FlowError(`找不到 taskId=${taskId}`, 'not_found');
  const tasks = replaceIn(s0.tasks, 'taskId', taskId, t => ({ ...touchTask(t, at), status: 'ended' }));
  return {
    state: nextState(s0, { tasks }, at),
    task: tasks.find(t => t.taskId === taskId)
  };
}

export function completeOnDeck(state, taskId, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const task = findTask(s0, taskId);
  if (!task) throw new FlowError(`找不到 taskId=${taskId}`, 'not_found');
  const tasks = replaceIn(s0.tasks, 'taskId', taskId, t => ({ ...touchTask(t, at), status: 'completed' }));
  return {
    state: nextState(s0, { tasks }, at),
    task: tasks.find(t => t.taskId === taskId)
  };
}

/* ---------------- 24–72 小时后的回访 ---------------- */

export function followUp(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = typeof input === 'string' ? { decisionId: input } : (input || {});
  const decision = findDecision(s0, opts.decisionId);
  if (!decision) throw new FlowError(`找不到 decisionId=${opts.decisionId}`, 'not_found');
  const f = normalizeFollowUp({ at: Number.isFinite(opts.at) ? opts.at : at, stillAgree: opts.stillAgree, feeling: opts.feeling }, at);
  const updated = { ...decision, followUp: f };
  return {
    state: nextState(s0, { decisions: replaceIn(s0.decisions, 'decisionId', decision.decisionId, () => updated) }, at),
    decision: updated
  };
}


/* ---------------- 个人重评规则：保存 / 删除 ---------------- */
// 模板只是输入预设，不产生任何事项／轮次／决定。保存与删除都走同一套不可变更新与容量检查。

export function saveTemplate(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const opts = input || {};
  const list = Array.isArray(s0.templates) ? s0.templates : [];
  const existing = opts.templateId ? findTemplate(s0, opts.templateId) : null;
  if (opts.templateId && !existing) throw new FlowError(`找不到 templateId=${opts.templateId}`, 'not_found');
  if (!existing) assertCanAdd(s0, { templates: 1 });

  const tpl = createTemplate({
    ...opts,
    templateId: existing ? existing.templateId : opts.templateId,
    createdAt: existing ? existing.createdAt : at,
    updatedAt: at
  }, c);

  const templates = existing
    ? list.map(x => (x.templateId === tpl.templateId ? tpl : x))
    : [...list, tpl];
  return { state: nextState(s0, { templates }, at), template: tpl, created: !existing };
}

export function deleteTemplate(state, input, ctx) {
  const c = createContext(ctx);
  const s0 = baseState(state, ctx);
  const at = c.now();
  const id = typeof input === 'string' ? input : (input || {}).templateId;
  const list = Array.isArray(s0.templates) ? s0.templates : [];
  if (!list.some(x => x.templateId === id)) throw new FlowError(`找不到 templateId=${id}`, 'not_found');
  const templates = list.filter(x => x.templateId !== id);
  // 已经用这个模板开过的事项不受影响：task.templateId 只是来源线索，删模板不改历史记录。
  return { state: nextState(s0, { templates }, at), templateId: id };
}
