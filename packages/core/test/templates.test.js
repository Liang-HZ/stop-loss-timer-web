// 个人重评规则（Pro）与 Decision 上的用户估计值：契约层面的用例。
// 对应 docs/product/PRODUCT.md 第 4 节权益表与第 6 节「时间记录」不变量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, MIN } from './helpers.js';
import {
  createState, createDecision, createTemplate, validateTemplate, validateState, assertValidState,
  saveTemplate, deleteTemplate, findTemplate, startPlanned, enterImmediate, decide, openReassessment,
  mergeStates, builtInTemplates, BUILTIN_TEMPLATE_SPECS, isBuiltInTemplateId,
  SCENES, TEMPLATE_DURATIONS_MAX, LIMITS, CapacityError, FlowError, toV1Projection, migrate
} from '../index.js';

test('新建 state 没有 templates 键：老数据的内容指纹不因为加字段而变', () => {
  const s = createState({});
  assert.equal('templates' in s, false);
  assert.equal(validateState(s).ok, true);
});

test('createTemplate：时长去重、排序、截断，场景走白名单', () => {
  const ctx = makeCtx();
  const tpl = createTemplate({
    name: '  比价  ',
    hypothesis: '省不到一顿饭钱就下单',
    reminderText: '省的钱值这些时间吗',
    scene: 'compare',
    durationsMs: [30 * MIN, 5 * MIN, 5 * MIN, 15 * MIN]
  }, ctx);
  assert.deepEqual(tpl.durationsMs, [5 * MIN, 15 * MIN, 30 * MIN]);
  assert.equal(tpl.name, '比价');
  assert.equal(tpl.scene, 'compare');

  const many = createTemplate({ name: 'x', durationsMs: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, ctx);
  assert.equal(many.durationsMs.length, TEMPLATE_DURATIONS_MAX);

  const bad = createTemplate({ name: 'x', scene: '编造的场景' }, ctx);
  assert.equal(bad.scene, undefined, '未知场景直接不落字段，不替用户猜一个');
});

test('模板必须有名字，场景必须在白名单里', () => {
  assert.equal(validateTemplate({ templateId: 't', name: '  ', createdAt: 0 }).ok, false);
  assert.equal(validateTemplate({ templateId: 't', name: 'a', createdAt: 0, scene: 'nope' }).ok, false);
  assert.equal(validateTemplate({ templateId: 't', name: 'a', createdAt: 0, scene: 'other' }).ok, true);
  assert.ok(SCENES.includes('other'), '「其它／不填写」必须永远可选（ROADMAP 第 11 节）');
});

test('saveTemplate 新建与编辑：createdAt 不被编辑覆盖，updatedAt 跟着走', () => {
  const ctx = makeCtx();
  const a = saveTemplate(createState({}, ctx), { name: '比价', scene: 'compare', durationsMs: [5 * MIN] }, ctx);
  assert.equal(a.created, true);
  assert.equal(a.state.templates.length, 1);
  assert.equal(validateState(a.state).ok, true);

  ctx.advance(10 * MIN);
  const b = saveTemplate(a.state, { templateId: a.template.templateId, name: '比价（改）', durationsMs: [15 * MIN] }, ctx);
  assert.equal(b.created, false);
  assert.equal(b.state.templates.length, 1, '编辑不该再插一条');
  assert.equal(b.template.createdAt, a.template.createdAt);
  assert.equal(b.template.updatedAt, ctx.at);
  assert.equal(findTemplate(b.state, a.template.templateId).name, '比价（改）');
});

test('编辑不存在的模板报 not_found，不静默新建', () => {
  const ctx = makeCtx();
  assert.throws(() => saveTemplate(createState({}, ctx), { templateId: 'nope', name: 'x' }, ctx),
    e => e instanceof FlowError && e.code === 'not_found');
});

test('deleteTemplate 删掉规则，但不动已经用它开过的记录', () => {
  const ctx = makeCtx();
  const a = saveTemplate(createState({}, ctx), { name: '排查', scene: 'debug' }, ctx);
  const started = startPlanned(a.state, { name: '查线上报错', plannedMs: 30 * MIN, scene: 'debug', templateId: a.template.templateId }, ctx);
  assert.equal(started.task.scene, 'debug');
  assert.equal(started.task.templateId, a.template.templateId);

  const del = deleteTemplate(started.state, a.template.templateId, ctx);
  assert.deepEqual(del.state.templates, []);
  assert.equal(del.state.tasks[0].templateId, a.template.templateId, '历史记录里的来源线索保持原样');
  assert.equal(validateState(del.state).ok, true);
  assert.throws(() => deleteTemplate(del.state, a.template.templateId, ctx), e => e.code === 'not_found');
});

test('模板数量到上限时拒绝写入并抛 CapacityError，不静默截断', () => {
  const ctx = makeCtx();
  let s = createState({}, ctx);
  for (let i = 0; i < LIMITS.templates; i++) s = saveTemplate(s, { name: 'r' + i }, ctx).state;
  assert.equal(s.templates.length, LIMITS.templates);
  assert.throws(() => saveTemplate(s, { name: '再来一条' }, ctx), e => e instanceof CapacityError);
  // 已有的那条还能编辑：满仓不等于连改都不让改
  assert.doesNotThrow(() => saveTemplate(s, { templateId: s.templates[0].templateId, name: '改个名' }, ctx));
});

test('内置例子跨五个生活领域、只读、不写进 state', () => {
  assert.equal(BUILTIN_TEMPLATE_SPECS.length, 5);
  for (const locale of ['zh-CN', 'en']) {
    const list = builtInTemplates(locale);
    assert.equal(list.length, 5);
    for (const tpl of list) {
      assert.equal(validateTemplate(tpl).ok, true, locale + ' ' + tpl.templateId);
      assert.equal(tpl.builtIn, true);
      assert.ok(isBuiltInTemplateId(tpl.templateId));
      assert.ok(tpl.name && tpl.hypothesis && tpl.reminderText, '三段文案都要有：' + tpl.templateId);
      assert.ok(tpl.durationsMs.length >= 2);
    }
    const scenes = list.map(x => x.scene);
    assert.deepEqual(scenes, ['compare', 'stuck', 'detail', 'argue', 'debug']);
  }
  assert.notDeepEqual(builtInTemplates('zh-CN')[0].name, builtInTemplates('en')[0].name, '两套语言不是同一份文案');
});

test('两端合并保留双方各自的模板，同 id 取较新的一条', () => {
  const ctx = makeCtx();
  const a = saveTemplate(createState({}, ctx), { name: '本机 A' }, ctx);
  ctx.advance(MIN);
  const b = saveTemplate(createState({}, ctx), { name: '云端 B' }, ctx);
  const merged = mergeStates(a.state, b.state, ctx);
  assert.deepEqual(merged.templates.map(x => x.templateId).sort(), [a.template.templateId, b.template.templateId].sort());

  ctx.advance(MIN);
  const newer = saveTemplate(b.state, { templateId: b.template.templateId, name: '云端 B（新）' }, ctx).state;
  assert.equal(mergeStates(a.state, newer, ctx).templates.find(x => x.templateId === b.template.templateId).name, '云端 B（新）');
});

test('两边都没有模板时合并结果不凭空长出一个空数组', () => {
  const ctx = makeCtx();
  const merged = mergeStates(createState({}, ctx), createState({}, ctx), ctx);
  assert.equal('templates' in merged, false);
});

// ---- Decision.userEstimatedPriorMs -----------------------------------------

test('Decision 可以带用户估计的此前投入，source 固定为 user_estimate', () => {
  const ctx = makeCtx();
  const d = createDecision({ taskId: 't1', kind: 'stop', entryMode: 'immediate', userEstimatedPriorMs: { value: 40 * MIN } }, ctx);
  assert.deepEqual(d.userEstimatedPriorMs, { value: 40 * MIN, source: 'user_estimate' });
  // 也接受裸数字，便于 UI 直接传分钟换算后的毫秒
  const d2 = createDecision({ taskId: 't1', kind: 'stop', entryMode: 'immediate', userEstimatedPriorMs: 0 }, ctx);
  assert.deepEqual(d2.userEstimatedPriorMs, { value: 0, source: 'user_estimate' });
  // 不合法的值直接不落字段，不写成 NaN 或 null
  const d3 = createDecision({ taskId: 't1', kind: 'stop', entryMode: 'immediate', userEstimatedPriorMs: { value: '半小时' } }, ctx);
  assert.equal(d3.userEstimatedPriorMs, undefined);
});

test('即时入口不设短提醒时，估计值挂在决定上而不是伪造出一个计时轮次', () => {
  const ctx = makeCtx();
  const im = enterImmediate(createState({}, ctx), { name: '反复比价' }, ctx);
  assert.equal(im.session, null, '不设短提醒就不建 Session');
  const draft = openReassessment(im.state, { taskId: im.task.taskId }, ctx).draft;
  const out = decide(im.state, {
    decisionId: draft.decisionId, taskId: draft.taskId, entryMode: 'immediate',
    kind: 'stop', userEstimatedPriorMs: { value: 90 * MIN }
  }, ctx);
  assert.equal(out.decision.sessionId, null);
  assert.equal(out.decision.userEstimatedPriorMs.value, 90 * MIN);
  assert.equal(out.state.sessions.length, 0, '用户的估计值不得变成一条计时记录');
  assertValidState(out.state);
});

test('校验会挡住伪造的 source，不让「估计」被洗成实测', () => {
  const s = createState({});
  s.tasks = [{ taskId: 't1', name: 'x', createdAt: 1, status: 'ended' }];
  s.decisions = [{ decisionId: 'd1', taskId: 't1', sessionId: null, entryMode: 'immediate', at: 1, kind: 'stop', userEstimatedPriorMs: { value: 10, source: 'measured' } }];
  const r = validateState(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('userEstimatedPriorMs')));
});

test('v1 投影与 v1 迁移都不认识新字段：不泄漏、也不造假', () => {
  const ctx = makeCtx();
  const im = enterImmediate(createState({}, ctx), { name: '比价', scene: 'compare' }, ctx);
  const draft = openReassessment(im.state, { taskId: im.task.taskId }, ctx).draft;
  const withEst = decide(im.state, { decisionId: draft.decisionId, taskId: draft.taskId, entryMode: 'immediate', kind: 'stop', userEstimatedPriorMs: 60 * MIN }, ctx);
  const tplState = saveTemplate(withEst.state, { name: '比价规则' }, ctx).state;
  const v1 = JSON.stringify(toV1Projection(tplState));
  assert.equal(v1.includes('userEstimatedPriorMs'), false);
  assert.equal(v1.includes('templates'), false);
  assert.equal(v1.includes('scene'), false);

  const back = migrate({ items: [], history: [{ name: '旧事项', end: 1, total: 1, doneAt: 2 }] }, ctx);
  assert.equal('templates' in back, false, 'v1 迁移不凭空造模板');
  assert.equal(back.tasks[0].scene, undefined, 'v1 里没有场景，就不替旧记录归类');
});
