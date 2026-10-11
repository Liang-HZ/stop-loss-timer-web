import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY, LOCALES, DEFAULT_LOCALE, t, getCopy, resolveLocale, copyKeyDiff } from '../copy.js';

test('两套文案键名完全一致', () => {
  const diff = copyKeyDiff();
  assert.deepEqual(diff, { missingInEn: [], missingInZh: [] });
  assert.deepEqual(LOCALES, ['zh-CN', 'en']);
  assert.equal(DEFAULT_LOCALE, 'zh-CN');
});

test('zh-CN 采用 PRODUCT.md 第 2 节的表述', () => {
  assert.equal(t('field.taskName', 'zh-CN'), '现在在做／纠结什么？');
  assert.equal(t('reassess.title', 'zh-CN'), '接下来还要这样投入吗？');
  assert.equal(t('decision.stop', 'zh-CN'), '就到这里');
  assert.equal(t('decision.switch', 'zh-CN'), '换个办法');
  assert.equal(t('decision.continue', 'zh-CN'), '再投入一会儿');
  assert.equal(t('decision.later', 'zh-CN'), '以后再看');
  assert.equal(t('field.hypothesis', 'zh-CN'), '什么情况就停下来，或换个办法？');
});

test('已撤销的旧文案不得出现在任何一套里', () => {
  const all = Object.values(COPY).map(x => Object.values(x).join('\n')).join('\n');
  for (const banned of ['专注事项', '战果裁定', '诚实复盘', '消灭模糊地带', '守约达标', '果断止损抽身', '清醒再战', '捞回继续', '保住了多少']) {
    assert.equal(all.includes(banned), false, `旧文案「${banned}」不应再出现`);
  }
});

test('英文围绕重新判断是否继续投入表达，不锁定 Stop-Loss 品牌', () => {
  const en = Object.values(COPY.en).join('\n');
  assert.equal(/stop[- ]loss/i.test(en), false);
  assert.match(t('decision.stop', 'en'), /Stop here/);
  assert.match(t('reassess.title', 'en'), /still want to put time into this/);
  assert.match(t('entry.immediate', 'en'), /stuck/);
});

test('t() 变量替换、语言回退与缺键回退', () => {
  assert.equal(t('round.count', 'zh-CN', { n: 3 }), '第 3 轮');
  assert.equal(t('round.count', 'en', { n: 3 }), 'Round 3');
  assert.equal(t('round.count', 'zh-CN'), '第 {n} 轮', '没给变量时保留占位，不静默变空');
  assert.equal(resolveLocale('zh-Hans'), 'zh-CN');
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('fr'), 'zh-CN');
  assert.equal(resolveLocale(undefined), 'zh-CN');
  assert.equal(t('nonexistent.key', 'en'), 'nonexistent.key');
  assert.equal(getCopy('en'), COPY.en);
});

test('每个状态与决定都有对应文案键', () => {
  for (const k of ['status.active', 'status.ended', 'status.completed', 'status.later',
    'decision.stop', 'decision.switch', 'decision.continue', 'decision.later', 'decision.completed',
    'capacity.warn', 'capacity.full', 'sync.conflict', 'sync.merge', 'sync.keepCloud', 'sync.keepLocal']) {
    assert.notEqual(t(k, 'zh-CN'), k, `缺少 zh-CN 文案：${k}`);
    assert.notEqual(t(k, 'en'), k, `缺少 en 文案：${k}`);
  }
});
