import test from 'node:test';
import assert from 'node:assert/strict';
import {
  V2_KEY, V1_KEY, V1_HKEY, BACKUP_PREFIX, CONFLICT_KEY, SETTINGS_KEY,
  accountKey, stateKeyFor, loadLocalState, saveLocalState, readLocalState,
  signOut, clearGuestSlot, hasRecords, saveConflict, loadConflict, clearConflict,
  loadSettings, saveSettings, normalizeSettings, DEFAULT_SETTINGS, buildExport, removeKey
} from '../storage.js';
import { createState, startPlanned, decide, openReassessment } from '../../core/index.js';

// 内存 localStorage 桩：只需要 getItem/setItem/removeItem 三个方法。
function memStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    _m: m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    keys: () => [...m.keys()]
  };
}

const fixedCtx = (() => {
  let n = 0;
  return { now: () => 1700000000000, idGen: () => 'id' + (++n) };
})();

// v1 的真实形态，取自迁移前 public/index.html 的 KEY / HKEY 写入
const V1_HISTORY = [
  {
    id: 'h_1', name: '比价', end: 1699999000000, total: 1800000, rounds: 2,
    doneAt: 1699999000000, decision: 'switched', note: '不比了', hypothesis: '差价 20 元内就买',
    sessions: [
      { doneAt: 1699998000000, duration: 900000, decision: 'completed', note: '' },
      { doneAt: 1699999000000, duration: 900000, decision: 'switched', note: '不比了' }
    ]
  },
  { id: 'h_2', name: '比价', end: 1699997000000, total: 600000, rounds: 1, doneAt: 1699997000000, decision: 'completed', note: '' }
];
const V1_ITEMS = [{ name: '排查日志', end: 1700000600000, total: 600000, prevTotal: 0, rounds: 1, hypothesis: '' }];

test('首次加载：只有旧 KEY/HKEY 时迁移，旧键仍在，并留一份 sl.v1.backup 快照', () => {
  const s = memStorage({
    [V1_KEY]: JSON.stringify(V1_ITEMS),
    [V1_HKEY]: JSON.stringify(V1_HISTORY)
  });
  const r = loadLocalState(s, { ctx: fixedCtx });
  assert.equal(r.migrated, true);
  assert.equal(r.key, V2_KEY);
  assert.equal(r.state.schemaVersion, 2);
  // 同名两条 history 不合并
  assert.equal(r.state.tasks.filter(t => t.name === '比价').length, 2);
  // 旧键保留（回退路径），一个都不许删
  assert.equal(s.getItem(V1_KEY), JSON.stringify(V1_ITEMS));
  assert.equal(s.getItem(V1_HKEY), JSON.stringify(V1_HISTORY));
  // 快照写到了 sl.v1.backup.{ts}，内容就是原样的 v1
  const backupKeys = s.keys().filter(k => k.startsWith(BACKUP_PREFIX));
  assert.equal(backupKeys.length, 1);
  assert.equal(r.backupKey, backupKeys[0]);
  const backup = JSON.parse(s.getItem(backupKeys[0]));
  assert.equal(backup.version, 1);
  assert.deepEqual(backup.items, V1_ITEMS);
  assert.deepEqual(backup.history, V1_HISTORY);
  // 迁移结果已落到 sl.v2
  assert.equal(JSON.parse(s.getItem(V2_KEY)).schemaVersion, 2);
});

test('迁移出的旧轮次带 legacyPlanned，能在 UI 上标成「旧版计划用时」', () => {
  const s = memStorage({ [V1_HKEY]: JSON.stringify(V1_HISTORY) });
  const { state } = loadLocalState(s, { ctx: fixedCtx });
  const legacy = state.sessions.filter(x => x.legacyPlanned === true);
  assert.equal(legacy.length, state.sessions.length);
  assert.ok(legacy.every(x => x.startedAt === undefined), '没有真实开始时刻就不补造');
});

test('已有 sl.v2 时不再迁移，也不重复写快照', () => {
  const st = createState({}, fixedCtx);
  const s = memStorage({
    [V2_KEY]: JSON.stringify(st),
    [V1_KEY]: JSON.stringify(V1_ITEMS),
    [V1_HKEY]: JSON.stringify(V1_HISTORY)
  });
  const r = loadLocalState(s, { ctx: fixedCtx });
  assert.equal(r.migrated, false);
  assert.equal(r.backupKey, null);
  assert.equal(s.keys().filter(k => k.startsWith(BACKUP_PREFIX)).length, 0);
});

test('都没有数据时给空 state，不写任何键', () => {
  const s = memStorage({});
  const r = loadLocalState(s, { ctx: fixedCtx });
  assert.equal(r.migrated, false);
  assert.equal(hasRecords(r.state), false);
  assert.equal(s.keys().length, 0);
});

test('坏掉的 JSON 不炸，按没有数据处理', () => {
  const s = memStorage({ [V2_KEY]: '{不是 json', [V1_HKEY]: '[[[' });
  const r = loadLocalState(s, { ctx: fixedCtx });
  assert.equal(r.state.schemaVersion, 2);
  assert.equal(hasRecords(r.state), false);
});

