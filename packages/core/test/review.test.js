import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listDecisions, groupByDay, groupByTask, taskTotals, todayReview,
  todayReviewMarkdown, decisionView, localDayBounds, dayKeyOf, formatDuration
} from '../review.js';
import { createState } from '../model.js';
import { startPlanned, enterImmediate, decide, followUp, cancelSession } from '../flow.js';
import { migrate } from '../migrate.js';
import { makeCtx, MIN } from './helpers.js';

const DAY = 86400000;

function scenario() {
  // 固定 UTC 基准 + 显式时区偏移，避免跟着运行机器的本地时区漂。
  const ctx = makeCtx(Date.UTC(2026, 8, 13, 1, 0, 0));
  let s = createState({}, ctx);
  const a = startPlanned(s, { name: '比价', plannedMs: 30 * MIN, hypothesis: '差价不到 20 元就买' }, ctx);
  ctx.advance(30 * MIN);
  const c = decide(a.state, { decisionId: 'D1', taskId: a.task.taskId, kind: 'continue', continueMs: 15 * MIN, expectation: '再看两家' }, ctx);
  ctx.advance(15 * MIN);
  const stop = decide(c.state, { decisionId: 'D2', taskId: a.task.taskId, kind: 'stop', note: '够了，就买这个' }, ctx);
  const imm = enterImmediate(stop.state, { name: '争论' }, ctx);
  ctx.advance(5 * MIN);
  const sw = decide(imm.state, { decisionId: 'D3', taskId: imm.task.taskId, kind: 'switch', note: '各自去查资料' }, ctx);
  return { ctx, state: sw.state, taskA: a.task, taskB: imm.task };
}

test('decisionView 把实测用时与计划时长分开，legacy 可辨认', () => {
  const ctx = makeCtx();
  const s = migrate({ history: [{ id: 'h1', name: '旧事', doneAt: 1_698_000_000_000, total: 40 * MIN, decision: 'completed' }] }, ctx);
  const view = listDecisions(s)[0];
  assert.equal(view.elapsedMs, null, '旧记录没有实测用时');
  assert.equal(view.plannedMs, 40 * MIN);
  assert.equal(view.legacyPlanned, true);
  assert.equal(view.endReason, 'unknown');
});

test('listDecisions 按时间排序并可按事项、区间过滤', () => {
  const { state, taskA } = scenario();
  const all = listDecisions(state);
  assert.deepEqual(all.map(d => d.decisionId), ['D1', 'D2', 'D3']);
  assert.deepEqual(listDecisions(state, { taskId: taskA.taskId }).map(d => d.decisionId), ['D1', 'D2']);
  assert.equal(listDecisions(state, { from: all[2].at }).length, 1);
  assert.equal(listDecisions(state, { to: all[0].at }).length, 0);
});

test('即时决定在复盘里没有计时时长，也不被算成 0 分钟的一轮', () => {
  const { state, taskB } = scenario();
  const view = listDecisions(state, { taskId: taskB.taskId })[0];
  assert.equal(view.entryMode, 'immediate');
  assert.equal(view.sessionId, null);
  assert.equal(view.elapsedMs, null);
  assert.equal(view.plannedMs, null);
  assert.equal(taskTotals(state, taskB.taskId).sessions, 0);
});

test('taskTotals：实测与计划分列，取消的轮次排除，用户估计独立', () => {
  const { ctx, state, taskA } = scenario();
  const t = taskTotals(state, taskA.taskId);
  assert.equal(t.elapsedMs, 45 * MIN);
  assert.equal(t.plannedMs, 45 * MIN);
  assert.equal(t.legacyPlannedMs, 0);
  assert.equal(t.hasLegacy, false);
  assert.equal(t.measuredSessions, 2);
  assert.equal(t.decisions, 2);

  const extra = startPlanned(state, { name: '点错了', plannedMs: 30 * MIN }, ctx);
  const cancelled = cancelSession(extra.state, { sessionId: extra.session.sessionId }, ctx);
  const t2 = taskTotals(cancelled.state, extra.task.taskId);
  assert.equal(t2.cancelledSessions, 1);
  assert.equal(t2.elapsedMs, 0, '取消的轮次不计入投入');
});

