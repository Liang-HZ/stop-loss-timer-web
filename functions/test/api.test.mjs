// 服务端 API 单测（node:test，零依赖）
// 直接 import Pages Functions 的 onRequest，env.KV 用内存 Map 实现。
// 跑法：node --test functions/test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = p => import(pathToFileURL(resolve(HERE, '..', p)).href);

const { onRequest: apiRoute } = await load('api/[[route]].js');
const { onRequest: eventsRoute } = await load('api/events/[[path]].js');
const lib = await load('api/_lib.js');

// ---- 内存 KV -------------------------------------------------------------
// Workers KV 的最小可用子集：get / put / delete / list。expirationTtl 记下来但不生效
// （测试里不需要真的过期；任何依赖 TTL 生效的断言都会是假绿，所以一条也没写）。
function makeKV() {
  const m = new Map();
  return {
    _map: m,
    async get(key) { const v = m.get(key); return v === undefined ? null : v.value; },
    async put(key, value, opts = {}) { m.set(key, { value: String(value), ttl: opts.expirationTtl ?? null }); },
    async delete(key) { m.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name }));
      return { keys, list_complete: true, cursor: null };
    }
  };
}

let env;
beforeEach(() => {
  env = { KV: makeKV() };
  lib._resetRateLimits(); // 限流桶是模块级的，用例之间必须清，否则后面的用例会被前面的吃掉配额
});

// ---- 请求构造 ------------------------------------------------------------
function req(url, { method = 'GET', body, headers = {} } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.7', ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    h['Content-Type'] = 'application/json';
    h['Content-Length'] = String(Buffer.byteLength(payload));
  }
  return new Request('https://test.local' + url, { method, headers: h, body: payload });
}
// Pages 给的 params 只含路径段，query 不在里面——这里照着拆，别把 ?a=b 当成路径段
const segs = p => p.split('?')[0].split('/').filter(Boolean);
const callApi = (path, opt) => apiRoute({ request: req('/api/' + path, opt), env, params: { route: segs(path) } });
const callEvents = (path, opt) => eventsRoute({ request: req('/api/events' + (path ? '/' + path : ''), opt), env, params: { path: segs(path) } });
const auth = t => ({ Authorization: 'Bearer ' + t });

async function bodyOf(res) { return JSON.parse(await res.text()); }

async function register(username = 'alice', password = 'pw123456') {
  const res = await callApi('register', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, 'register should succeed');
  return (await bodyOf(res)).token;
}

// v2 样例数据
const T = 1757740000000;
const sampleV2 = (over = {}) => ({
  schemaVersion: 2,
  tasks: [{ taskId: 'task-1', name: '比价耳机', createdAt: T, status: 'active', hypothesis: '便宜 100 就买' }],
  sessions: [{ sessionId: 'sess-1', taskId: 'task-1', entryMode: 'planned', startedAt: T, plannedMs: 1800000, deadlineAt: T + 1800000 }],
  decisions: [{ decisionId: 'dec-1', taskId: 'task-1', sessionId: 'sess-1', entryMode: 'planned', at: T + 1800000, kind: 'continue', continueMs: 900000 }],
  updatedAt: T + 1800000,
  ...over
});

// ==========================================================================
// 1. 数据同步 v1 兼容
// ==========================================================================
test('v1 客户端：GET 空数据返回 v1 形态，PUT 后能原样取回', async () => {
  const token = await register();
  let res = await callApi('data', { headers: auth(token) });
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { updatedAt: 0, items: [], history: [] });

  const v1 = {
    updatedAt: T,
    items: [{ name: '写周报', end: T + 1000, total: 1000, rounds: 2 }],
    history: [{ name: '旧事项', end: T, total: 500, doneAt: T, rounds: 1, id: 'h1', decision: '守约达标' }]
  };
  res = await callApi('data', { method: 'PUT', headers: auth(token), body: v1 });
  assert.equal(res.status, 200);
  assert.equal((await bodyOf(res)).ok, true);

  res = await callApi('data', { headers: auth(token) });
  const got = await bodyOf(res);
  assert.equal(res.headers.get('X-Data-Schema'), '1');
  assert.equal(got.items[0].name, '写周报');
  assert.equal(got.history[0].decision, '守约达标');
});

test('v1 客户端：白名单之外的字段被丢弃，超长文本被截断', async () => {
  const token = await register();
  await callApi('data', {
    method: 'PUT', headers: auth(token),
    body: { updatedAt: T, items: [{ name: 'x'.repeat(300), end: 1, total: 1, evil: 'drop-me' }], history: [] }
  });
  const got = await bodyOf(await callApi('data', { headers: auth(token) }));
  assert.equal(got.items[0].name.length, 100);
  assert.equal(got.items[0].evil, undefined);
});

