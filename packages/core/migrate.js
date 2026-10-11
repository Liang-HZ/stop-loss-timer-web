// packages/core/migrate.js
// v1 → v2 迁移，以及回退用的 v1 投影。
//
// v1 的真实形态（来自 public/index.html 与 functions/api/[[route]].js）：
//   localStorage 'stoploss.v1'         → items[]   {name, end, total, prevTotal, rounds, originHistId, hypothesis}
//   localStorage 'stoploss.history.v1' → history[] {id, name, end, total, rounds, doneAt, decision, note,
//                                                   hypothesis, sessions:[{doneAt, duration, decision, note}]}
//   云端 data:{user} 同形，另有 updatedAt。
//
// v1 decision 枚举 → v2 kind 映射表（archive() 只写入 'completed' / 'switched'；
// 'next_round' 是 v1 的 UI 选项，未落盘，但旧快照与手改数据里可能出现，一并接住）：
//
//   v1 decision     | v2 Decision.kind | 迁移后 Task.status | 说明
//   ----------------|------------------|--------------------|--------------------------------------------
//   'completed'     | 'stop'           | 'ended'            | v1 的默认值（archive 的缺省参数），只代表
//                   |                  |                    | 「这一轮归档了」，不代表用户声明事项已完成，
//                   |                  |                    | 因此绝不映射成 'completed'（PLAN：不自动标记已完成）
//   'switched'      | 'switch'         | 'ended'            | v1「果断止损／换思路」
//   'next_round'    | 'continue'       | 'later'            | v1 续时选项；属于「继续／捞回」类，可接续
//   'continue'      | 'continue'       | 'later'            | 同上（别名）
//   'continued'     | 'continue'       | 'later'            | 同上（别名）
//   'restored'      | 'continue'       | 'later'            | v1 捞回语义的别名
//   缺失 / 未知     | 'stop'           | 'ended'            | 不猜测，按已结束处理
//
// Task.status 由该事项**最后一条** session 的 decision 决定；其余一律 'ended'。

import {
  SCHEMA_VERSION, createTask, createSession, createDecision, createContext, newId
} from './model.js';

export const LEGACY_DECISION_MAP = Object.freeze({
  completed: 'stop',
  switched: 'switch',
  next_round: 'continue',
  continue: 'continue',
  continued: 'continue',
  restored: 'continue'
});

// v2 → v1 的反向映射（导出与回退用）。
export const V2_TO_V1_DECISION = Object.freeze({
  stop: 'completed',
  switch: 'switched',
  continue: 'next_round'
});

export function mapLegacyDecision(raw) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  return LEGACY_DECISION_MAP[key] || 'stop';
}