test('groupByDay / groupByTask', () => {
  const { ctx, state, taskA } = scenario();
  ctx.advance(DAY);
  const next = decide(state, { decisionId: 'D4', taskId: taskA.taskId, kind: 'stop' }, ctx);
  const days = groupByDay(next.state, { tzOffsetMinutes: 480 });
  assert.equal(days.length, 2);
  assert.deepEqual(days.map(d => d.decisions.length), [3, 1]);
  assert.equal(groupByTask(state).length, 2);
});

test('自然日边界按给定时区偏移计算', () => {
  const at = Date.UTC(2026, 8, 13, 1, 0, 0);       // 东八区是 9 月 13 日 09:00
  const b = localDayBounds(at, 480);
  assert.equal(b.start, Date.UTC(2026, 8, 12, 16, 0, 0));
  assert.equal(b.end - b.start, DAY);
  assert.equal(dayKeyOf(at, 480), '2026-09-13');
  assert.equal(dayKeyOf(at, 0), '2026-09-13');
  assert.equal(dayKeyOf(Date.UTC(2026, 8, 12, 20, 0, 0), 0), '2026-09-12');
});

test('todayReview 汇总今天的决定与事项', () => {
  const { state } = scenario();
  const r = todayReview(state, { at: Date.UTC(2026, 8, 13, 3, 0, 0), tzOffsetMinutes: 480 });
  assert.equal(r.day, '2026-09-13');
  assert.equal(r.decisionCount, 3);
  assert.deepEqual(r.counts, { stop: 1, switch: 1, continue: 1, later: 0, completed: 0 });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].elapsedMs, 45 * MIN);
  assert.equal(r.items[1].elapsedMs, 0);
});

test('今日复盘 Markdown：呈现选择、笔记、感受与回访，不估算反事实收益', () => {
  const { ctx, state } = scenario();
  const withFollow = followUp(state, { decisionId: 'D2', stillAgree: true, feeling: '轻松了' }, ctx);
  const md = todayReviewMarkdown(withFollow.state, { at: ctx.at, tzOffsetMinutes: 480, locale: 'zh-CN' });
  assert.match(md, /# 今日复盘 · 2026-09-13/);
  assert.match(md, /就到这里/);
  assert.match(md, /换个办法/);
  assert.match(md, /再投入一会儿/);
  assert.match(md, /够了，就买这个/);
  assert.match(md, /差价不到 20 元就买/);
  assert.match(md, /实测用时: 45 分钟/);
  assert.match(md, /现在仍然认可 轻松了/);
  assert.match(md, /我已经纠结一会儿了/, '即时入口要在复盘里标出来');
  assert.doesNotMatch(md, /保住|节省|省下/, '不得估算不存在的反事实收益');
  assert.doesNotMatch(md, /失败|坚持/);
});

test('旧记录在 Markdown 里标成「旧版计划用时」，不混进实测', () => {
  const ctx = makeCtx(Date.UTC(2026, 8, 13, 1, 0, 0));
  const s = migrate({ history: [{ id: 'h1', name: '旧事', doneAt: Date.UTC(2026, 8, 13, 2, 0, 0), total: 40 * MIN, decision: 'completed' }] }, ctx);
  const md = todayReviewMarkdown(s, { at: Date.UTC(2026, 8, 13, 3, 0, 0), tzOffsetMinutes: 480 });
  assert.match(md, /旧版计划用时: 40 分钟/);
  assert.doesNotMatch(md, /实测用时/);
});

test('英文复盘用同一套数据与键', () => {
  const { state } = scenario();
  const md = todayReviewMarkdown(state, { at: Date.UTC(2026, 8, 13, 3, 0, 0), tzOffsetMinutes: 480, locale: 'en' });
  assert.match(md, /Today's look back/);
  assert.match(md, /Stop here/);
  assert.match(md, /Try another way/);
  assert.doesNotMatch(md, /Stop-Loss/i, '英文文案不用 Stop-Loss 品牌');
});

test('空状态的复盘不炸', () => {
  const md = todayReviewMarkdown(createState({}, makeCtx()), { at: Date.UTC(2026, 8, 13, 3, 0, 0), tzOffsetMinutes: 480 });
  assert.match(md, /今天还没有记录/);
  assert.equal(formatDuration(90 * MIN, 'zh-CN'), '1 小时 30 分钟');
  assert.equal(formatDuration(90 * MIN, 'en'), '1h 30min');
  assert.equal(decisionView(createState({}, makeCtx()), { decisionId: 'x', taskId: 'y', sessionId: null, entryMode: 'immediate', at: 1, kind: 'stop' }).taskName, '');
});
