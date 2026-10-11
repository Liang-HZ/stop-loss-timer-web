import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startPlanned, enterImmediate, changeDeadline, openReassessment,
  decide, cancelSession, resumeLater, followUp, computeEndReason,
  saveOnDeck, dismissOnDeck, completeOnDeck, FlowError
} from '../flow.js';
import { createState, validateState, findTask, findSession, sessionElapsedMs, ValidationError } from '../model.js';
import { makeCtx, MIN } from './helpers.js';

const fresh = ctx => createState({}, ctx);
const ok = s => assert.equal(validateState(s).errors.join('; '), '');

test('事前设点：建 Task + 计时 Session，state 不被就地修改', () => {
  const ctx = makeCtx();
  const s0 = fresh(ctx);
  const r = startPlanned(s0, { name: '比价', plannedMs: 30 * MIN, hypothesis: '差价不到 20 元就买' }, ctx);
  assert.equal(s0.tasks.length, 0, '原 state 必须不被修改');
  assert.equal(r.task.status, 'active');
  assert.equal(r.session.entryMode, 'planned');
  assert.equal(r.session.plannedMs, 30 * MIN);
  assert.equal(r.session.deadlineAt, ctx.at + 30 * MIN);
  assert.equal(r.session.startedAt, ctx.at);
  assert.equal(r.session.legacyPlanned, undefined);
  assert.equal(r.state.rev, 1);
  ok(r.state);
});

test('事前设点支持指定结束时刻', () => {
  const ctx = makeCtx();
  const at = ctx.at;
  const r = startPlanned(fresh(ctx), { name: 'x', deadlineAt: at + 45 * MIN }, ctx);
  assert.equal(r.session.deadlineAt, at + 45 * MIN);
  assert.equal(r.session.plannedMs, 45 * MIN);
});

test('【验收】两个同名事项互不合并', () => {
  const ctx = makeCtx();
  const a = startPlanned(fresh(ctx), { name: '修水龙头', plannedMs: 30 * MIN }, ctx);
  ctx.advance(MIN);
  const b = startPlanned(a.state, { name: '修水龙头', plannedMs: 30 * MIN }, ctx);
  assert.notEqual(a.task.taskId, b.task.taskId);
  assert.equal(b.state.tasks.length, 2);
  assert.equal(b.state.tasks.filter(t => t.name === '修水龙头').length, 2);
});

test('【验收】即时入口不虚报计时时长：不建 Session，决定的 sessionId 为空', () => {
  const ctx = makeCtx();
  const r = enterImmediate(fresh(ctx), {}, ctx);
  assert.equal(r.session, null);
  assert.equal(r.state.sessions.length, 0, '即时入口不得凭空生成计时轮次');
  assert.equal(r.task.name, '');
  ctx.advance(5 * MIN);
  const d = decide(r.state, { taskId: r.task.taskId, kind: 'stop' }, ctx);
  assert.equal(d.decision.sessionId, null);
  assert.equal(d.decision.entryMode, 'immediate');
  assert.equal(d.state.sessions.length, 0);
  ok(d.state);
});

test('即时入口选「从现在设一个短提醒」才建 Session', () => {
  const ctx = makeCtx();
  const r = enterImmediate(fresh(ctx), { name: '这次纠结', withShortReminderMs: 10 * MIN }, ctx);
  assert.equal(r.session.entryMode, 'immediate');
  assert.equal(r.session.plannedMs, 10 * MIN);
  assert.equal(r.session.startedAt, ctx.at, '短提醒是真实开始的，可以有 startedAt');
});

test('即时入口可单独保存用户自述的此前投入，且不进 elapsed', () => {
  const ctx = makeCtx();
  const r = enterImmediate(fresh(ctx), { withShortReminderMs: 10 * MIN, userEstimatedPriorMs: 90 * MIN }, ctx);
  assert.deepEqual(r.session.userEstimatedPriorMs, { value: 90 * MIN, source: 'user_estimate' });
  ctx.advance(10 * MIN);
  const d = decide(r.state, { sessionId: r.session.sessionId, kind: 'stop' }, ctx);
  assert.equal(sessionElapsedMs(findSession(d.state, r.session.sessionId)), 10 * MIN, '实测只算真实计时，不含用户估计值');
});

