import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, toV1Projection, isV2, mapLegacyDecision, LEGACY_DECISION_MAP, V2_TO_V1_DECISION } from '../migrate.js';
import { validateState, findTask, sessionElapsedMs } from '../model.js';
import { decide, startPlanned, resumeLater, cancelSession } from '../flow.js';
import { taskTotals } from '../review.js';
import { makeCtx, MIN } from './helpers.js';

// 取自 public/index.html 的真实 v1 形态：
// items[]   {name, end, total, prevTotal, rounds, originHistId, hypothesis}
// history[] {id, name, end, total, rounds, doneAt, decision, note, hypothesis, sessions:[{doneAt,duration,decision,note}]}
function v1Fixture() {
  return {
    updatedAt: 1_699_000_000_000,
    items: [
      { name: '调参数', end: 1_699_000_600_000, total: 15 * MIN, prevTotal: 45 * MIN, rounds: 4, originHistId: 'h_1', hypothesis: '跑通一个用例' },
      { name: '新开的活', end: 1_699_000_900_000, total: 30 * MIN, prevTotal: 0, rounds: 1 }
    ],
    history: [
      {
        id: 'h_1', name: '调参数', end: 1_698_900_000_000, total: 45 * MIN, rounds: 3,
        doneAt: 1_698_900_000_000, decision: 'next_round', note: '再试一次', hypothesis: '跑通一个用例',
        sessions: [
          { doneAt: 1_698_800_000_000, duration: 30 * MIN, decision: 'completed', note: '' },
          { doneAt: 1_698_850_000_000, duration: 15 * MIN, decision: 'switched', note: '换个思路' },
          { doneAt: 1_698_900_000_000, duration: 15 * MIN, decision: 'next_round', note: '再试一次' }
        ]
      },
      // 同名但是另一条 history：迁移后必须是两个 Task
      { id: 'h_2', name: '调参数', end: 1_698_700_000_000, total: 20 * MIN, rounds: 1, doneAt: 1_698_700_000_000, decision: 'switched', note: '', hypothesis: '' },
      // 没有 sessions 数组的老记录
      { id: 'h_3', name: '比价', end: 1_698_600_000_000, total: 25 * MIN, rounds: 1, doneAt: 1_698_600_000_000, decision: 'completed', note: '买了' },
      // decision 缺失
      { id: 'h_4', name: '争论', end: 1_698_500_000_000, total: 10 * MIN, rounds: 1, doneAt: 1_698_500_000_000 }
    ]
  };
}

test('迁移产出合法 v2，并保留原始快照与来源版本', () => {
  const ctx = makeCtx();
  const v1 = v1Fixture();
  const s = migrate(v1, ctx);
  assert.equal(validateState(s).errors.join('; '), '');
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.sourceVersion, 1);
  assert.equal(s.legacy.version, 1);
  assert.equal(s.legacy.capturedAt, ctx.at);
  assert.deepEqual(s.legacy.history, v1.history, '原始快照必须原样保留');
  assert.deepEqual(s.legacy.items, v1.items);
  v1.history[0].name = '被改了';
  assert.equal(s.legacy.history[0].name, '调参数', '快照必须是深拷贝，不跟着源对象变');
});

test('【验收】旧的两个同名事项不合并', () => {
  const s = migrate(v1Fixture(), makeCtx());
  const same = s.tasks.filter(t => t.name === '调参数');
  assert.equal(same.length, 2);
  assert.notEqual(same[0].taskId, same[1].taskId);
  assert.deepEqual(same.map(t => t.origin.legacyHistId).sort(), ['h_1', 'h_2']);
});

test('【验收】旧任务不因迁移被标记已完成', () => {
  const s = migrate(v1Fixture(), makeCtx());
  assert.equal(s.tasks.some(t => t.status === 'completed'), false, "旧 decision='completed' 只是 v1 默认值，不得当成用户声明已完成");
  const h3 = s.tasks.find(t => t.origin && t.origin.legacyHistId === 'h_3');
  assert.equal(h3.status, 'ended');
  const h4 = s.tasks.find(t => t.origin && t.origin.legacyHistId === 'h_4');
  assert.equal(h4.status, 'ended', 'decision 缺失按已结束处理，不猜测');
});

