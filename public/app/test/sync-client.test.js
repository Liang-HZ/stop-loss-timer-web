import test from 'node:test';
import assert from 'node:assert/strict';
import {
  putHeaders, getHeaders, classifyPut, classifyGet, buildConflictRecord,
  resolveConflict, shouldWarnOnPull, CONFLICT_CHOICES, SCHEMA_HEADER
} from '../sync-client.js';
import { createState, startPlanned, enterImmediate } from '../../core/index.js';

const ctx = (() => { let n = 0; return { now: () => 1700000000000, idGen: () => 'id' + (++n) }; })();

const localState = (() => {
  const s = startPlanned(createState({}, ctx), { name: '本机的事', plannedMs: 60000 }, ctx).state;
  return { ...s, rev: 3 };
})();
const serverState = (() => {
  const s = enterImmediate(createState({}, ctx), { name: '另一台设备的事' }, ctx).state;
  return { ...s, rev: 5 };
})();

test('GET 带 X-Schema-Version: 2，PUT 另带 If-Match', () => {
  assert.equal(getHeaders('t')[SCHEMA_HEADER], '2');
  assert.equal(getHeaders('t').Authorization, 'Bearer t');
  const h = putHeaders('t', 7);
  assert.equal(h[SCHEMA_HEADER], '2');
  assert.equal(h['If-Match'], '7');
  assert.equal(putHeaders('t')['If-Match'], '0', 'rev 缺省按 0（首次写入）');
  assert.equal(putHeaders('t', NaN)['If-Match'], '0');
});

test('PUT 成功返回 rev', () => {
  const r = classifyPut(200, { ok: true, rev: 9, updatedAt: 123 });
  assert.equal(r.kind, 'ok');
  assert.equal(r.rev, 9);
  assert.equal(r.updatedAt, 123);
});

test('409 conflict 带回云端整包', () => {
  const r = classifyPut(409, { error: 'conflict', rev: 5, data: serverState });
  assert.equal(r.kind, 'conflict');
  assert.equal(r.serverRev, 5);
  assert.equal(r.server.tasks.length, 1);
});

test('409 conflict 但服务端没带整包（首次写入撞上）也要分到 conflict，不当成功', () => {
  const r = classifyPut(409, { error: 'conflict', rev: 2, data: null });
  assert.equal(r.kind, 'conflict');
  assert.equal(r.server, null);
});

test('409 client_outdated 单独一类，有兜底提示', () => {
  const r = classifyPut(409, { error: 'client_outdated', rev: 4 });
  assert.equal(r.kind, 'client_outdated');
  assert.equal(r.serverRev, 4);
});

test('413 capacity_full 与「请求体过大」分得开', () => {
  assert.equal(classifyPut(413, { error: 'capacity_full', detail: { blocked: [] } }).kind, 'capacity_full');
  assert.equal(classifyPut(413, { error: '请求体过大' }).kind, 'too_large');
});

test('401 / 429 / 其它状态各归各位，没有一条被静默当成功', () => {
  assert.equal(classifyPut(401, {}).kind, 'unauthorized');
  assert.equal(classifyPut(429, {}).kind, 'rate_limited');
  assert.equal(classifyPut(500, { error: 'boom' }).kind, 'error');
  assert.equal(classifyPut(500, { error: 'boom' }).message, 'boom');
  assert.equal(classifyPut(302, null).kind, 'error');
});

test('GET：v2 收下，非 v2 明确标成 not_v2 而不是当空数据吞掉', () => {
  const headers = { get: k => (k === 'X-Data-Schema' ? '2' : null) };
  const ok = classifyGet(200, serverState, headers);
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.rev, 5);
  assert.equal(ok.dataSchema, '2');
  assert.equal(classifyGet(200, { items: [], history: [] }, headers).kind, 'not_v2');
  assert.equal(classifyGet(401, {}, headers).kind, 'unauthorized');
  assert.equal(classifyGet(500, {}, headers).kind, 'error');
});

test('冲突记录把两边整包都存下来', () => {
  const rec = buildConflictRecord(localState, serverState, 42);
  assert.equal(rec.at, 42);
  assert.equal(rec.localRev, 3);
  assert.equal(rec.serverRev, 5);
  assert.equal(rec.local.tasks[0].name, '本机的事');
  assert.equal(rec.server.tasks[0].name, '另一台设备的事');
});

test('保留云端：本机副本原样交回供导出，不再推送', () => {
  const rec = buildConflictRecord(localState, serverState, 1);
  const r = resolveConflict('cloud', rec, ctx);
  assert.equal(r.state.tasks[0].name, '另一台设备的事');
  assert.equal(r.needsPush, false);
  assert.equal(r.discardedLocal.tasks[0].name, '本机的事', '被放弃的本机数据必须交回，不能静默丢');
});

test('保留本机：基线换成云端 rev，再推一次才能落云', () => {
  const rec = buildConflictRecord(localState, serverState, 1);
  const r = resolveConflict('local', rec, ctx);
  assert.equal(r.state.tasks[0].name, '本机的事');
  assert.equal(r.state.rev, 5, 'rev 必须跟上云端，否则下一次 PUT 还是 409');
  assert.equal(r.needsPush, true);
});

test('合并：两边独有的记录一条都不丢', () => {
  const rec = buildConflictRecord(localState, serverState, 1);
  const r = resolveConflict('merge', rec, ctx);
  const names = r.state.tasks.map(t => t.name).sort();
  assert.deepEqual(names, ['另一台设备的事', '本机的事'].sort());
  assert.equal(r.state.rev, 5);
  assert.equal(r.needsPush, true);
});

test('未知的冲突选择直接报错，不静默挑一个', () => {
  assert.deepEqual(CONFLICT_CHOICES, ['cloud', 'local', 'merge']);
  assert.throws(() => resolveConflict('whatever', buildConflictRecord(localState, serverState, 1), ctx), /未知的冲突处理选择/);
});

test('缺边的冲突记录按空 state 兜底，不抛', () => {
  const r = resolveConflict('merge', { localRev: 0, serverRev: 0, local: null, server: null }, ctx);
  assert.equal(r.state.schemaVersion, 2);
  assert.equal(r.state.tasks.length, 0);
});

test('拉取时只有本机有未推送改动才提示冲突', () => {
  assert.equal(shouldWarnOnPull(3, 5, true).warn, true);
  assert.equal(shouldWarnOnPull(3, 5, false).warn, false, '本机干净就直接用云端，不打扰用户');
  assert.equal(shouldWarnOnPull(5, 5, true).warn, false);
  assert.equal(shouldWarnOnPull(7, 5, true).warn, false, '本机领先是正常待推送');
  assert.equal(shouldWarnOnPull(null, 5, true).reason, 'unknown_base');
});
