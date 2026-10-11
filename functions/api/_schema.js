// 止损计时 — 数据契约 v2 的服务端校验与 v1 投影
// 数据契约 v2 的服务端校验；packages/core 是客户端侧实现，
// 这里是服务端的独立副本：服务端不信任客户端，字段白名单、枚举、长度、容量都在这里再判一次。
// 文件名以 `_` 开头，不会被 Pages 注册成路由。

export const LIMITS = { tasks: 500, sessions: 3000, decisions: 3000, templates: 100 };

// legacy 快照原样保留（不重写旧名称/笔记/决定），只压一个体积上限，
// 防止有人把 1 MiB 正文全塞进 legacy 绕过 tasks/sessions/decisions 的容量校验。
export const LEGACY_MAX_BYTES = 512 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_STATUS = new Set(['active', 'ended', 'completed', 'later']);
const ENTRY_MODE = new Set(['planned', 'immediate']);
const DECISION_KIND = new Set(['stop', 'switch', 'continue']);
const END_REASON = new Set(['decision', 'early', 'cancelled', 'unknown']);
// 个人重评规则（Pro）的场景标签；与 packages/core/model.js 的 SCENES 一一对应。
const SCENE = new Set(['compare', 'stuck', 'detail', 'argue', 'debug', 'other']);
const TEMPLATE_DURATIONS_MAX = 6;

const isId = v => typeof v === 'string' && ID_RE.test(v);
const num = v => (Number.isFinite(v) ? v : undefined);
const text = (v, n) => (typeof v === 'string' && v.trim() ? v.slice(0, n).trim() : undefined);
const arr = v => (Array.isArray(v) ? v : []);

// 每个 clean* 返回 null 表示这条记录不合法，整条丢弃（不静默改成别的值）。
function cleanTask(t) {
  if (!t || !isId(t.taskId) || typeof t.name !== 'string') return null;
  const r = { taskId: t.taskId, name: t.name.slice(0, 100), createdAt: num(t.createdAt) ?? 0, status: TASK_STATUS.has(t.status) ? t.status : 'active' };
  const h = text(t.hypothesis, 200); if (h) r.hypothesis = h;
  // scene / templateId：高级复盘按 scene 分组，templateId 只是「这一轮从哪个模板开的」的线索。
  // 两者都可缺省——服务端不替用户归类，也不因为缺了它们丢掉整条记录。
  if (SCENE.has(t.scene)) r.scene = t.scene;
  if (isId(t.templateId)) r.templateId = t.templateId;
  // updatedAt 是 packages/core 合并两端状态时的取新依据（sync.js MERGE_SPEC），丢了它多端合并就会退化成随机胜出。
  const up = num(t.updatedAt); if (up != null) r.updatedAt = up;
  if (t.origin && typeof t.origin === 'object' && typeof t.origin.legacyHistId === 'string') {
    r.origin = { legacyHistId: t.origin.legacyHistId.slice(0, 60) };
  }
  return r;
}

function cleanSession(s) {
  if (!s || !isId(s.sessionId) || !isId(s.taskId)) return null;
  if (!ENTRY_MODE.has(s.entryMode)) return null;
  const r = { sessionId: s.sessionId, taskId: s.taskId, entryMode: s.entryMode };
  const started = num(s.startedAt); if (started != null) r.startedAt = started; // 缺失时不补造，见 PLAN 迁移规则
  const planned = num(s.plannedMs); if (planned != null) r.plannedMs = Math.max(0, planned);
  const dl = num(s.deadlineAt); if (dl != null) r.deadlineAt = dl;
  const ended = num(s.endedAt); if (ended != null) r.endedAt = ended;
  if (END_REASON.has(s.endReason)) r.endReason = s.endReason;
  if (isId(s.continuedFrom)) r.continuedFrom = s.continuedFrom;
  if (s.legacyPlanned === true) r.legacyPlanned = true; // 旧版「计划用时」冒充真实投入的防线
  // legacy=true 标记这条轮次来自 v1 迁移；packages/core 的 validateSession 靠它豁免「必须有 startedAt」。
  // 服务端丢了这个标记，数据转一圈回到客户端就会校验失败——所以它必须在白名单里。
  if (s.legacy === true) r.legacy = true;
  const changes = arr(s.deadlineChanges).slice(0, 50)
    .map(c => (c && Number.isFinite(c.at) && Number.isFinite(c.deadlineAt) ? { at: c.at, deadlineAt: c.deadlineAt } : null))
    .filter(Boolean);
  if (changes.length) r.deadlineChanges = changes;
  const est = s.userEstimatedPriorMs;
  if (est && typeof est === 'object' && Number.isFinite(est.value)) {
    r.userEstimatedPriorMs = { value: Math.max(0, est.value), source: 'user_estimate' }; // source 固定，不接受客户端自定义
  }
  return r;
}