test('旧 decision 枚举映射表', () => {
  assert.deepEqual(LEGACY_DECISION_MAP, {
    completed: 'stop', switched: 'switch', next_round: 'continue',
    continue: 'continue', continued: 'continue', restored: 'continue'
  });
  assert.equal(mapLegacyDecision('completed'), 'stop');
  assert.equal(mapLegacyDecision('switched'), 'switch');
  assert.equal(mapLegacyDecision('next_round'), 'continue');
  assert.equal(mapLegacyDecision('已经不认识的值'), 'stop');
  assert.equal(mapLegacyDecision(undefined), 'stop');

  const s = migrate(v1Fixture(), makeCtx());
  const t1 = s.tasks.find(t => t.origin.legacyHistId === 'h_1');
  const kinds = s.decisions.filter(d => d.taskId === t1.taskId).map(d => d.kind);
  assert.deepEqual(kinds, ['stop', 'switch', 'continue']);
  // 最后一条是「继续／捞回」类 → later（可接续）；items 里它还在跑，所以最终是 active
  const t2 = s.tasks.find(t => t.origin.legacyHistId === 'h_2');
  assert.equal(t2.status, 'ended');
});

test('【验收】legacy duration 不当成真实投入', () => {
  const s = migrate(v1Fixture(), makeCtx());
  const t3 = s.tasks.find(t => t.origin.legacyHistId === 'h_3');
  const sess = s.sessions.filter(x => x.taskId === t3.taskId);
  assert.equal(sess.length, 1, '没有 sessions 数组的旧记录按一轮处理，不按 rounds 凭空拆轮');
  assert.equal(sess[0].startedAt, undefined, '不得补造开始时刻');
  assert.equal(sess[0].legacyPlanned, true);
  assert.equal(sess[0].plannedMs, 25 * MIN);
  assert.equal(sess[0].endReason, 'unknown');
  assert.equal(sessionElapsedMs(sess[0]), null, '旧计划时长不能算成实测经过时间');
  const totals = taskTotals(s, t3.taskId);
  assert.equal(totals.elapsedMs, 0);
  assert.equal(totals.legacyPlannedMs, 25 * MIN);
  assert.equal(totals.hasLegacy, true);
});

test('旧 items（进行中）→ active Task + 开启中的 Session；originHistId 按 id 接续，不按名字合并', () => {
  const s = migrate(v1Fixture(), makeCtx());
  const t1 = s.tasks.find(t => t.origin && t.origin.legacyHistId === 'h_1');
  assert.equal(t1.status, 'active', '还在跑的事项接续到原 Task');
  const open = s.sessions.filter(x => x.taskId === t1.taskId && x.endedAt === undefined);
  assert.equal(open.length, 1);
  assert.equal(open[0].deadlineAt, 1_699_000_600_000);
  assert.equal(open[0].plannedMs, 15 * MIN);
  assert.equal(open[0].legacyPlanned, true);
  assert.equal(open[0].startedAt, undefined);

  // 没有 originHistId 的 item 自建新 Task，不与任何同名历史合并
  const fresh = s.tasks.filter(t => t.name === '新开的活');
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].status, 'active');
  assert.equal(fresh[0].origin, undefined);
});

test('【验收】迁移幂等：对 v2 输入原样返回，重复迁移结果不变', () => {
  const ctx = makeCtx();
  const once = migrate(v1Fixture(), ctx);
  ctx.advance(9999);
  const twice = migrate(once, ctx);
  assert.equal(twice, once, 'v2 输入必须原样返回同一个对象');
  assert.equal(isV2(once), true);
  assert.equal(isV2(v1Fixture()), false);
  // 同样的输入 + 同样的 ctx → 完全相同的输出（id 不含随机）
  const a = migrate(v1Fixture(), makeCtx());
  const b = migrate(v1Fixture(), makeCtx());
  assert.deepEqual(b, a);
});

