import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, createState, createTask, createSession, createDecision,
  validateTask, validateSession, validateDecision, validateState,
  defaultIdGen, newId, sessionElapsedMs, ValidationError, assertValidState
} from '../model.js';
import { makeCtx, MIN } from './helpers.js';

test('createState 产出 v2 空状态', () => {
  const ctx = makeCtx();
  const s = createState({}, ctx);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual([s.tasks, s.sessions, s.decisions], [[], [], []]);
  assert.equal(s.updatedAt, ctx.at);
  assert.equal(s.rev, 0);
  assert.equal(validateState(s).ok, true);
});

test('id 生成：注入的 idGen 优先，默认回退唯一', () => {
  const ctx = makeCtx();
  assert.equal(newId('t', ctx), 't_id1');
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(defaultIdGen());
  assert.equal(ids.size, 2000, '默认 id 生成器不能撞号');
});

test('默认 id 生成器在没有 crypto.randomUUID 时回退到时间戳+随机', () => {
  const orig = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    const ids = new Set();
    for (let i = 0; i < 500; i++) ids.add(defaultIdGen());
    assert.equal(ids.size, 500);
    assert.match([...ids][0], /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: orig, configurable: true });
  }
});

test('createTask 默认 active，名称可空（即时入口）', () => {
  const ctx = makeCtx();
  const t = createTask({ name: '  比价  ' }, ctx);
  assert.equal(t.name, '比价');
  assert.equal(t.status, 'active');
  assert.equal(t.createdAt, ctx.at);
  assert.equal(createTask({}, ctx).name, '');
});

test('createSession：legacy 不补造 startedAt，普通轮次补当前时刻', () => {
  const ctx = makeCtx();
  const live = createSession({ taskId: 't1', plannedMs: 30 * MIN }, ctx);
  assert.equal(live.startedAt, ctx.at);
  const legacy = createSession({ taskId: 't1', plannedMs: 30 * MIN, legacyPlanned: true, endedAt: ctx.at }, ctx);
  assert.equal(legacy.startedAt, undefined, 'legacy 轮次不得补造开始时刻');
  assert.equal(legacy.legacyPlanned, true);
  assert.equal(validateSession(legacy).ok, true);
});

test('createDecision 拒绝 later 与 completed 同时成立', () => {
  const ctx = makeCtx();
  assert.throws(
    () => createDecision({ taskId: 't1', kind: 'stop', later: true, completed: true }, ctx),
    e => e instanceof ValidationError && e.code === 'invalid'
  );
});

test('validate* 报出具体错误', () => {
  assert.equal(validateTask({ taskId: '', name: 1, createdAt: 'x', status: 'zzz' }).errors.length, 4);
  assert.match(validateDecision({ decisionId: 'd', taskId: 't', sessionId: null, entryMode: 'planned', at: 1, kind: 'nope' }).errors.join(), /kind/);
  assert.equal(validateSession({ sessionId: 's', taskId: 't', entryMode: 'planned', deadlineChanges: [], startedAt: 10, endedAt: 5 }).ok, false);
});

test('validateState 抓孤儿与重复 id', () => {
  const ctx = makeCtx();
  const s = createState({}, ctx);
  s.sessions.push(createSession({ taskId: 'ghost' }, ctx));
  assert.match(validateState(s).errors.join(), /orphan session/);
  assert.throws(() => assertValidState(s), /invalid/);
});

test('sessionElapsedMs 没有真实起止就返回 null', () => {
  assert.equal(sessionElapsedMs({ startedAt: 100, endedAt: 400 }), 300);
  assert.equal(sessionElapsedMs({ plannedMs: 300, endedAt: 400 }), null);
  assert.equal(sessionElapsedMs(null), null);
});
