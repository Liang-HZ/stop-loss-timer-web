import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planReminders, ReminderScheduler, overdueMs, effectiveElapsedMs,
  DEFAULT_MAX_ALERTS, DEFAULT_INTERVAL_MS
} from '../reminders.js';

const T = 1700000000000;

test('默认上限：到点响一次，未响应时再响两次，间隔 60 秒', () => {
  assert.equal(DEFAULT_MAX_ALERTS, 3);
  assert.equal(DEFAULT_INTERVAL_MS, 60000);
  const plan = planReminders({ deadlineAt: T + 600000, now: T });
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map(p => p.at - (T + 600000)), [0, 60000, 120000]);
  assert.deepEqual(plan.map(p => p.delaySec), [600, 660, 720]);
});

test('设置里可以改上限与间隔', () => {
  const plan = planReminders({ deadlineAt: T + 1000, now: T, maxAlerts: 5, intervalMs: 30000 });
  assert.equal(plan.length, 5);
  assert.equal(plan[4].at - (T + 1000), 120000);
});

test('静音或上限为 0 时一个都不排', () => {
  assert.deepEqual(planReminders({ deadlineAt: T + 1000, now: T, muted: true }), []);
  assert.deepEqual(planReminders({ deadlineAt: T + 1000, now: T, maxAlerts: 0 }), []);
});

test('已经错过的那几次不追响，只排还没到的', () => {
  // 到点已过 70 秒：第 0、1 次已过，只剩第 2 次
  const plan = planReminders({ deadlineAt: T - 70000, now: T });
  assert.deepEqual(plan.map(p => p.index), [2]);
  assert.equal(plan[0].delaySec, 50);
  // 全过完了就一个不排
  assert.deepEqual(planReminders({ deadlineAt: T - 600000, now: T }), []);
});

test('没有截止时刻就不排（即时入口不设短提醒时）', () => {
  assert.deepEqual(planReminders({ deadlineAt: undefined, now: T }), []);
  assert.deepEqual(planReminders({}), []);
});

/* ---------------- 调度表 ---------------- */

function fakeIo(now) {
  const scheduled = [];
  const cancelled = [];
  let seq = 0;
  return {
    scheduled, cancelled,
    io: {
      now: () => now,
      schedule: (delaySec, meta) => { const h = { id: ++seq, delaySec, meta }; scheduled.push(h); return h; },
      cancel: h => cancelled.push(h)
    }
  };
}

test('按 sessionId 去重：重排先取消旧的，不叠铃', () => {
  const f = fakeIo(T);
  const sch = new ReminderScheduler(f.io);
  sch.schedule('s1', T + 600000, {});
  assert.equal(f.scheduled.length, 3);
  sch.schedule('s1', T + 900000, {});           // 改了截止时刻
  assert.equal(f.cancelled.length, 3, '旧的三次必须先取消');
  assert.equal(f.scheduled.length, 6);
  assert.equal(sch.size, 1);
  assert.deepEqual(sch.planOf('s1').map(p => p.delaySec), [900, 960, 1020]);
});

test('确认决定或取消后，该 session 的排队铃全部停掉', () => {
  const f = fakeIo(T);
  const sch = new ReminderScheduler(f.io);
  sch.schedule('s1', T + 1000, {});
  sch.schedule('s2', T + 2000, {});
  assert.equal(sch.cancel('s1'), true);
  assert.equal(f.cancelled.length, 3);
  assert.equal(sch.has('s1'), false);
  assert.equal(sch.has('s2'), true, '别人的铃不受影响');
  assert.equal(sch.cancel('s1'), false, '重复取消是安全的 no-op');
  assert.equal(sch.cancelAll(), 1);
  assert.equal(sch.size, 0);
});

test('syncWith：按当前未结束轮次补齐与清理，没变化的不重排', () => {
  const f = fakeIo(T);
  const sch = new ReminderScheduler(f.io);
  const open = [
    { sessionId: 's1', deadlineAt: T + 60000 },
    { sessionId: 's2', deadlineAt: T + 120000 }
  ];
  sch.syncWith(open, {});
  assert.equal(f.scheduled.length, 6);
  sch.syncWith(open, {});
  assert.equal(f.scheduled.length, 6, '截止时刻没变就不重复排');
  assert.equal(f.cancelled.length, 0);
  // s2 结束了，s3 新开
  sch.syncWith([open[0], { sessionId: 's3', deadlineAt: T + 180000 }], {});
  assert.equal(sch.has('s2'), false);
  assert.equal(sch.has('s3'), true);
  assert.equal(f.cancelled.length, 3);
});