function cleanDecision(d) {
  if (!d || !isId(d.decisionId) || !isId(d.taskId)) return null;
  if (!ENTRY_MODE.has(d.entryMode) || !DECISION_KIND.has(d.kind)) return null;
  const at = num(d.at); if (at == null) return null;
  const r = { decisionId: d.decisionId, taskId: d.taskId, sessionId: isId(d.sessionId) ? d.sessionId : null, entryMode: d.entryMode, at, kind: d.kind };
  const cm = num(d.continueMs); if (cm != null) r.continueMs = Math.max(0, cm);
  const note = text(d.note, 200); if (note) r.note = note;
  // later / completed 决定 Task 落到 'later' 还是 'completed'（PLAN 状态流），只对 kind='stop' 有意义，
  // 且互斥——两个同时为真是客户端 bug，服务端按「都不设」处理，不替用户猜他想要哪个。
  if (r.kind === 'stop' && d.later === true && d.completed !== true) r.later = true;
  if (r.kind === 'stop' && d.completed === true && d.later !== true) r.completed = true;
  const exp = text(d.expectation, 200); if (exp) r.expectation = exp;
  // 即时决定（sessionId 为 null）时用户自述的此前投入只能挂在这里。source 固定，不接受客户端自定义。
  const dEst = d.userEstimatedPriorMs;
  if (dEst && typeof dEst === 'object' && Number.isFinite(dEst.value)) {
    r.userEstimatedPriorMs = { value: Math.max(0, dEst.value), source: 'user_estimate' };
  }
  if (d.followUp && typeof d.followUp === 'object' && Number.isFinite(d.followUp.at)) {
    const f = { at: d.followUp.at };
    if (typeof d.followUp.stillAgree === 'boolean') f.stillAgree = d.followUp.stillAgree;
    const feel = text(d.followUp.feeling, 200); if (feel) f.feeling = feel;
    r.followUp = f;
  }
  return r;
}

// 个人重评规则：纯输入预设，不参与任何语义判定。同样按白名单清洗，不存内置例子（builtIn 一律丢弃，
// 那是客户端按语言现生成的只读展示项，存进来只会占容量、还要跨端同步）。
function cleanTemplate(tpl) {
  if (!tpl || !isId(tpl.templateId) || typeof tpl.name !== 'string' || !tpl.name.trim()) return null;
  if (tpl.builtIn === true) return null;
  const r = { templateId: tpl.templateId, name: tpl.name.slice(0, 100).trim(), createdAt: num(tpl.createdAt) ?? 0 };
  const up = num(tpl.updatedAt); if (up != null) r.updatedAt = up;
  const h = text(tpl.hypothesis, 200); if (h) r.hypothesis = h;
  const rt = text(tpl.reminderText, 200); if (rt) r.reminderText = rt;
  if (SCENE.has(tpl.scene)) r.scene = tpl.scene;
  const ds = arr(tpl.durationsMs).filter(v => Number.isFinite(v) && v > 0).map(v => Math.round(v));
  const uniq = [...new Set(ds)].sort((a, b) => a - b).slice(0, TEMPLATE_DURATIONS_MAX);
  if (uniq.length) r.durationsMs = uniq;
  return r;
}

// 同 id 只保留第一条（客户端生成 id，重复提交/重复同步不应产生两条）
function dedupe(list, idKey) {
  const seen = new Set(), out = [];
  for (const x of list) {
    if (seen.has(x[idKey])) continue;
    seen.add(x[idKey]);
    out.push(x);
  }
  return out;
}