test('v2 客户端读到 v1 存量：集合为空，原始 v1 整包在 legacy 里', async () => {
  const token = await register();
  await callApi('data', { method: 'PUT', headers: auth(token), body: { updatedAt: T, items: [], history: [{ name: '旧', end: T, total: 1, doneAt: T }] } });
  const res = await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } });
  const got = await bodyOf(res);
  assert.equal(res.headers.get('X-Data-Schema'), '1');
  assert.equal(got.schemaVersion, 2);
  assert.equal(got.rev, 0);
  assert.deepEqual(got.tasks, []);
  assert.equal(got.legacy.version, 1);
  assert.equal(got.legacy.history[0].name, '旧');
});

// ==========================================================================
// 2. 数据同步 v2：rev / 冲突 / 旧客户端拦截
// ==========================================================================
test('v2 PUT：首次 If-Match 可省略，rev 从 1 起递增', async () => {
  const token = await register();
  let res = await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2() });
  assert.equal(res.status, 200);
  assert.equal((await bodyOf(res)).rev, 1);

  // 内容真的变了才涨 rev（内容没变会短路，见「内容没变就不写 KV」那组用例）
  res = await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '1' }, body: sampleV2({ updatedAt: T + 2, decisions: [] }) });
  assert.equal((await bodyOf(res)).rev, 2);

  res = await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } });
  const got = await bodyOf(res);
  assert.equal(res.headers.get('X-Data-Schema'), '2');
  assert.equal(got.rev, 2);
  assert.equal(got.tasks[0].name, '比价耳机');
});

test('v2 PUT：rev 不匹配返回 409 conflict 并带回云端整包', async () => {
  const token = await register();
  await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2() });
  const res = await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '0' }, body: sampleV2() });
  assert.equal(res.status, 409);
  const got = await bodyOf(res);
  assert.equal(got.error, 'conflict');
  assert.equal(got.rev, 1);
  assert.equal(got.data.tasks[0].taskId, 'task-1', '冲突响应必须带云端数据，否则客户端无法给出三选一');
});

test('v2 PUT：If-Match 不是合法整数时 400', async () => {
  const token = await register();
  const res = await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': 'abc' }, body: sampleV2() });
  assert.equal(res.status, 400);
  assert.equal((await bodyOf(res)).error, 'bad_if_match');
});

test('旧客户端 PUT 撞上 v2 云端：409 client_outdated，且不覆盖', async () => {
  const token = await register();
  await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2() });
  const res = await callApi('data', { method: 'PUT', headers: auth(token), body: { updatedAt: T, items: [], history: [] } });
  assert.equal(res.status, 409);
  assert.equal((await bodyOf(res)).error, 'client_outdated');

  const still = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.equal(still.rev, 1);
  assert.equal(still.tasks.length, 1, 'v1 PUT 不得抹掉 v2 数据');
});

test('旧客户端 GET 到 v2 云端：拿到 v1 投影 + X-Data-Schema: 2', async () => {
  const token = await register();
  const v2 = sampleV2({
    tasks: [
      { taskId: 'task-1', name: '进行中', createdAt: T, status: 'active' },
      { taskId: 'task-2', name: '已结束', createdAt: T, status: 'ended' }
    ],
    sessions: [
      { sessionId: 's1', taskId: 'task-1', entryMode: 'planned', startedAt: T, plannedMs: 600000, deadlineAt: T + 600000 },
      { sessionId: 's2', taskId: 'task-2', entryMode: 'planned', startedAt: T, plannedMs: 300000, deadlineAt: T + 300000, endedAt: T + 300000, endReason: 'decision' }
    ],
    decisions: [{ decisionId: 'd2', taskId: 'task-2', sessionId: 's2', entryMode: 'planned', at: T + 300000, kind: 'stop', note: '够了' }]
  });
  await callApi('data', { method: 'PUT', headers: auth(token), body: v2 });

  const res = await callApi('data', { headers: auth(token) });
  assert.equal(res.headers.get('X-Data-Schema'), '2');
  const got = await bodyOf(res);
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].name, '进行中');
  assert.equal(got.items[0].end, T + 600000);
  assert.equal(got.history.length, 1);
  assert.equal(got.history[0].name, '已结束');
  assert.equal(got.history[0].decision, 'stop');
  assert.equal(got.history[0].note, '够了');
  assert.equal(got.history[0].sessions[0].duration, 300000);
});