test('改截止时刻留痕，且已结束的轮不能改', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: 'x', plannedMs: 30 * MIN }, ctx);
  ctx.advance(5 * MIN);
  const c = changeDeadline(r.state, { sessionId: r.session.sessionId, deadlineAt: ctx.at + 40 * MIN }, ctx);
  assert.equal(c.session.deadlineChanges.length, 1);
  assert.deepEqual(c.session.deadlineChanges[0], { at: ctx.at, deadlineAt: ctx.at + 40 * MIN });
  const same = changeDeadline(c.state, { sessionId: r.session.sessionId, deadlineAt: ctx.at + 40 * MIN }, ctx);
  assert.equal(same.changed, false);
  assert.equal(same.state, c.state, '没有变化就不produce新 rev');
  const stopped = decide(c.state, { sessionId: r.session.sessionId, kind: 'stop' }, ctx);
  assert.throws(() => changeDeadline(stopped.state, { sessionId: r.session.sessionId, deadlineAt: ctx.at + MIN }, ctx),
    e => e.code === 'session_closed');
});

test('openReassessment 不改数据，只发一个 decisionId', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: 'x', plannedMs: 30 * MIN }, ctx);
  ctx.advance(30 * MIN);
  const o = openReassessment(r.state, { taskId: r.task.taskId }, ctx);
  assert.equal(o.state, r.state, '打开重评不得自动结束或归档');
  assert.equal(o.draft.overdue, true);
  assert.equal(o.draft.sessionId, r.session.sessionId);
});

test('【验收】「就到这里」默认结束，不自动进入待继续', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: '比价', plannedMs: 30 * MIN }, ctx);
  ctx.advance(30 * MIN);
  const d = decide(r.state, { taskId: r.task.taskId, kind: 'stop' }, ctx);
  assert.equal(d.task.status, 'ended');
  assert.notEqual(d.task.status, 'later');
  assert.notEqual(d.task.status, 'completed');
  assert.equal(findSession(d.state, r.session.sessionId).endedAt, ctx.at);
  assert.throws(() => resumeLater(d.state, { taskId: r.task.taskId, plannedMs: 15 * MIN }, ctx), e => e.code === 'not_later');
});

test('只有勾「以后再看」才 later，勾「事项已完成」才 completed', () => {
  const ctx = makeCtx();
  const base = startPlanned(fresh(ctx), { name: 'x', plannedMs: 30 * MIN }, ctx);
  const later = decide(base.state, { taskId: base.task.taskId, kind: 'stop', later: true }, ctx);
  assert.equal(later.task.status, 'later');
  const done = decide(base.state, { taskId: base.task.taskId, kind: 'stop', completed: true }, ctx);
  assert.equal(done.task.status, 'completed');
  assert.throws(() => decide(base.state, { taskId: base.task.taskId, kind: 'stop', later: true, completed: true }, ctx),
    e => e instanceof ValidationError);
});

test('【验收】「换个办法」不必新开计时', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: '排查报错', plannedMs: 30 * MIN }, ctx);
  ctx.advance(30 * MIN);
  const d = decide(r.state, { taskId: r.task.taskId, kind: 'switch', note: '去问同事' }, ctx);
  assert.equal(d.session, null, '换个办法不得自动新建轮次');
  assert.equal(d.state.sessions.length, 1);
  assert.equal(d.task.status, 'ended');
  assert.equal(d.decision.note, '去问同事');
  ok(d.state);
});

test('【验收】同一事项连续三轮均保留，继续关旧轮开新轮', () => {
  const ctx = makeCtx();
  let s = startPlanned(fresh(ctx), { name: '调参数', plannedMs: 30 * MIN }, ctx);
  const state1 = s.state;
  ctx.advance(30 * MIN);
  const c1 = decide(state1, { taskId: s.task.taskId, kind: 'continue', continueMs: 15 * MIN, expectation: '跑通一个用例' }, ctx);
  ctx.advance(15 * MIN);
  const c2 = decide(c1.state, { taskId: s.task.taskId, kind: 'continue', continueMs: 15 * MIN }, ctx);
  ctx.advance(15 * MIN);
  const end = decide(c2.state, { taskId: s.task.taskId, kind: 'stop' }, ctx);

  const sessions = end.state.sessions.filter(x => x.taskId === s.task.taskId);
  assert.equal(sessions.length, 3, '三轮都要留下');
  assert.equal(sessions[1].continuedFrom, sessions[0].sessionId);
  assert.equal(sessions[2].continuedFrom, sessions[1].sessionId);
  assert.equal(sessions.filter(x => x.endedAt !== undefined).length, 3);
  assert.deepEqual(sessions.map(x => sessionElapsedMs(x)), [30 * MIN, 15 * MIN, 15 * MIN]);
  assert.equal(end.state.decisions.filter(d => d.taskId === s.task.taskId).length, 3);
  assert.equal(c1.state.tasks[0].status, 'active', '继续时事项保持 active');
  assert.equal(end.task.status, 'ended');
  ok(end.state);
});