// 返回 { ok:true, value } 或 { ok:false, status, body }
export function sanitizeV2(body) {
  const tasks = dedupe(arr(body.tasks).map(cleanTask).filter(Boolean), 'taskId');
  const sessions = dedupe(arr(body.sessions).map(cleanSession).filter(Boolean), 'sessionId');
  const decisions = dedupe(arr(body.decisions).map(cleanDecision).filter(Boolean), 'decisionId');
  const templates = dedupe(arr(body.templates).map(cleanTemplate).filter(Boolean), 'templateId');

  // 超限直接拒绝，不截断：静默丢数据是最恶劣的失败模式。
  if (tasks.length > LIMITS.tasks || sessions.length > LIMITS.sessions || decisions.length > LIMITS.decisions || templates.length > LIMITS.templates) {
    return {
      ok: false, status: 413,
      body: { error: 'capacity_full', limits: LIMITS, counts: { tasks: tasks.length, sessions: sessions.length, decisions: decisions.length, templates: templates.length } }
    };
  }

  const value = { schemaVersion: 2, tasks, sessions, decisions };
  // templates 可选：没有模板就不写这个键，内容指纹保持与老数据一致，不平白产生一次 KV 写。
  if (templates.length) value.templates = templates;
  // sourceVersion：这份数据是从哪个旧版本迁来的（packages/core/migrate.js 写 1）。可回退路径要靠它。
  if (Number.isFinite(body.sourceVersion)) value.sourceVersion = body.sourceVersion;
  if (body.legacy && typeof body.legacy === 'object') {
    const s = JSON.stringify(body.legacy);
    if (s.length > LEGACY_MAX_BYTES) return { ok: false, status: 413, body: { error: 'legacy_too_large', limit: LEGACY_MAX_BYTES } };
    value.legacy = body.legacy;
  }
  return { ok: true, value };
}

