import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeById, mergeStates, detectConflict, resolveGuestLogin, signOutLocalState, GUEST_LOGIN_CHOICES } from '../sync.js';
import { createState, validateState } from '../model.js';
import { startPlanned, decide } from '../flow.js';
import { makeCtx, MIN } from './helpers.js';

test('mergeById 去重并保留较新的 updatedAt', () => {
  const local = [{ id: 'a', updatedAt: 10, v: 'local' }, { id: 'b', updatedAt: 5, v: 'local' }];
  const server = [{ id: 'a', updatedAt: 20, v: 'server' }, { id: 'c', updatedAt: 1, v: 'server' }];
  const out = mergeById(local, server, { idKey: 'id' });
  assert.deepEqual(out.map(x => x.id), ['a', 'b', 'c']);
  assert.equal(out[0].v, 'server');
  const out2 = mergeById(server, local, { idKey: 'id' });
  assert.equal(out2.find(x => x.id === 'a').v, 'server', '较新者与传入顺序无关');
});

test('mergeById 的时间戳回退键与并列处理', () => {
  const out = mergeById([{ did: 'x', at: 5, v: 1 }], [{ did: 'x', at: 5, v: 2 }], { idKey: 'did', fallbackKeys: ['updatedAt', 'at'] });
  assert.equal(out.length, 1);
  assert.equal(out[0].v, 2, '时间并列时保留后来者（远端）');
  const noStamp = mergeById([{ id: 'x', v: 1 }], [{ id: 'x', v: 2 }], { idKey: 'id' });
  assert.equal(noStamp[0].v, 2);
  assert.deepEqual(mergeById(null, undefined, { idKey: 'id' }), []);
  assert.deepEqual(mergeById([{ noId: 1 }], [], { idKey: 'id' }), [], '没有 id 的脏记录直接丢弃，不会污染合并结果');
});

function twoSides() {
  const ctx = makeCtx();
  const base = startPlanned(createState({}, ctx), { name: '共同的事', plannedMs: 30 * MIN }, ctx);
  ctx.advance(30 * MIN);
  const local = decide(base.state, { decisionId: 'L1', taskId: base.task.taskId, kind: 'continue', continueMs: 15 * MIN }, ctx);
  // 另一端必须用不同的 id 空间，否则两端会生成同一个 taskId（那是 id 生成器的问题，不是合并的问题）
  const cloudBase = makeCtx(ctx.at + 60 * MIN);
  const cloudCtx = { now: cloudBase.now, idGen: () => 'cloud-' + cloudBase.idGen(), get at() { return cloudBase.at; } };
  const cloud = startPlanned(base.state, { name: '另一端的事', plannedMs: 20 * MIN }, cloudCtx);
  return { local: local.state, cloud: cloud.state, base, ctx };
}

test('mergeStates 保留两边独有记录，结果仍是合法 v2', () => {
  const { local, cloud } = twoSides();
  const merged = mergeStates(local, cloud);
  assert.equal(merged.schemaVersion, 2);
  assert.equal(merged.tasks.length, 2);
  assert.equal(merged.decisions.length, 1);
  assert.equal(merged.sessions.length, 3);
  assert.equal(validateState(merged).errors.join('; '), '');
  assert.equal(merged.rev, Math.max(local.rev, cloud.rev));
});

test('mergeStates 同 id 取较新：已结束的轮次覆盖对面仍开着的快照', () => {
  const { local, cloud, base } = twoSides();
  const merged = mergeStates(cloud, local);
  const first = merged.sessions.find(s => s.sessionId === base.session.sessionId);
  assert.notEqual(first.endedAt, undefined, '本地已经关掉的轮次不能被云端旧快照复活');
});

test('detectConflict 四种情形', () => {
  assert.deepEqual(detectConflict(3, 3), { conflict: false, reason: 'in_sync', localRev: 3, serverRev: 3 });
  assert.deepEqual(detectConflict(3, 5), { conflict: true, reason: 'server_ahead', localRev: 3, serverRev: 5 });
  assert.deepEqual(detectConflict(5, 3), { conflict: false, reason: 'local_ahead', localRev: 5, serverRev: 3 });
  assert.equal(detectConflict(null, 7).reason, 'unknown_base');
  assert.equal(detectConflict(null, 7).conflict, true);
  assert.equal(detectConflict(null, 0).conflict, false);
});

test('访客登录三选一：merge / cloud / local', () => {
  const { local, cloud } = twoSides();
  assert.deepEqual(GUEST_LOGIN_CHOICES, ['merge', 'cloud', 'local']);

  const m = resolveGuestLogin('merge', { local, cloud });
  assert.equal(m.state.tasks.length, 2);
  assert.equal(m.discarded, null);

  const c = resolveGuestLogin('cloud', { local, cloud });
  assert.equal(c.state, cloud);
  assert.equal(c.discarded, local, '选云端时必须把被放弃的本机副本交回，供导出');
  assert.equal(c.keepLocalBackup, true);

  const l = resolveGuestLogin('local', { local, cloud });
  assert.equal(l.state, local);
  assert.equal(l.keepLocalBackup, false);

  assert.throws(() => resolveGuestLogin('overwrite', { local, cloud }), e => e.code === 'invalid_choice');
});

test('访客数据不会被云端拉取静默覆盖', () => {
  const { local } = twoSides();
  const emptyCloud = createState({}, makeCtx());
  const merged = resolveGuestLogin('merge', { local, cloud: emptyCloud }).state;
  assert.equal(merged.tasks.length, local.tasks.length);
  assert.equal(merged.decisions.length, local.decisions.length);
});

test('退出账号返回空状态，不携带任何原账户记录', () => {
  const out = signOutLocalState(makeCtx());
  assert.deepEqual([out.tasks, out.sessions, out.decisions], [[], [], []]);
  assert.equal(out.schemaVersion, 2);
});