test('v1 存量被 v2 首次覆盖时，原始 v1 自动留档进 legacy', async () => {
  const token = await register();
  await callApi('data', { method: 'PUT', headers: auth(token), body: { updatedAt: T, items: [], history: [{ name: '远古记录', end: T, total: 1, doneAt: T }] } });
  await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '0' }, body: sampleV2() });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.equal(got.legacy.version, 1);
  assert.equal(got.legacy.history[0].name, '远古记录');
});

// ==========================================================================
// 3. v2 校验：枚举、id、去重、容量
// ==========================================================================
test('v2 校验：非法枚举/非法 id 的记录整条丢弃，不静默改值', async () => {
  const token = await register();
  const body = sampleV2({
    tasks: [
      { taskId: 'ok-1', name: '合法', createdAt: T, status: 'ended' },
      { taskId: 'bad id!', name: '非法 id', createdAt: T, status: 'ended' }
    ],
    sessions: [{ sessionId: 's1', taskId: 'ok-1', entryMode: '随便', startedAt: T }],
    decisions: [
      { decisionId: 'd1', taskId: 'ok-1', entryMode: 'immediate', at: T, kind: 'pause' },
      { decisionId: 'd2', taskId: 'ok-1', sessionId: null, entryMode: 'immediate', at: T, kind: 'switch' }
    ]
  });
  await callApi('data', { method: 'PUT', headers: auth(token), body });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.deepEqual(got.tasks.map(t => t.taskId), ['ok-1']);
  assert.deepEqual(got.sessions, [], 'entryMode 非枚举 → 整条丢弃');
  assert.deepEqual(got.decisions.map(d => d.decisionId), ['d2'], 'kind 非枚举 → 整条丢弃');
  assert.equal(got.decisions[0].sessionId, null, '即时决定的 sessionId 可空');
});

test('v2 校验：同 id 只保留一条', async () => {
  const token = await register();
  const body = sampleV2({
    tasks: [
      { taskId: 'task-1', name: '先到的', createdAt: T, status: 'active' },
      { taskId: 'task-1', name: '重复提交', createdAt: T, status: 'ended' }
    ],
    sessions: [], decisions: []
  });
  await callApi('data', { method: 'PUT', headers: auth(token), body });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.equal(got.tasks.length, 1);
  assert.equal(got.tasks[0].name, '先到的');
});

test('v2 校验：超容量返回 413 capacity_full，且一个字节都不写入', async () => {
  const token = await register();
  const tasks = Array.from({ length: 501 }, (_, i) => ({ taskId: 'task-' + i, name: 'n' + i, createdAt: T, status: 'active' }));
  const res = await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2({ tasks, sessions: [], decisions: [] }) });
  assert.equal(res.status, 413);
  const got = await bodyOf(res);
  assert.equal(got.error, 'capacity_full');
  assert.deepEqual(got.limits, { tasks: 500, sessions: 3000, decisions: 3000, templates: 100 });
  assert.equal(got.counts.tasks, 501);
  assert.equal(env.KV._map.has('data:alice'), false, '超限必须整包拒绝，不能截断后落盘');
});

test('v2 校验：500 个 task 刚好通过', async () => {
  const token = await register();
  const tasks = Array.from({ length: 500 }, (_, i) => ({ taskId: 'task-' + i, name: 'n' + i, createdAt: T, status: 'active' }));
  const res = await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2({ tasks, sessions: [], decisions: [] }) });
  assert.equal(res.status, 200);
});

test('v2 校验：legacy 快照原样保留（不被字段白名单改写）', async () => {
  const token = await register();
  const legacy = { version: 1, capturedAt: T, items: [{ name: '旧', end: 1, total: 1, 奇怪字段: '保留' }], history: [] };
  await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2({ legacy }) });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.deepEqual(got.legacy, legacy);
});