// ---- 内容指纹：省 KV 写配额 ------------------------------------------------
// 免费档 KV 只有 1000 次写/天，整包 PUT 下约 200 个活跃同步用户就打满。
// 所以「内容没变就不写」是硬需求，不是优化。
//
// 规范化 = 递归按 key 排序后 JSON.stringify。clean* 本来就按固定顺序产字段，排序主要是为了
// `legacy` 这种原样透传的子树：客户端换个 key 顺序不该被算成内容变化、白花一次写配额。
// **刻意不纳入指纹的字段**：rev（是结果不是内容）、updatedAt（每次保存都变，纳入就永远短路不了）、
// hash（自身）。代价是内容没变时云端 updatedAt 不刷新——这正是我们要的：没变的东西不该产生写。
// rev/updatedAt/hash 只在**顶层**剔除。子层不能跟着剔：task.updatedAt 是内容的一部分
// （packages/core 靠它合并判新），改了它就是真的改了数据，必须让指纹变、必须写。
export function canonicalJson(state) {
  const top = {};
  for (const k of Object.keys(state).sort()) {
    if (k === 'rev' || k === 'updatedAt' || k === 'hash') continue;
    top[k] = sortDeep(state[k]);
  }
  return JSON.stringify(top);
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

// ---- v1 ↔ v2 --------------------------------------------------------------

// v1 结构：{ updatedAt, items:[{name,end,total,...}], history:[{name,end,total,doneAt,rounds,...}] }
export function sanitizeV1(b) {
  const items = arr(b.items).slice(0, 50)
    .filter(it => it && typeof it.name === 'string' && Number.isFinite(it.end) && Number.isFinite(it.total))
    .map(it => {
      const res = { name: it.name.slice(0, 100), end: it.end, total: it.total };
      if (Number.isFinite(it.prevTotal)) res.prevTotal = it.prevTotal;
      if (Number.isFinite(it.rounds)) res.rounds = it.rounds;
      if (typeof it.originHistId === 'string') res.originHistId = it.originHistId.slice(0, 60);
      if (typeof it.hypothesis === 'string' && it.hypothesis.trim()) res.hypothesis = it.hypothesis.slice(0, 200).trim();
      return res;
    });
  const history = arr(b.history).slice(0, 200)
    .filter(h => h && typeof h.name === 'string' && Number.isFinite(h.end) && Number.isFinite(h.total) && Number.isFinite(h.doneAt))
    .map(h => {
      const res = { name: h.name.slice(0, 100), end: h.end, total: h.total, doneAt: h.doneAt, rounds: Number.isFinite(h.rounds) ? h.rounds : 1 };
      if (typeof h.id === 'string') res.id = h.id.slice(0, 60);
      if (typeof h.note === 'string' && h.note.trim()) res.note = h.note.slice(0, 200).trim();
      if (typeof h.decision === 'string') res.decision = h.decision.slice(0, 30);
      if (typeof h.hypothesis === 'string' && h.hypothesis.trim()) res.hypothesis = h.hypothesis.slice(0, 200).trim();
      if (Array.isArray(h.sessions)) {
        res.sessions = h.sessions.slice(0, 50)
          .filter(s => s && Number.isFinite(s.doneAt) && Number.isFinite(s.duration))
          .map(s => {
            const sRes = { doneAt: s.doneAt, duration: s.duration };
            if (typeof s.decision === 'string') sRes.decision = s.decision.slice(0, 30);
            if (typeof s.note === 'string' && s.note.trim()) sRes.note = s.note.slice(0, 200).trim();
            return sRes;
          });
      }
      return res;
    });
  return { items, history, updatedAt: Number(b.updatedAt) || Date.now() };
}

// v2 → v1 的保守投影：只给旧客户端看得懂的字段，缺的就不造。
// 「保守」= 没有真实开始时刻就不推算 total；投影只读不写，旧客户端拿它 PUT 回来会被 409 client_outdated 挡住。
export function projectV1(v2) {
  const tasks = arr(v2.tasks);
  const sessions = arr(v2.sessions);
  const decisions = arr(v2.decisions);
  const byTask = new Map(tasks.map(t => [t.taskId, t]));
  const roundsOf = new Map();
  for (const s of sessions) roundsOf.set(s.taskId, (roundsOf.get(s.taskId) || 0) + 1);

  const items = [];
  for (const s of sessions) {
    if (s.endedAt != null) continue;                 // 只有未结束的轮次才是 v1 的「进行中事项」
    const t = byTask.get(s.taskId);
    if (!t || t.status !== 'active') continue;
    const end = s.deadlineAt;
    if (!Number.isFinite(end)) continue;             // v1 的 end 是硬字段，没有就不投影这条
    const total = Number.isFinite(s.plannedMs) ? s.plannedMs : Math.max(0, end - (s.startedAt ?? end));
    const it = { name: t.name, end, total, rounds: roundsOf.get(s.taskId) || 1 };
    if (t.hypothesis) it.hypothesis = t.hypothesis;
    if (t.origin && t.origin.legacyHistId) it.originHistId = t.origin.legacyHistId;
    items.push(it);
  }

  const decByTask = new Map();
  for (const d of decisions) {
    if (!decByTask.has(d.taskId)) decByTask.set(d.taskId, []);
    decByTask.get(d.taskId).push(d);
  }
  const history = [];
  for (const t of tasks) {
    if (t.status === 'active') continue;             // 未结束的事项不进归档
    const ts = sessions.filter(s => s.taskId === t.taskId);
    const ds = (decByTask.get(t.taskId) || []).slice().sort((a, b) => a.at - b.at);
    const last = ts.length ? ts[ts.length - 1] : null;
    const lastDec = ds.length ? ds[ds.length - 1] : null;
    const doneAt = (last && last.endedAt) ?? (lastDec && lastDec.at) ?? t.createdAt;
    if (!Number.isFinite(doneAt)) continue;
    const end = (last && Number.isFinite(last.deadlineAt)) ? last.deadlineAt : doneAt;
    const total = last && Number.isFinite(last.plannedMs) ? last.plannedMs : 0;
    const h = { name: t.name, end, total, doneAt, rounds: ts.length || 1, id: t.taskId };
    if (t.hypothesis) h.hypothesis = t.hypothesis;
    if (lastDec) {
      h.decision = lastDec.kind;                     // 旧字段是自由文本，这里直接给枚举值，不硬编回中文旧文案
      if (lastDec.note) h.note = lastDec.note;
    }
    const rows = ts
      .filter(s => Number.isFinite(s.endedAt))
      .map(s => {
        const dur = Number.isFinite(s.startedAt) ? Math.max(0, s.endedAt - s.startedAt) : (Number.isFinite(s.plannedMs) ? s.plannedMs : 0);
        const row = { doneAt: s.endedAt, duration: dur };
        const d = ds.find(x => x.sessionId === s.sessionId);
        if (d) {
          row.decision = d.kind;
          if (d.note) row.note = d.note;
        }
        return row;
      })
      .slice(0, 50);
    if (rows.length) h.sessions = rows;
    history.push(h);
  }
  history.sort((a, b) => b.doneAt - a.doneAt);

  return { updatedAt: v2.updatedAt || 0, items: items.slice(0, 50), history: history.slice(0, 200) };
}

// v1 存量 → 给 v2 客户端的初始形态：集合留空，原始 v1 整包塞进 legacy，由客户端（packages/core）做迁移后
// 带 If-Match: 0 写回。服务端不做迁移，避免两套迁移逻辑各写一版、结果对不上。
export function v1AsV2Seed(v1) {
  return {
    schemaVersion: 2, rev: 0, tasks: [], sessions: [], decisions: [],
    legacy: { version: 1, capturedAt: Date.now(), items: arr(v1.items), history: arr(v1.history) },
    updatedAt: Number(v1.updatedAt) || 0
  };
}