test('continue 必须给 continueMs', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: 'x', plannedMs: 30 * MIN }, ctx);
  assert.throws(() => decide(r.state, { taskId: r.task.taskId, kind: 'continue' }, ctx), e => e.code === 'invalid_input');
});

test('【验收】提前结束与超时确认可区分', () => {
  const ctx = makeCtx();
  const a = startPlanned(fresh(ctx), { name: '早收', plannedMs: 30 * MIN }, ctx);
  ctx.advance(10 * MIN);
  const early = decide(a.state, { taskId: a.task.taskId, kind: 'stop' }, ctx);
  assert.equal(findSession(early.state, a.session.sessionId).endReason, 'early');

  const ctx2 = makeCtx();
  const b = startPlanned(fresh(ctx2), { name: '超时', plannedMs: 30 * MIN }, ctx2);
  ctx2.advance(42 * MIN);
  const late = decide(b.state, { taskId: b.task.taskId, kind: 'stop' }, ctx2);
  const ls = findSession(late.state, b.session.sessionId);
  assert.equal(ls.endReason, 'decision');
  assert.equal(sessionElapsedMs(ls), 42 * MIN, '超时待响应如实记录，不截到计划时长');
  assert.equal(ls.plannedMs, 30 * MIN, '计划时长与实测分开保存');
  assert.equal(computeEndReason({ deadlineAt: 100 }, 99), 'early');
  assert.equal(computeEndReason({ deadlineAt: 100 }, 100), 'decision');
  assert.equal(computeEndReason({}, 100), 'decision');
});

test('【验收】重复提交同一 decisionId 不重复归档', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: 'x', plannedMs: 30 * MIN }, ctx);
  ctx.advance(30 * MIN);
  const first = decide(r.state, { decisionId: 'D1', taskId: r.task.taskId, kind: 'stop', note: '够了' }, ctx);
  const again = decide(first.state, { decisionId: 'D1', taskId: r.task.taskId, kind: 'stop', note: '够了' }, ctx);
  assert.equal(again.idempotent, true);
  assert.equal(again.state, first.state, '重复提交不得产生新版本');
  assert.equal(again.state.decisions.length, 1);
  // 连续按三次（含续时）同样只落一条
  const c = decide(first.state, { decisionId: 'D2', taskId: r.task.taskId, kind: 'continue', continueMs: 15 * MIN }, ctx);
  const c2 = decide(c.state, { decisionId: 'D2', taskId: r.task.taskId, kind: 'continue', continueMs: 15 * MIN }, ctx);
  assert.equal(c2.state.sessions.length, c.state.sessions.length, '重复的续时不得重复开轮');
});

test('【验收】所有继续入口同一语义（到点／提前／列表／全屏／画中画）', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: 'x', plannedMs: 30 * MIN }, ctx);
  // 四个入口分别用 taskId / sessionId / openReassessment 的 draft 触发，结果必须一致
  const viaTask = decide(r.state, { decisionId: 'X', taskId: r.task.taskId, kind: 'continue', continueMs: 15 * MIN }, ctx);
  const viaSession = decide(r.state, { decisionId: 'X', sessionId: r.session.sessionId, kind: 'continue', continueMs: 15 * MIN }, ctx);
  const draft = openReassessment(r.state, { taskId: r.task.taskId, decisionId: 'X' }, ctx).draft;
  const viaDraft = decide(r.state, { ...draft, kind: 'continue', continueMs: 15 * MIN }, ctx);
  const strip = res => ({
    decision: res.decision,
    sessions: res.state.sessions.map(s => ({ ...s, sessionId: s.sessionId === res.session.sessionId ? 'NEW' : s.sessionId })),
    task: res.task
  });
  assert.deepEqual(strip(viaSession), strip(viaTask));
  assert.deepEqual(strip(viaDraft), strip(viaTask));
});