test('迁移能吃下空数据与脏数据', () => {
  const ctx = makeCtx();
  const empty = migrate({}, ctx);
  assert.deepEqual([empty.tasks, empty.sessions, empty.decisions], [[], [], []]);
  assert.equal(validateState(migrate(undefined, ctx)).ok, true);
  const dirty = migrate({ items: [null, 3], history: [null, 'x', { name: '没有 id 的记录', doneAt: 1, total: 5 }] }, ctx);
  assert.equal(validateState(dirty).errors.join('; '), '');
  assert.equal(dirty.tasks.length, 1);
});

test('【验收】能投影回 v1 供旧客户端读取', () => {
  const ctx = makeCtx();
  const s = migrate(v1Fixture(), ctx);
  const v1 = toV1Projection(s);
  assert.equal(v1.schemaVersion, 1);
  assert.equal(Array.isArray(v1.items) && Array.isArray(v1.history), true);
  const h1 = v1.history.find(h => h.id === 'h_1');
  assert.equal(h1.name, '调参数');
  assert.equal(h1.rounds, 3);
  assert.equal(h1.total, 60 * MIN, '三轮 30+15+15');
  assert.deepEqual(h1.sessions.map(x => x.decision), ['completed', 'switched', 'next_round']);
  assert.equal(h1.hypothesis, '跑通一个用例');
  assert.equal(v1.history.filter(h => h.name === '调参数').length, 2, '投影同样不合并同名');
  const item = v1.items.find(i => i.name === '调参数');
  assert.equal(item.originHistId, 'h_1');
  assert.equal(item.end, 1_699_000_600_000);
  assert.equal(item.total, 15 * MIN);
  assert.equal(item.prevTotal, 60 * MIN);
  assert.deepEqual(Object.keys(V2_TO_V1_DECISION).sort(), ['continue', 'stop', 'switch']);
});

test('v2 新写入的记录也能投影成 v1（实测用时优先于计划时长）', () => {
  const ctx = makeCtx();
  const s0 = migrate({}, ctx);
  const r = startPlanned(s0, { name: '写材料', plannedMs: 30 * MIN, hypothesis: '写完提纲' }, ctx);
  ctx.advance(12 * MIN);
  const d = decide(r.state, { taskId: r.task.taskId, kind: 'stop', note: '够了' }, ctx);
  const v1 = toV1Projection(d.state);
  assert.equal(v1.history.length, 1);
  assert.equal(v1.history[0].total, 12 * MIN, '投影用实测经过时间，不是 30 分钟计划值');
  assert.equal(v1.history[0].decision, 'completed');
  assert.equal(v1.history[0].sessions[0].note, '够了');
  assert.equal(v1.items.length, 0);
});

test('投影对 v1 输入原样返回；取消的轮次不进 v1 历史', () => {
  const ctx = makeCtx();
  const v1 = v1Fixture();
  assert.deepEqual(toV1Projection(v1), { items: v1.items, history: v1.history, updatedAt: v1.updatedAt });

  const s = startPlanned(migrate({}, ctx), { name: '点错了', plannedMs: 30 * MIN }, ctx);
  const c = cancelSession(s.state, { sessionId: s.session.sessionId }, ctx);
  const proj = toV1Projection(c.state);
  assert.equal(proj.history.length, 0, '取消的轮次排除在使用记录之外');
  assert.equal(proj.items.length, 0);
});

test('迁移后的数据能继续走正常状态流（later 可接续）', () => {
  const ctx = makeCtx(1_700_000_000_000);
  const s = migrate({ history: [{ id: 'h_x', name: '未完的事', doneAt: 1, total: 10 * MIN, decision: 'next_round' }] }, ctx);
  const task = s.tasks[0];
  assert.equal(task.status, 'later');
  const r = resumeLater(s, { taskId: task.taskId, plannedMs: 20 * MIN }, ctx);
  assert.equal(r.task.status, 'active');
  assert.equal(r.session.continuedFrom, s.sessions[0].sessionId);
  assert.equal(validateState(r.state).errors.join('; '), '');
});