test('账户快照与访客快照互相隔离，登录不去捡旧的 v1 键', () => {
  const s = memStorage({ [V1_HKEY]: JSON.stringify(V1_HISTORY) });
  assert.equal(stateKeyFor(''), V2_KEY);
  assert.equal(stateKeyFor('ann'), accountKey('ann'));
  const r = loadLocalState(s, { user: 'ann', ctx: fixedCtx });
  assert.equal(r.migrated, false);
  assert.equal(hasRecords(r.state), false, '账户槽不应吞掉访客的旧数据');
});

test('退出账号清该账户快照与 token，不动访客槽与其它账户', () => {
  const guest = createState({ updatedAt: 1 }, fixedCtx);
  const s = memStorage({
    [V2_KEY]: JSON.stringify(guest),
    [accountKey('ann')]: JSON.stringify(createState({ updatedAt: 2 }, fixedCtx)),
    [accountKey('bob')]: JSON.stringify(createState({ updatedAt: 3 }, fixedCtx)),
    'sl.token': 'tok', 'sl.user': 'ann'
  });
  const empty = signOut(s, 'ann', fixedCtx);
  assert.equal(s.getItem(accountKey('ann')), null);
  assert.notEqual(s.getItem(accountKey('bob')), null);
  assert.notEqual(s.getItem(V2_KEY), null, '访客槽不是账户数据，退出不该动它');
  assert.equal(s.getItem('sl.token'), null);
  assert.equal(s.getItem('sl.user'), null);
  assert.equal(hasRecords(empty), false);
});

test('登录处理完访客数据后清空访客槽，账户数据不留给访客', () => {
  const s = memStorage({ [V2_KEY]: JSON.stringify(createState({}, fixedCtx)) });
  clearGuestSlot(s);
  assert.equal(s.getItem(V2_KEY), null);
});

test('saveLocalState / readLocalState 按当前身份走对应的键', () => {
  const s = memStorage({});
  const a = startPlanned(createState({}, fixedCtx), { name: '甲', plannedMs: 60000 }, fixedCtx).state;
  saveLocalState(s, a, 'ann');
  assert.equal(readLocalState(s, ''), null);
  assert.equal(readLocalState(s, 'ann').tasks.length, 1);
});

test('冲突副本存得进、读得出、清得掉', () => {
  const s = memStorage({});
  const rec = { at: 1, localRev: 3, serverRev: 5, local: null, server: null };
  saveConflict(s, rec);
  assert.deepEqual(loadConflict(s), rec);
  assert.equal(s.getItem(CONFLICT_KEY) !== null, true);
  clearConflict(s);
  assert.equal(loadConflict(s), null);
});

test('设置：默认匿名统计关闭、提醒上限 3 次间隔 60 秒，越界值夹回档位', () => {
  const s = memStorage({});
  assert.deepEqual(loadSettings(s), { ...DEFAULT_SETTINGS });
  assert.equal(DEFAULT_SETTINGS.analytics, false);
  assert.equal(DEFAULT_SETTINGS.reminderMaxAlerts, 3);
  assert.equal(DEFAULT_SETTINGS.reminderIntervalMs, 60000);

  saveSettings(s, { reminderMaxAlerts: 99, reminderIntervalMs: 1, muted: 'yes', analytics: true, locale: 'fr' });
  const got = loadSettings(s);
  assert.equal(got.reminderMaxAlerts, 10);
  assert.equal(got.reminderIntervalMs, 10000);
  assert.equal(got.muted, false, '非 true 的值不当成开启');
  assert.equal(got.analytics, true);
  assert.equal(got.locale, 'zh-CN');
  assert.equal(s.getItem(SETTINGS_KEY) !== null, true);
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
});

test('导出整包：带 legacy 原始快照，文件名带时间戳', () => {
  const s0 = createState({}, fixedCtx);
  const started = startPlanned(s0, { name: '比价', plannedMs: 60000 }, fixedCtx);
  const { draft } = openReassessment(started.state, { taskId: started.task.taskId }, fixedCtx);
  const after = decide(started.state, { ...draft, kind: 'stop', note: '够了' }, fixedCtx).state;
  const withLegacy = { ...after, legacy: { version: 1, capturedAt: 1, items: V1_ITEMS, history: V1_HISTORY } };

  const out = buildExport(withLegacy, { at: Date.UTC(2026, 8, 13, 4, 5, 6), prefix: 'x' });
  assert.match(out.filename, /^x-\d{8}-\d{6}\.json$/);
  assert.equal(out.mime, 'application/json');
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.data.decisions.length, 1);
  assert.deepEqual(parsed.data.legacy.history, V1_HISTORY, '导出必须带上旧版原始快照');
});

test('removeKey 对不存在的键也安全', () => {
  const s = memStorage({});
  assert.equal(removeKey(s, 'nope'), true);
});