test('取消误建的轮次保留 cancelled 状态，且不动事项', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: '点错了', plannedMs: 30 * MIN }, ctx);
  ctx.advance(MIN);
  const c = cancelSession(r.state, { sessionId: r.session.sessionId }, ctx);
  assert.equal(c.session.endReason, 'cancelled');
  assert.equal(findTask(c.state, r.task.taskId).status, 'active', '取消轮次不自动取消任务');
  const again = cancelSession(c.state, { sessionId: r.session.sessionId }, ctx);
  assert.equal(again.idempotent, true);
  assert.equal(again.state, c.state);
});

test('resumeLater 从「以后再看」接续新轮并关联上一轮', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: '写年度总结', plannedMs: 30 * MIN }, ctx);
  ctx.advance(30 * MIN);
  const stopped = decide(r.state, { taskId: r.task.taskId, kind: 'stop', later: true }, ctx);
  ctx.advance(86400000);
  const resumed = resumeLater(stopped.state, { taskId: r.task.taskId, plannedMs: 25 * MIN }, ctx);
  assert.equal(resumed.task.status, 'active');
  assert.equal(resumed.session.continuedFrom, r.session.sessionId);
  assert.equal(resumed.session.startedAt, ctx.at);
  assert.equal(resumed.state.tasks.length, 1, '接续不得复制出新事项');
  ok(resumed.state);
});

test('followUp 记录 24–72 小时后的自评', () => {
  const ctx = makeCtx();
  const r = startPlanned(fresh(ctx), { name: 'x', plannedMs: 30 * MIN }, ctx);
  ctx.advance(30 * MIN);
  const d = decide(r.state, { decisionId: 'D', taskId: r.task.taskId, kind: 'stop' }, ctx);
  ctx.advance(2 * 86400000);
  const f = followUp(d.state, { decisionId: 'D', stillAgree: true, feeling: '当时停掉是对的' }, ctx);
  assert.equal(f.decision.followUp.stillAgree, true);
  assert.equal(f.decision.followUp.at, ctx.at);
  assert.throws(() => followUp(f.state, { decisionId: 'nope' }, ctx), e => e.code === 'not_found');
});

test('decide 对未知目标与非法 kind 明确报错', () => {
  const ctx = makeCtx();
  const s = fresh(ctx);
  assert.throws(() => decide(s, { taskId: 'nope', kind: 'stop' }, ctx), e => e.code === 'not_found');
  assert.throws(() => decide(s, { kind: 'stop' }, ctx), e => e.code === 'invalid_input');
  assert.throws(() => decide(s, { taskId: 'x', kind: 'quit' }, ctx), e => e instanceof FlowError);
});

test('schemaVersion 不对时拒绝操作，不静默改写', () => {
  const ctx = makeCtx();
  assert.throws(() => startPlanned({ schemaVersion: 1, tasks: [], sessions: [], decisions: [] }, { name: 'x', plannedMs: MIN }, ctx),
    e => e.code === 'schema_mismatch');
});

test('待启念头管理 (On Deck)：存入、启动、收场、完成', () => {
  const ctx = makeCtx();
  const s0 = fresh(ctx);

  // 1. 存入待启
  const saved = saveOnDeck(s0, { name: '调研海外竞品定价', hypothesis: '明日' }, ctx);
  assert.equal(saved.task.status, 'later');
  assert.equal(saved.task.name, '调研海外竞品定价');
  assert.equal(saved.state.sessions.length, 0, '待启念头不产生即时 Session');
  ok(saved.state);

  // 2. 从待启中启动 15 分钟
  const launched = resumeLater(saved.state, { taskId: saved.task.taskId, plannedMs: 15 * MIN }, ctx);
  assert.equal(launched.task.status, 'active');
  assert.equal(launched.session.plannedMs, 15 * MIN);
  assert.equal(launched.state.sessions.length, 1);
  ok(launched.state);

  // 3. 待启收场 (dismiss)
  const another = saveOnDeck(s0, { name: '打扫阁楼' }, ctx);
  const dismissed = dismissOnDeck(another.state, another.task.taskId, ctx);
  assert.equal(dismissed.task.status, 'ended');
  ok(dismissed.state);

  // 4. 待启直接完成 (complete)
  const third = saveOnDeck(s0, { name: '顺手给猫喂食' }, ctx);
  const done = completeOnDeck(third.state, third.task.taskId, ctx);
  assert.equal(done.task.status, 'completed');
  ok(done.state);
});

