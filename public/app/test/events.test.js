import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvent, hasFreeText, EventBuffer, CLIENT_EVENTS, EVENT_ALLOWED_FIELDS, PLATFORM } from '../events.js';

const T = 1700000000000;

test('只认白名单里 Web 上报的那几个事件名', () => {
  assert.deepEqual(CLIENT_EVENTS, [
    'session_started', 'reassessment_opened', 'decision_confirmed',
    'resume_started', 'reminder_scheduled', 'reminder_trigger_observed'
  ]);
  assert.equal(buildEvent('任意自造事件', { at: T }), null);
});

test('事件只带枚举与 id，不含任何事项原文', () => {
  const e = buildEvent('decision_confirmed', {
    at: T, decisionKind: 'stop', entryMode: 'planned',
    decisionId: 'd_9f2a-4b', sessionId: 's_1',
    // 下面这些是调用方可能顺手传进来的原文，必须被丢掉
    name: '比价比到第八家', note: '算了', expectation: '再看两家', feeling: '松了口气', taskName: '比价'
  });
  assert.deepEqual(Object.keys(e).sort(), ['at', 'decisionId', 'decisionKind', 'entryMode', 'name', 'platform', 'sessionId', 'version'].sort());
  assert.equal(e.name, 'decision_confirmed', 'name 是事件名，不是事项名');
  assert.equal(e.platform, PLATFORM);
  assert.equal(hasFreeText(e), false);
  const text = JSON.stringify(e);
  for (const leak of ['比价', '算了', '再看两家', '松了口气']) {
    assert.equal(text.includes(leak), false, `事项原文「${leak}」泄漏进了事件`);
  }
});

test('非法枚举与非法 id 一律丢弃，不上报脏值', () => {
  const e = buildEvent('decision_confirmed', { at: T, decisionKind: '放弃', entryMode: 'guess', decisionId: '带空格 的 id', sessionId: 'x'.repeat(70) });
  assert.equal('decisionKind' in e, false);
  assert.equal('entryMode' in e, false);
  assert.equal('decisionId' in e, false);
  assert.equal('sessionId' in e, false);
  assert.deepEqual(EVENT_ALLOWED_FIELDS.includes('note'), false);
});

test('hasFreeText 能识破混进来的多余字段', () => {
  assert.equal(hasFreeText({ name: 'session_started', at: T, note: '偷偷夹带' }), true);
  assert.equal(hasFreeText(null), false);
});

test('没同意时整个是空操作：不排队、不发送', async () => {
  const sent = [];
  const buf = new EventBuffer({ send: async b => sent.push(b), enabled: false });
  assert.equal(buf.track('session_started', { at: T }), null);
  assert.equal(buf.queue.length, 0);
  await buf.flush();
  assert.equal(sent.length, 0);
});

test('同意后攒批发送，攒够 batchMax 自动发', async () => {
  const sent = [];
  const buf = new EventBuffer({ send: async b => { sent.push(b); }, enabled: true, batchMax: 2 });
  buf.track('session_started', { at: T, entryMode: 'planned', sessionId: 's1' });
  assert.equal(sent.length, 0);
  buf.track('reassessment_opened', { at: T, decisionId: 'd1' });
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 2);
});

test('flush 手动发剩下的；发送失败不重试也不堆积', async () => {
  const buf = new EventBuffer({ send: async () => { throw new Error('离线'); }, enabled: true });
  buf.track('resume_started', { at: T });
  const r = await buf.flush();
  assert.equal(r.sent, 0);
  assert.equal(r.failed, 1);
  assert.equal(buf.queue.length, 0, '失败的批次不留到下次，分析不能拖住核心功能');
});

test('关掉开关会丢弃没发出去的队列', () => {
  const buf = new EventBuffer({ send: async () => {}, enabled: true });
  buf.track('session_started', { at: T });
  assert.equal(buf.queue.length, 1);
  buf.setEnabled(false);
  assert.equal(buf.queue.length, 0);
  assert.equal(buf.track('session_started', { at: T }), null);
});

test('空队列 flush 不会发空请求', async () => {
  let calls = 0;
  const buf = new EventBuffer({ send: async () => { calls++; }, enabled: true });
  assert.deepEqual(await buf.flush(), { sent: 0 });
  assert.equal(calls, 0);
});