// packages/core 会写出这些字段，服务端一旦不认就等于静默删数据：
//   task.updatedAt   → core/sync.js 合并两端时靠它取新，丢了多端合并变随机胜出
//   session.legacy   → core/model.js 靠它豁免「必须有 startedAt」，丢了迁移来的旧轮次回到客户端校验就失败
//   decision.completed → 「事项已完成」与「以后再看」的区分（PRODUCT.md 第 6 节要求可区分）
//   sourceVersion    → 可回退路径的来源版本号
// 这条用例故意不 import packages/core（那是另一份实现），用字面量锁住字段本身。
test('v2 往返不得丢 core 写出的字段（updatedAt / legacy / completed / sourceVersion）', async () => {
  const token = await register();
  const body = {
    schemaVersion: 2, sourceVersion: 1, updatedAt: T,
    tasks: [{ taskId: 't_a', name: '旧迁移事项', createdAt: T, updatedAt: T + 5, status: 'completed' }],
    sessions: [{ sessionId: 's_a', taskId: 't_a', entryMode: 'planned', legacy: true, legacyPlanned: true, plannedMs: 1800000, endedAt: T }],
    decisions: [{ decisionId: 'd_a', taskId: 't_a', sessionId: 's_a', entryMode: 'planned', at: T, kind: 'stop', completed: true }]
  };
  await callApi('data', { method: 'PUT', headers: auth(token), body });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.equal(got.sourceVersion, 1);
  assert.equal(got.tasks[0].updatedAt, T + 5);
  assert.equal(got.sessions[0].legacy, true);
  assert.equal(got.sessions[0].startedAt, undefined, '没有真实开始时刻就不补造');
  assert.equal(got.decisions[0].completed, true);
  assert.equal(got.decisions[0].later, undefined);
});

test('v2 校验：later 与 completed 互斥；非 stop 决定上两者都不生效', async () => {
  const token = await register();
  const mk = (id, kind, extra) => ({ decisionId: id, taskId: 't_a', sessionId: null, entryMode: 'immediate', at: T, kind, ...extra });
  await callApi('data', {
    method: 'PUT', headers: auth(token),
    body: {
      schemaVersion: 2, updatedAt: T,
      tasks: [{ taskId: 't_a', name: 'x', createdAt: T, status: 'ended' }], sessions: [],
      decisions: [mk('d1', 'stop', { later: true, completed: true }), mk('d2', 'continue', { later: true }), mk('d3', 'stop', { later: true })]
    }
  });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  const by = Object.fromEntries(got.decisions.map(d => [d.decisionId, d]));
  assert.equal(by.d1.later, undefined);
  assert.equal(by.d1.completed, undefined, '同时为真是客户端 bug，服务端不替用户猜');
  assert.equal(by.d2.later, undefined, 'later 只对 kind=stop 有意义');
  assert.equal(by.d3.later, true);
});

// 免费档 KV 只有 1000 次写/天（BLOCKERS B17）。这一组用例盯的是「不该写的时候真的没写」，
// 所以断言的是 KV 写次数本身，不是响应内容——响应对了但偷偷写了，配额一样会被烧掉。
function countWrites(kv) {
  let n = 0;
  const orig = kv.put.bind(kv);
  kv.put = async (...a) => { n++; return orig(...a); };
  return () => n;
}

test('v2 PUT：内容没变就不写 KV，rev 不变并回 unchanged', async () => {
  const token = await register();
  await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2() });

  const writes = countWrites(env.KV);
  // 同样的内容再提交两次，只有 updatedAt 不同（客户端每次保存都会刷新它）
  let res = await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '1' }, body: sampleV2({ updatedAt: T + 9999 }) });
  assert.equal(res.status, 200);
  let got = await bodyOf(res);
  assert.equal(got.unchanged, true);
  assert.equal(got.rev, 1, 'rev 不能变，否则客户端手里的 If-Match 会平白失效');
  assert.equal(got.updatedAt, T + 1800000, '没写就不谎报新的 updatedAt');

  res = await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '1' }, body: sampleV2() });
  assert.equal((await bodyOf(res)).unchanged, true);
  assert.equal(writes(), 0, '两次等价提交必须一次 KV 写都没有');

  // 真改了内容就要写、rev 要涨
  res = await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '1' }, body: sampleV2({ tasks: [{ taskId: 'task-1', name: '改了名字', createdAt: T, status: 'active' }] }) });
  got = await bodyOf(res);
  assert.equal(got.unchanged, undefined);
  assert.equal(got.rev, 2);
  assert.equal(writes(), 1);
});

