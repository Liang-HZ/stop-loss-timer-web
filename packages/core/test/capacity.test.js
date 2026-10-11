import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCapacity, assertCanAdd, countState, LIMITS, WARN_RATIO, CapacityError } from '../capacity.js';
import { createState, createTask, createSession, createDecision } from '../model.js';
import { startPlanned, decide } from '../flow.js';
import { makeCtx, MIN } from './helpers.js';

function stateWith(counts) {
  const ctx = makeCtx();
  const s = createState({}, ctx);
  for (let i = 0; i < (counts.tasks || 0); i++) s.tasks.push(createTask({ taskId: `t${i}`, name: 'x' }, ctx));
  for (let i = 0; i < (counts.sessions || 0); i++) s.sessions.push(createSession({ sessionId: `s${i}`, taskId: 't0' }, ctx));
  for (let i = 0; i < (counts.decisions || 0); i++) s.decisions.push(createDecision({ decisionId: `d${i}`, taskId: 't0', kind: 'stop' }, ctx));
  return s;
}

test('上限就是契约里的 500 / 3000 / 3000（外加 templates 100），警戒线 90%', () => {
  assert.deepEqual(LIMITS, { tasks: 500, sessions: 3000, decisions: 3000, templates: 100 });
  assert.equal(WARN_RATIO, 0.9);
});

test('checkCapacity 三档：ok / warn(≥90%) / full', () => {
  assert.equal(checkCapacity(stateWith({ tasks: 100 })).level, 'ok');
  assert.equal(checkCapacity(stateWith({ tasks: 449 })).level, 'ok');
  const warn = checkCapacity(stateWith({ tasks: 450 }));
  assert.equal(warn.level, 'warn');
  assert.deepEqual(warn.warn, ['tasks']);
  assert.equal(warn.counts.tasks, 450);
  const full = checkCapacity(stateWith({ tasks: 500 }));
  assert.equal(full.level, 'full');
  assert.deepEqual(full.full, ['tasks']);
  assert.equal(full.ok, false);
});

test('【验收】容量达到上限拒绝写入并带 code:capacity_full，不静默截断', () => {
  const ctx = makeCtx();
  const s = stateWith({ tasks: 500 });
  const before = countState(s);
  assert.throws(
    () => startPlanned(s, { name: '第 501 个', plannedMs: 30 * MIN }, ctx),
    e => e instanceof CapacityError && e.code === 'capacity_full' && e.exportSuggested === true
  );
  assert.deepEqual(countState(s), before, '被拒绝的写入不得改动任何数据');
  try {
    assertCanAdd(s, { tasks: 1 });
    assert.fail('应当抛出');
  } catch (e) {
    assert.equal(e.detail.blocked[0].kind, 'tasks');
    assert.equal(e.detail.blocked[0].limit, 500);
    assert.match(e.message, /导出/);
  }
});

test('sessions / decisions 上限同样生效，且继续（continue）会同时要两格', () => {
  const ctx = makeCtx();
  const base = startPlanned(createState({}, ctx), { name: 'x', plannedMs: 30 * MIN }, ctx);
  const s = base.state;
  // 撑到 sessions 上限
  while (s.sessions.length < LIMITS.sessions) {
    s.sessions.push(createSession({ sessionId: `pad${s.sessions.length}`, taskId: base.task.taskId }, ctx));
  }
  assert.throws(() => decide(s, { taskId: base.task.taskId, kind: 'continue', continueMs: 15 * MIN }, ctx),
    e => e.code === 'capacity_full');
  // decisions 满时连「就到这里」也要明确拒绝，而不是丢掉这条决定
  const s2 = startPlanned(createState({}, ctx), { name: 'y', plannedMs: 30 * MIN }, ctx).state;
  while (s2.decisions.length < LIMITS.decisions) {
    s2.decisions.push(createDecision({ decisionId: `pd${s2.decisions.length}`, taskId: s2.tasks[0].taskId, kind: 'stop' }, ctx));
  }
  assert.throws(() => decide(s2, { taskId: s2.tasks[0].taskId, kind: 'stop' }, ctx), e => e.code === 'capacity_full');
});

test('assertCanAdd 在未满时返回容量档位供 UI 提示导出', () => {
  const r = assertCanAdd(stateWith({ tasks: 450 }), { tasks: 1 });
  assert.equal(r.level, 'warn');
  assert.equal(r.usage.tasks >= WARN_RATIO, true);
});