export function isV2(data) {
  return !!data && typeof data === 'object' && data.schemaVersion === SCHEMA_VERSION
    && Array.isArray(data.tasks) && Array.isArray(data.sessions) && Array.isArray(data.decisions);
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = v => (typeof v === 'string' ? v : '');

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * v1 → v2。对 v2 输入原样返回（幂等）。
 * @param {object} input {items, history, updatedAt} 或 v2 state
 * @param {{now?:Function, idGen?:Function, keepLegacy?:boolean}} ctx
 */
export function migrate(input, ctx) {
  if (isV2(input)) return input;                       // 幂等：v2 原样返回
  const c = createContext(ctx);
  const at = c.now();
  const src = input || {};
  const v1Items = Array.isArray(src.items) ? src.items : [];
  const v1History = Array.isArray(src.history) ? src.history : [];

  const tasks = [];
  const sessions = [];
  const decisions = [];
  const byLegacyHistId = new Map();

  // ---- 旧 history：每条一个 Task，同名不合并 ----
  v1History.forEach((h, hIdx) => {
    if (!h || typeof h !== 'object') return;
    const legacyHistId = str(h.id) || null;
    const idBase = legacyHistId || `hist${hIdx}`;
    const doneAt = num(h.doneAt, at);
    const rawSessions = Array.isArray(h.sessions) ? h.sessions.filter(s => s && typeof s === 'object') : [];
    // 没有 sessions 数组时，这条 history 行本身就是一轮记录（v1 的等价语义），
    // 不按 rounds 数量凭空拆出多轮——源记录没保留的轮次不猜测重建。
    const rows = rawSessions.length
      ? rawSessions
      : [{ doneAt, duration: num(h.total, 0), decision: str(h.decision), note: str(h.note) }];

    const firstAt = num(rows[0] && rows[0].doneAt, doneAt);
    const task = createTask({
      taskId: `t_${idBase}`,
      name: str(h.name),
      hypothesis: str(h.hypothesis) || undefined,
      createdAt: firstAt,
      status: 'ended',
      origin: legacyHistId ? { legacyHistId } : undefined
    }, c);

    let lastKind = 'stop';
    rows.forEach((s, i) => {
      const sDoneAt = num(s.doneAt, doneAt);
      const duration = num(s.duration, 0);
      const kind = mapLegacyDecision(s.decision);
      lastKind = kind;
      const session = createSession({
        sessionId: `s_${idBase}_${i}`,
        taskId: task.taskId,
        entryMode: 'planned',
        // 旧 duration 来自计划时长，标 legacyPlanned，不能当成真实投入。
        plannedMs: duration > 0 ? duration : undefined,
        legacyPlanned: true,
        legacy: true,
        // startedAt 不存在就不补造；deadlineAt 只在最后一轮有旧 end 字段可依。
        deadlineAt: i === rows.length - 1 && Number.isFinite(h.end) ? h.end : undefined,
        endedAt: sDoneAt,
        endReason: 'unknown'
      }, c);
      sessions.push(session);
      decisions.push(createDecision({
        decisionId: `d_${idBase}_${i}`,
        taskId: task.taskId,
        sessionId: session.sessionId,
        entryMode: 'planned',
        at: sDoneAt,
        kind,
        // v1 没有记录续时时长，不编造 continueMs。
        note: str(s.note) || undefined
      }, c));
    });

    // 「继续／捞回」类 → 'later'（可接续）；其余 'ended'。绝不自动 'completed'。
    task.status = lastKind === 'continue' ? 'later' : 'ended';
    tasks.push(task);
    if (legacyHistId) byLegacyHistId.set(legacyHistId, task);
  });

  // ---- 旧 items（进行中）：active Task + 开启中的 Session ----
  v1Items.forEach((it, iIdx) => {
    if (!it || typeof it !== 'object') return;
    const originHistId = str(it.originHistId);
    // originHistId 是 v1 里唯一可靠的「接续原事项」线索；按 id 关联，不按名字合并。
    let task = originHistId ? byLegacyHistId.get(originHistId) || null : null;
    if (task) {
      task.status = 'active';
    } else {
      task = createTask({
        taskId: `t_item${iIdx}_${newId('', c)}`,
        name: str(it.name),
        hypothesis: str(it.hypothesis) || undefined,
        createdAt: at,
        status: 'active'
      }, c);
      tasks.push(task);
    }
    const total = num(it.total, 0);
    const session = createSession({
      sessionId: `s_item${iIdx}_${newId('', c)}`,
      taskId: task.taskId,
      entryMode: 'planned',
      plannedMs: total > 0 ? total : undefined,
      legacyPlanned: true,   // v1 的 total 是本轮计划时长
      legacy: true,          // 没有可信 startedAt，不补造
      deadlineAt: Number.isFinite(it.end) ? it.end : undefined
    }, c);
    sessions.push(session);
  });

  const state = {
    schemaVersion: SCHEMA_VERSION,
    tasks,
    sessions,
    decisions,
    updatedAt: num(src.updatedAt, at),
    rev: 0,
    sourceVersion: 1,
    // 原始快照原样保留，不重写旧名称、笔记与决定；可回退。
    legacy: {
      version: 1,
      capturedAt: at,
      items: deepClone(v1Items) || [],
      history: deepClone(v1History) || []
    }
  };
  return state;
}

/**
 * v2 → v1 投影，给旧客户端与导出用。
 *
 * 信息损失（无法在 v1 形态里表达，仅存在于 v2 与 legacy 快照中）：
 *  - Task.status 的 'later' / 'completed' / 'ended' 三态被压成 v1 的 decision 字符串；
 *  - entryMode（即时入口）、Decision.expectation、followUp、later/completed 标记丢失；
 *  - Session.startedAt、endReason（early / cancelled / unknown）、deadlineChanges、
 *    continuedFrom、userEstimatedPriorMs 丢失；
 *  - legacyPlanned 标记丢失，投影出的 duration 在 v1 里又会被当作「用时」显示；
 *  - 同名但不同 taskId 的事项在 v1 端仍是两条 history，但 v1 的 normalizeHistory() 会按名字合并。
 * 因此投影只用于兼容旧客户端读取与导出，不作为 v2 的回退数据源；回退请用 state.legacy。
 */
export function toV1Projection(state) {
  if (!isV2(state)) {
    // 已经是 v1 形态就原样给回。
    const src = state || {};
    return {
      items: Array.isArray(src.items) ? src.items : [],
      history: Array.isArray(src.history) ? src.history : [],
      updatedAt: num(src.updatedAt, 0)
    };
  }

  const sessionsByTask = new Map();
  for (const s of state.sessions) {
    if (!sessionsByTask.has(s.taskId)) sessionsByTask.set(s.taskId, []);
    sessionsByTask.get(s.taskId).push(s);
  }
  const decisionBySession = new Map();
  const decisionsByTask = new Map();
  for (const d of state.decisions) {
    if (d.sessionId) decisionBySession.set(d.sessionId, d);
    if (!decisionsByTask.has(d.taskId)) decisionsByTask.set(d.taskId, []);
    decisionsByTask.get(d.taskId).push(d);
  }

  const history = [];
  const items = [];

  for (const task of state.tasks) {
    const all = (sessionsByTask.get(task.taskId) || []).slice().sort((a, b) => sortKey(a) - sortKey(b));
    const closed = all.filter(s => Number.isFinite(s.endedAt) && s.endReason !== 'cancelled');
    const open = all.filter(s => !Number.isFinite(s.endedAt));

    if (closed.length) {
      const v1Sessions = closed.map(s => {
        const d = decisionBySession.get(s.sessionId) || null;
        const row = {
          doneAt: s.endedAt,
          duration: projectDuration(s)
        };
        if (d) {
          row.decision = V2_TO_V1_DECISION[d.kind] || 'completed';
          if (d.note) row.note = d.note;
        } else {
          row.decision = 'completed';
        }
        return row;
      });
      const last = v1Sessions[v1Sessions.length - 1];
      const lastSession = closed[closed.length - 1];
      const row = {
        id: (task.origin && task.origin.legacyHistId) || task.taskId,
        name: task.name,
        end: num(lastSession.deadlineAt, last.doneAt),
        total: v1Sessions.reduce((a, s) => a + (s.duration || 0), 0),
        rounds: v1Sessions.length,
        doneAt: last.doneAt,
        decision: last.decision,
        note: last.note || '',
        hypothesis: task.hypothesis || '',
        sessions: v1Sessions
      };
      history.push(row);
    }

    if (open.length && task.status === 'active') {
      const s = open[open.length - 1];
      const priorMs = closed.reduce((a, x) => a + projectDuration(x), 0);
      const item = {
        name: task.name,
        end: num(s.deadlineAt, num(s.startedAt, 0)),
        total: num(s.plannedMs, 0),
        prevTotal: priorMs,
        rounds: all.length,
        hypothesis: task.hypothesis || ''
      };
      const histId = (task.origin && task.origin.legacyHistId) || (closed.length ? task.taskId : '');
      if (histId) item.originHistId = histId;
      items.push(item);
    }
  }

  history.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  return { items, history, updatedAt: num(state.updatedAt, 0), schemaVersion: 1 };
}

function sortKey(s) {
  return num(s.startedAt, num(s.endedAt, num(s.deadlineAt, 0)));
}

// 投影给 v1 的 duration：优先实测经过时间；没有真实 startedAt 的旧轮次沿用旧的计划时长。
function projectDuration(s) {
  if (Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt)) return Math.max(0, s.endedAt - s.startedAt);
  return num(s.plannedMs, 0);
}