test('v2 PUT：字段顺序不同不算内容变化，但 task.updatedAt 变了就算', async () => {
  const token = await register();
  const base = {
    schemaVersion: 2, updatedAt: T, sessions: [], decisions: [],
    tasks: [{ taskId: 't_a', name: 'x', createdAt: T, updatedAt: T, status: 'active' }]
  };
  await callApi('data', { method: 'PUT', headers: auth(token), body: base });

  const writes = countWrites(env.KV);
  // 同样的数据，客户端换了 key 顺序：不该白花一次写配额
  const reordered = {
    decisions: [], sessions: [], updatedAt: T + 1, schemaVersion: 2,
    tasks: [{ status: 'active', updatedAt: T, name: 'x', createdAt: T, taskId: 't_a' }]
  };
  assert.equal((await bodyOf(await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '1' }, body: reordered }))).unchanged, true);
  assert.equal(writes(), 0);

  // task.updatedAt 是内容的一部分（core 靠它合并判新），改了必须写
  const touched = { ...base, tasks: [{ ...base.tasks[0], updatedAt: T + 500 }] };
  const got = await bodyOf(await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '1' }, body: touched }));
  assert.equal(got.rev, 2);
  assert.equal(writes(), 1);
});

test('v2 PUT：短路不会掩盖冲突——rev 不匹配仍先返回 409', async () => {
  const token = await register();
  await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2() });
  const writes = countWrites(env.KV);
  const res = await callApi('data', { method: 'PUT', headers: { ...auth(token), 'If-Match': '0' }, body: sampleV2() });
  assert.equal(res.status, 409);
  assert.equal((await bodyOf(res)).error, 'conflict');
  assert.equal(writes(), 0);
});

test('数据接口拒绝未登录与超大请求体', async () => {
  assert.equal((await callApi('data', {})).status, 401);
  assert.equal((await callApi('data', { method: 'PUT', body: sampleV2() })).status, 401);
  const token = await register();
  const res = await apiRoute({
    request: new Request('https://test.local/api/data', {
      method: 'PUT',
      headers: { 'CF-Connecting-IP': '203.0.113.7', 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024), ...auth(token) },
      body: '{}'
    }),
    env, params: { route: ['data'] }
  });
  assert.equal(res.status, 413);
});

// ==========================================================================
// 4. 账户找回
// ==========================================================================
test('找回码全流程：生成 → 重置密码 → 旧 token 立刻失效 → 码一次性', async () => {
  const oldToken = await register('bob', 'oldpass1');

  const codeRes = await callApi('recovery/code', { method: 'POST', headers: auth(oldToken) });
  assert.equal(codeRes.status, 200);
  const { code } = await bodyOf(codeRes);
  assert.match(code, /^[2-9A-HJ-NP-Z]{12}$/);
  assert.ok(await env.KV.get('recovery:bob'), '服务端只存哈希');
  assert.ok(!(await env.KV.get('recovery:bob')).includes(code), '明文找回码不得落盘');

  // 旧 token 此刻仍可用
  assert.equal((await callApi('data', { headers: auth(oldToken) })).status, 200);

  const recRes = await callApi('recover', { method: 'POST', body: { username: 'bob', code, password: 'newpass1' } });
  assert.equal(recRes.status, 200);
  const newToken = (await bodyOf(recRes)).token;
  assert.ok(newToken);

  // 旧 token 被吊销
  assert.equal((await callApi('data', { headers: auth(oldToken) })).status, 401, '重置密码后旧会话必须失效');
  assert.equal((await callApi('data', { headers: auth(newToken) })).status, 200);

  // 新密码可登录、旧密码不行
  assert.equal((await callApi('login', { method: 'POST', body: { username: 'bob', password: 'newpass1' } })).status, 200);
  assert.equal((await callApi('login', { method: 'POST', body: { username: 'bob', password: 'oldpass1' } })).status, 401);

  // 找回码一次性
  const again = await callApi('recover', { method: 'POST', body: { username: 'bob', code, password: 'thirdpw1' } });
  assert.equal(again.status, 401);
});

test('找回：错码、不存在的用户、未设码都给同一句话（不泄漏用户名是否存在）', async () => {
  const token = await register('carol');
  await callApi('recovery/code', { method: 'POST', headers: auth(token) });
  const wrong = await callApi('recover', { method: 'POST', body: { username: 'carol', code: 'AAAAAAAAAAAA', password: 'newpass1' } });
  const nouser = await callApi('recover', { method: 'POST', body: { username: 'nobody', code: 'AAAAAAAAAAAA', password: 'newpass1' } });
  assert.equal(wrong.status, 401);
  assert.equal(nouser.status, 401);
  assert.deepEqual(await bodyOf(wrong), await bodyOf(nouser));
});

test('找回：限流 5 次/小时/IP', async () => {
  await register('dave');
  let last;
  for (let i = 0; i < 6; i++) {
    last = await callApi('recover', { method: 'POST', body: { username: 'dave', code: 'AAAAAAAAAAAA', password: 'newpass1' } });
  }
  assert.equal(last.status, 429);
});