test('syncWith 忽略没有截止时刻的轮次（即时入口无短提醒）', () => {
  const f = fakeIo(T);
  const sch = new ReminderScheduler(f.io);
  sch.syncWith([{ sessionId: 's1' }, { sessionId: null, deadlineAt: T + 1 }], {});
  assert.equal(sch.size, 0);
  assert.equal(f.scheduled.length, 0);
});

test('静音设置下 syncWith 不排铃，但仍记录这一轮（解除静音可重排）', () => {
  const f = fakeIo(T);
  const sch = new ReminderScheduler(f.io);
  sch.syncWith([{ sessionId: 's1', deadlineAt: T + 60000 }], { muted: true });
  assert.equal(f.scheduled.length, 0);
  assert.equal(sch.has('s1'), true);
  assert.deepEqual(sch.planOf('s1'), []);
});

test('取消句柄抛异常时其余提醒照样取消', () => {
  let n = 0;
  const sch = new ReminderScheduler({
    now: () => T,
    schedule: () => ({ n: ++n }),
    cancel: h => { if (h.n === 2) throw new Error('这个句柄已经失效'); }
  });
  sch.schedule('s1', T + 60000, {});
  assert.equal(sch.cancel('s1'), true);
  assert.equal(sch.size, 0);
});

/* ---------------- 超时待响应 ---------------- */

test('超时待响应单独算，不计入有效投入', () => {
  const s = { startedAt: T, deadlineAt: T + 1800000, endedAt: T + 4320000 };  // 30 分钟约定，72 分钟才回来
  assert.equal(overdueMs(s, T), 2520000);                                    // 超时 42 分钟
  assert.equal(effectiveElapsedMs(s, T), 1800000, '有效投入封顶在约定的重评时刻');
});

test('提前结束时没有超时，有效投入就是实测时长', () => {
  const s = { startedAt: T, deadlineAt: T + 1800000, endedAt: T + 600000 };
  assert.equal(overdueMs(s, T), 0);
  assert.equal(effectiveElapsedMs(s, T), 600000);
});

test('还没结束的轮次按 now 算；没有开始时刻的旧轮次返回 null', () => {
  const open = { startedAt: T, deadlineAt: T + 1800000 };
  assert.equal(effectiveElapsedMs(open, T + 300000), 300000);
  assert.equal(overdueMs(open, T + 300000), 0);
  assert.equal(effectiveElapsedMs({ plannedMs: 1800000, legacyPlanned: true }, T), null,
    '旧的计划时长不许顶替实测经过时间');
  assert.equal(overdueMs(null, T), 0);
});

/* ---- Pro：预告提醒 ---- */

test('预告提醒排在到点之前，index 为 -1，且不挤掉到点那次', () => {
  const T0 = 1700000000000;
  const plan = planReminders({ deadlineAt: T0 + 600000, now: T0, preAlertMs: 120000 });
  assert.deepEqual(plan.map(p => p.index), [-1, 0, 1, 2]);
  assert.deepEqual(plan.map(p => p.kind), ['pre', 'due', 'due', 'due']);
  assert.equal(plan[0].at, T0 + 480000, '到点前 2 分钟');
  assert.equal(plan[1].at, T0 + 600000, '到点那次一次不少');
});

test('预告时刻已经过去就不补响；预告比剩余时间还长也不提前爆', () => {
  const T0 = 1700000000000;
  const late = planReminders({ deadlineAt: T0 + 60000, now: T0, preAlertMs: 120000 });
  assert.deepEqual(late.map(p => p.index), [0, 1, 2], '预告点落在过去，直接跳过');
  const off = planReminders({ deadlineAt: T0 + 600000, now: T0, preAlertMs: 0 });
  assert.deepEqual(off.map(p => p.index), [0, 1, 2]);
});

test('静音时预告也不响：静音就是全都不响', () => {
  const T0 = 1700000000000;
  assert.deepEqual(planReminders({ deadlineAt: T0 + 600000, now: T0, preAlertMs: 120000, muted: true }), []);
});

test('调度器把 kind 一并交给排期回调，铃声才能按预告／到点分开', () => {
  const T0 = 1700000000000;
  const metas = [];
  const s = new ReminderScheduler({ schedule: (sec, meta) => { metas.push(meta); return meta; }, cancel: () => {}, now: () => T0 });
  s.schedule('sess-x', T0 + 600000, { reminderMaxAlerts: 1, reminderIntervalMs: 60000, preAlertMs: 60000 });
  assert.deepEqual(metas.map(m => m.kind), ['pre', 'due']);
  assert.equal(metas[0].sessionId, 'sess-x');
});
