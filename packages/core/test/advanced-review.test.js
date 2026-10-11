// 高级复盘（Pro）：按场景与时段分组、反复继续的事项、后续自评汇总。
// 硬边界：这里只做**分组计数**，不排名、不评分、不判定谁的选择更理性（PRODUCT.md 第 4 / 6 节）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, MIN } from './helpers.js';
import { createState, startPlanned, openReassessment, decide, followUp, advancedReview, SCENES } from '../index.js';

// 在指定时刻用某个场景走一轮：开始 → 到点 → 做一个决定。
function round(state, ctx, { name, scene, at, kind, continueMs }) {
  ctx.set(at);
  const s1 = startPlanned(state, { name, scene, plannedMs: 30 * MIN }, ctx);
  ctx.set(at + 30 * MIN);
  const draft = openReassessment(s1.state, { sessionId: s1.session.sessionId }, ctx).draft;
  const out = decide(s1.state, {
    decisionId: draft.decisionId, sessionId: draft.sessionId, taskId: draft.taskId,
    entryMode: 'planned', kind, continueMs
  }, ctx);
  return { state: out.state, decision: out.decision, taskId: s1.task.taskId, sessionId: s1.session.sessionId };
}

// 2026-03-02 是周一；用固定 UTC 时刻 + tzOffsetMinutes=0，让时段断言不受运行机器时区影响。
const D = Date.UTC(2026, 2, 2, 0, 0, 0);
const H = 3600000;

test('空数据：24 个时段一条不少，场景一行不造', () => {
  const r = advancedReview(createState({}), { tzOffsetMinutes: 0 });
  assert.equal(r.decisionCount, 0);
  assert.deepEqual(r.scenes, []);
  assert.equal(r.hours.length, 24, '时段分布要看得出空档，零行必须保留');
  assert.deepEqual(r.repeats, []);
  assert.deepEqual(r.sceneKeys, SCENES);
});

test('按场景分组：没填场景的记录进「其它」，不替用户归类', () => {
  const ctx = makeCtx();
  let s = createState({}, ctx);
  s = round(s, ctx, { name: '比价耳机', scene: 'compare', at: D + 9 * H, kind: 'stop' }).state;
  s = round(s, ctx, { name: '比价键盘', scene: 'compare', at: D + 10 * H, kind: 'switch' }).state;
  s = round(s, ctx, { name: '没标场景', at: D + 11 * H, kind: 'stop' }).state;

  const r = advancedReview(s, { tzOffsetMinutes: 0 });
  assert.equal(r.decisionCount, 3);
  assert.deepEqual(r.scenes.map(x => x.key), ['compare', 'other']);
  const compare = r.scenes[0];
  assert.equal(compare.decisions, 2);
  assert.deepEqual(compare.counts, { stop: 1, switch: 1, continue: 0 });
  assert.equal(compare.elapsedMs, 60 * MIN, '两轮各 30 分钟实测');
  assert.equal(r.scenes[1].decisions, 1);
});

test('按时段分组：落在各自的小时里，其余小时保持 0', () => {
  const ctx = makeCtx();
  let s = createState({}, ctx);
  s = round(s, ctx, { name: '夜里卡题', scene: 'stuck', at: D + 23 * H, kind: 'continue', continueMs: 15 * MIN }).state;
  s = round(s, ctx, { name: '早上卡题', scene: 'stuck', at: D + 8 * H, kind: 'stop' }).state;

  const r = advancedReview(s, { tzOffsetMinutes: 0 });
  // 决定发生在开始后 30 分钟：23:00 开始 → 23:30 决定；08:00 开始 → 08:30 决定
  assert.equal(r.hours[23].decisions, 1);
  assert.equal(r.hours[8].decisions, 1);
  assert.equal(r.hours.reduce((a, h) => a + h.decisions, 0), 2);
  assert.equal(r.hours[0].decisions, 0);
});

test('反复继续：只数同一事项上 continue 的次数，≥2 才列出来', () => {
  const ctx = makeCtx();
  ctx.set(D + 14 * H);
  const s1 = startPlanned(createState({}, ctx), { name: '争论', scene: 'argue', plannedMs: 10 * MIN }, ctx);
  let state = s1.state;
  let sessionId = s1.session.sessionId;
  for (let i = 0; i < 3; i++) {
    ctx.advance(10 * MIN);
    const draft = openReassessment(state, { sessionId }, ctx).draft;
    const out = decide(state, {
      decisionId: draft.decisionId, sessionId, taskId: draft.taskId,
      entryMode: 'planned', kind: 'continue', continueMs: 10 * MIN
    }, ctx);
    state = out.state;
    sessionId = out.session.sessionId;
  }
  // 另一个事项只继续了一次，不该出现在列表里
  state = round(state, ctx, { name: '只继续一次', scene: 'argue', at: D + 20 * H, kind: 'continue', continueMs: 5 * MIN }).state;

  const r = advancedReview(state, { tzOffsetMinutes: 0 });
  assert.equal(r.repeats.length, 1);
  assert.equal(r.repeats[0].name, '争论');
  assert.equal(r.repeats[0].continueCount, 3);
  assert.equal(r.repeats[0].scene, 'argue');
});

test('后续自评按本人回访汇总，没回访的单独一格，不当成默认认可', () => {
  const ctx = makeCtx();
  let s = createState({}, ctx);
  const a = round(s, ctx, { name: '清洁细节', scene: 'detail', at: D + 15 * H, kind: 'stop' });
  const b = round(a.state, ctx, { name: '另一处细节', scene: 'detail', at: D + 16 * H, kind: 'stop' });
  ctx.advance(30 * H);
  let state = followUp(b.state, { decisionId: a.decision.decisionId, stillAgree: true }, ctx).state;
  state = followUp(state, { decisionId: b.decision.decisionId, stillAgree: false, feeling: '当时收得太早' }, ctx).state;

  const withFollow = advancedReview(state, { tzOffsetMinutes: 0 }).scenes[0];
  assert.deepEqual(withFollow.followUp, { agree: 1, disagree: 1, unanswered: 0, none: 0 });

  const noFollow = advancedReview(b.state, { tzOffsetMinutes: 0 }).scenes[0];
  assert.equal(noFollow.followUp.none, 2);
  assert.equal(noFollow.followUp.agree, 0, '没回访不能算成认可');
});

test('时间范围过滤只看区间内的决定', () => {
  const ctx = makeCtx();
  let s = createState({}, ctx);
  s = round(s, ctx, { name: '旧的', scene: 'debug', at: D, kind: 'stop' }).state;
  s = round(s, ctx, { name: '新的', scene: 'debug', at: D + 5 * 24 * H, kind: 'stop' }).state;
  const recent = advancedReview(s, { from: D + 24 * H, tzOffsetMinutes: 0 });
  assert.equal(recent.decisionCount, 1);
  assert.equal(recent.from, D + 24 * H);
});

test('输出里没有任何评分、排名或建议字段', () => {
  const ctx = makeCtx();
  const s = round(createState({}, ctx), ctx, { name: 'x', scene: 'debug', at: D + H, kind: 'stop' }).state;
  const json = JSON.stringify(advancedReview(s, { tzOffsetMinutes: 0 }));
  for (const banned of ['score', 'rank', 'rating', 'advice', 'suggest', 'better', 'wasted']) {
    assert.equal(json.includes(banned), false, '不该出现评判性字段：' + banned);
  }
});