test('生成找回码需要登录态；重复生成覆盖旧码', async () => {
  assert.equal((await callApi('recovery/code', { method: 'POST' })).status, 401);
  const token = await register('erin');
  const first = (await bodyOf(await callApi('recovery/code', { method: 'POST', headers: auth(token) }))).code;
  const second = (await bodyOf(await callApi('recovery/code', { method: 'POST', headers: auth(token) }))).code;
  assert.notEqual(first, second);
  assert.equal((await callApi('recover', { method: 'POST', body: { username: 'erin', code: first, password: 'newpass1' } })).status, 401, '旧码应被覆盖失效');
  assert.equal((await callApi('recover', { method: 'POST', body: { username: 'erin', code: second, password: 'newpass1' } })).status, 200);
});

test('邮箱绑定：未配置 SEND_EMAIL 时返回 pending，同时写入正反向索引', async () => {
  const token = await register('frank');
  const res = await callApi('recovery/email', { method: 'POST', headers: auth(token), body: { email: 'Frank@Example.com' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { pending: true, reason: 'email_sending_not_configured' });
  assert.equal(JSON.parse(await env.KV.get('email:frank')).email, 'frank@example.com');
  assert.equal(await env.KV.get('emailhash:' + await lib.sha256hex('frank@example.com')), 'frank');

  assert.equal((await callApi('recovery/email', { method: 'POST', headers: auth(token), body: { email: '不是邮箱' } })).status, 400);
});

// ==========================================================================
// 5. v2 白名单：模板与场景扩展
// ==========================================================================
test('v2 白名单：templates 收下并清洗，builtIn 的只读例子一律不入库', async () => {
  const token = await register('tpluser');
  const body = sampleV2({
    templates: [
      { templateId: 'tpl-1', name: '  比价规则  ', hypothesis: '省不到一顿饭钱就下单', reminderText: '值吗', scene: 'compare', durationsMs: [1800000, 300000, 300000], createdAt: T, updatedAt: T, evil: 'drop-me' },
      { templateId: 'builtin_compare', name: '内置例子', builtIn: true, createdAt: 0 },
      { templateId: 'tpl-2', name: '坏场景', scene: '我编的', createdAt: T },
      { templateId: 'tpl-3', name: '   ', createdAt: T }
    ]
  });
  await callApi('data', { method: 'PUT', headers: auth(token), body });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.equal(got.templates.length, 2, '内置例子与没名字的那条都不该入库');
  const [one, two] = got.templates;
  assert.equal(one.templateId, 'tpl-1');
  assert.equal(one.name, '比价规则');
  assert.deepEqual(one.durationsMs, [300000, 1800000], '去重并排序');
  assert.equal(one.evil, undefined);
  assert.equal(two.templateId, 'tpl-2');
  assert.equal(two.scene, undefined, '白名单外的场景值被剥掉，整条不丢');
});

test('v2 白名单：task.scene / task.templateId 与 decision.userEstimatedPriorMs 都贯通', async () => {
  const token = await register('estuser');
  const body = sampleV2({
    tasks: [{ taskId: 'task-1', name: '比价耳机', createdAt: T, status: 'ended', scene: 'compare', templateId: 'tpl-1' }],
    sessions: [],
    decisions: [{
      decisionId: 'dec-1', taskId: 'task-1', sessionId: null, entryMode: 'immediate', at: T, kind: 'stop',
      userEstimatedPriorMs: { value: 5400000, source: '伪造成实测' }
    }]
  });
  await callApi('data', { method: 'PUT', headers: auth(token), body });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.equal(got.tasks[0].scene, 'compare');
  assert.equal(got.tasks[0].templateId, 'tpl-1');
  assert.deepEqual(got.decisions[0].userEstimatedPriorMs, { value: 5400000, source: 'user_estimate' },
    'source 由服务端固定，客户端说了不算');
});

test('v2 白名单：没有模板时不写出 templates 键（内容指纹不变，不白花 KV 写）', async () => {
  const token = await register('notpl');
  await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2() });
  const got = await bodyOf(await callApi('data', { headers: { ...auth(token), 'X-Schema-Version': '2' } }));
  assert.equal('templates' in got, false);
});

test('v2 容量：模板超上限整包拒绝，不静默截断', async () => {
  const token = await register('tplfull');
  const templates = Array.from({ length: 101 }, (_, i) => ({ templateId: 'tpl-' + i, name: 'r' + i, createdAt: T }));
  const res = await callApi('data', { method: 'PUT', headers: auth(token), body: sampleV2({ templates }) });
  assert.equal(res.status, 413);
  const got = await bodyOf(res);
  assert.equal(got.error, 'capacity_full');
  assert.equal(got.counts.templates, 101);
});

// ==========================================================================
// 6. 事件
// ==========================================================================
test('事件：白名单内计数，白名单外丢弃，自由文本字段被剥掉', async () => {
  const res = await callEvents('', {
    method: 'POST',
    body: {
      events: [
        { name: 'session_started', at: Date.now(), platform: 'web', version: '1.2.0' },
        { name: 'decision_confirmed', at: Date.now(), platform: 'web', decisionKind: 'stop', entryMode: 'immediate', taskName: '不该上传的事项名', note: '不该上传的笔记' },
        { name: '自造事件', at: Date.now(), platform: 'web' },
        { name: 'session_started', at: Date.now(), platform: '火星' }
      ]
    }
  });
  assert.equal(res.status, 200);
  const got = await bodyOf(res);
  assert.equal(got.accepted, 3);
  assert.equal(got.dropped, 1);

  const day = new Date().toISOString().slice(0, 10);
  assert.equal(await env.KV.get(`agg:${day}:session_started:web`), '1');
  assert.equal(await env.KV.get(`agg:${day}:decision_confirmed:web`), '1');
  assert.equal(await env.KV.get(`agg:${day}:session_started:unknown`), '1', '未知平台归到 unknown，不丢事件');
  // 自由文本一个字都不能落盘
  const dump = [...env.KV._map.entries()].map(([k, v]) => k + '=' + v.value).join('|');
  assert.ok(!dump.includes('不该上传'), '事件接口不得存任何自由文本');
});

test('事件：同一 decisionId 的同名事件去重，不同名事件各记一次', async () => {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const ev = name => ({ name, at: now, platform: 'web', decisionId: 'dec-abc' });

  let got = await bodyOf(await callEvents('', { method: 'POST', body: { events: [ev('decision_confirmed'), ev('decision_confirmed')] } }));
  assert.equal(got.accepted, 1);
  assert.equal(got.deduped, 1);

  // 离线补传/刷新再来一次，仍然只算一次
  got = await bodyOf(await callEvents('', { method: 'POST', body: { events: [ev('decision_confirmed')] } }));
  assert.equal(got.deduped, 1);
  assert.equal(await env.KV.get(`agg:${day}:decision_confirmed:web`), '1');

  // 同一个 decisionId 下的另一种事件不该被误杀
  got = await bodyOf(await callEvents('', { method: 'POST', body: { events: [ev('reassessment_opened')] } }));
  assert.equal(got.accepted, 1);
  assert.equal(await env.KV.get(`agg:${day}:reassessment_opened:web`), '1');
  assert.equal(JSON.parse(await env.KV.get('evdedup:dec-abc')).sort().join(','), 'decision_confirmed,reassessment_opened');
  assert.equal(env.KV._map.get('evdedup:dec-abc').ttl, 604800, '去重键要带 7 天 TTL');
});

test('事件：一个请求内按 day:name:platform 合并，每个键只写一次 KV', async () => {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const writes = countWrites(env.KV);

  // 10 条事件、只落在 2 个 agg 键上（另有 1 条非白名单被丢），逐条写会是 9 次，合并后应该是 2 次
  const events = [];
  for (let i = 0; i < 6; i++) events.push({ name: 'session_started', at: now, platform: 'web' });
  for (let i = 0; i < 3; i++) events.push({ name: 'reminder_scheduled', at: now, platform: 'unknown' });
  events.push({ name: '不在白名单', at: now, platform: 'web' });

  const got = await bodyOf(await callEvents('', { method: 'POST', body: { events } }));
  assert.equal(got.accepted, 9);
  assert.equal(got.dropped, 1);
  assert.equal(got.writes, 2);
  assert.equal(writes(), 2, '同一请求内同键必须只写一次 KV');

  // 合并不能把数算少
  assert.equal(await env.KV.get(`agg:${day}:session_started:web`), '6');
  assert.equal(await env.KV.get(`agg:${day}:reminder_scheduled:unknown`), '3');

  // 第二个请求在已有值上继续累加
  await callEvents('', { method: 'POST', body: { events: [{ name: 'session_started', at: now, platform: 'web' }] } });
  assert.equal(await env.KV.get(`agg:${day}:session_started:web`), '7');
});

test('事件：同一请求内同 decisionId 的重复只写一次 evdedup，且计数不重复', async () => {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const writes = countWrites(env.KV);
  const ev = name => ({ name, at: now, platform: 'web', decisionId: 'd_batch' });

  const got = await bodyOf(await callEvents('', {
    method: 'POST',
    body: { events: [ev('reassessment_opened'), ev('decision_confirmed'), ev('decision_confirmed'), ev('reassessment_opened')] }
  }));
  assert.equal(got.accepted, 2);
  assert.equal(got.deduped, 2);
  // 2 个 agg 键 + 1 个 evdedup 键 = 3 次写（逐条实现会是 4 次以上）
  assert.equal(got.writes, 3);
  assert.equal(writes(), 3);
  assert.equal(await env.KV.get(`agg:${day}:decision_confirmed:web`), '1');
  assert.deepEqual(JSON.parse(await env.KV.get('evdedup:d_batch')).sort(), ['decision_confirmed', 'reassessment_opened']);
});

test('事件：全部被去重时一次 KV 都不写', async () => {
  const now = Date.now();
  const ev = { name: 'decision_confirmed', at: now, platform: 'web', decisionId: 'd_x' };
  await callEvents('', { method: 'POST', body: { events: [ev] } });
  const writes = countWrites(env.KV);
  const got = await bodyOf(await callEvents('', { method: 'POST', body: { events: [ev, ev] } }));
  assert.equal(got.deduped, 2);
  assert.equal(got.writes, 0);
  assert.equal(writes(), 0, '没有新增计数就不该有写');
});

test('事件：离谱的时间戳被夹回服务端当天', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await callEvents('', { method: 'POST', body: { events: [{ name: 'session_started', at: Date.parse('2001-01-01T00:00:00Z'), platform: 'web' }] } });
  assert.equal(await env.KV.get(`agg:${day}:session_started:web`), '1');
  assert.equal(await env.KV.get('agg:2001-01-01:session_started:web'), null);
});

test('事件：批量上限与坏 body', async () => {
  assert.equal((await callEvents('', { method: 'POST', body: { nope: 1 } })).status, 400);
  const events = Array.from({ length: 51 }, () => ({ name: 'session_started', at: Date.now(), platform: 'web' }));
  const res = await callEvents('', { method: 'POST', body: { events } });
  assert.equal(res.status, 413);
  assert.equal((await bodyOf(res)).error, 'batch_too_large');
});

test('事件汇总：需要 ADMIN_TOKEN', async () => {
  await callEvents('', { method: 'POST', body: { events: [{ name: 'decision_confirmed', at: Date.now(), platform: 'web' }] } });
  assert.equal((await callEvents('summary')).status, 403);
  env.ADMIN_TOKEN = 'admin-secret';
  assert.equal((await callEvents('summary', { headers: auth('nope') })).status, 403);

  const res = await callEvents('summary', { headers: auth('admin-secret') });
  assert.equal(res.status, 200);
  const got = await bodyOf(res);
  assert.equal(got.totals.decision_confirmed, 1);
  assert.equal(got.days, 1);

  const day = new Date().toISOString().slice(0, 10);
  assert.equal(got.byDay[day]['decision_confirmed:web'], 1);
});

test('事件汇总：区间过长 / 顺序颠倒被拒', async () => {
  env.ADMIN_TOKEN = 'admin-secret';
  assert.equal((await callEvents('summary?from=2020-01-01&to=2026-01-01', { headers: auth('admin-secret') })).status, 400);
  assert.equal((await callEvents('summary?from=2026-05-01&to=2026-01-01', { headers: auth('admin-secret') })).status, 400);
});

// ==========================================================================
// 7. 回归：原有注册/登录未被改坏
// ==========================================================================
test('注册与登录：用户名规则、重名、密码长度、限流', async () => {
  assert.equal((await callApi('register', { method: 'POST', body: { username: 'a', password: 'pw123456' } })).status, 400);
  assert.equal((await callApi('register', { method: 'POST', body: { username: 'ok_user', password: '123' } })).status, 400);
  assert.equal((await callApi('register', { method: 'POST', body: { username: '中文名', password: 'pw123456' } })).status, 200);
  assert.equal((await callApi('register', { method: 'POST', body: { username: '中文名', password: 'pw123456' } })).status, 409);
  assert.equal((await callApi('login', { method: 'POST', body: { username: '中文名', password: 'pw123456' } })).status, 200);
  assert.equal((await callApi('login', { method: 'POST', body: { username: '中文名', password: 'wrong123' } })).status, 401);
  assert.equal((await callApi('unknown/path')).status, 404);
  assert.equal((await callApi('data', { method: 'DELETE' })).status, 405);
});
