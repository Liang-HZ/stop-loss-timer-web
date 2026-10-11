// 自定义提醒音（Pro）：导入校验与设置清理。IndexedDB 本身在浏览器走查里验，
// 这里只测不依赖宿主 API 的那部分（node 里没有 indexedDB）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateClip, MAX_BYTES, formatSize, isSupported } from '../sounds.js';
import { normalizeSettings, forgetSound, PRE_ALERT_CHOICES, DEFAULT_SETTINGS } from '../storage.js';

const file = (over = {}) => ({ name: 'ring.mp3', type: 'audio/mpeg', size: 1024, ...over });

test('导入校验：类型、大小、空文件各有明确原因', () => {
  assert.deepEqual(validateClip(file()), { ok: true });
  assert.equal(validateClip(file({ size: MAX_BYTES + 1 })).reason, 'too_big');
  assert.equal(validateClip(file({ size: MAX_BYTES })).ok, true, '正好 2 MB 是允许的');
  assert.equal(validateClip(file({ size: 0 })).reason, 'empty');
  assert.equal(validateClip(null).reason, 'empty');
  assert.equal(validateClip(file({ type: 'application/pdf', name: 'a.pdf' })).reason, 'bad_type');
});

test('type 为空时退到扩展名判断，不一刀切拒绝', () => {
  assert.equal(validateClip(file({ type: '', name: 'Alarm.WAV' })).ok, true);
  assert.equal(validateClip(file({ type: '', name: 'notes.txt' })).reason, 'bad_type');
});

test('node 环境里 IndexedDB 不可用时 isSupported 为假，不抛错', () => {
  assert.equal(isSupported(), false);
});

test('体积显示够用就行', () => {
  assert.equal(formatSize(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatSize(3000), '3 KB');
  assert.equal(formatSize(0), '1 KB');
});

test('设置默认值：预告关、用基础铃声、没有事项绑定', () => {
  const s = normalizeSettings(null);
  assert.equal(s.preAlertMs, 0);
  assert.equal(s.soundId, '');
  assert.deepEqual(s.taskSounds, {});
  assert.equal(DEFAULT_SETTINGS.preAlertMs, 0);
});

test('预告只认给定档位，写了别的值当「不预告」', () => {
  assert.equal(normalizeSettings({ preAlertMs: 5 * 60000 }).preAlertMs, 5 * 60000);
  assert.equal(normalizeSettings({ preAlertMs: 7 * 60000 }).preAlertMs, 0, '7 分钟不在档位里，不四舍五入到 5 或 10');
  assert.equal(normalizeSettings({ preAlertMs: -60000 }).preAlertMs, 0);
  assert.equal(normalizeSettings({ preAlertMs: 'soon' }).preAlertMs, 0);
  assert.ok(PRE_ALERT_CHOICES.includes(0), '必须能关掉');
});

test('事项绑定只收字符串对，脏数据不落盘', () => {
  const s = normalizeSettings({ taskSounds: { t1: 'clip_a', t2: 5, '': 'clip_b', t3: '' } });
  assert.deepEqual(s.taskSounds, { t1: 'clip_a' });
  assert.deepEqual(normalizeSettings({ taskSounds: ['clip_a'] }).taskSounds, {});
});

test('删掉音频时，默认铃声与事项绑定一起清掉，不留指向空气的 id', () => {
  const s = normalizeSettings({ soundId: 'clip_a', taskSounds: { t1: 'clip_a', t2: 'clip_b' } });
  const next = forgetSound(s, 'clip_a');
  assert.equal(next.soundId, '');
  assert.deepEqual(next.taskSounds, { t2: 'clip_b' });
  // 删一个没被引用的音频，其余设置一动不动
  assert.deepEqual(forgetSound(next, 'clip_zzz'), next);
});

/* ---- 语言：默认值与持久化键位 ---- */

test('没有存过语言时一律是 zh-CN，不看浏览器语言', async () => {
  const { initialLocale } = await import('../storage.js');
  const mem = {
    d: {},
    getItem(k) { return k in this.d ? this.d[k] : null; },
    setItem(k, v) { this.d[k] = String(v); },
    removeItem(k) { delete this.d[k]; }
  };
  // 本机语言是英文也一样：默认语言是产品定的，不是浏览器定的。
  assert.equal(initialLocale(mem), 'zh-CN');
  // 多传一个参数（老调用点没清干净）也不改变结果——签名里已经没有 nav 了。
  assert.equal(initialLocale(mem, { languages: ['en-US'] }), 'zh-CN');
});

test('语言写在顶层 sl.locale，同时在 sl.settings 里留副本；读取以顶层为准', async () => {
  const { initialLocale, saveSettings, LOCALE_KEY, SETTINGS_KEY } = await import('../storage.js');
  const mem = {
    d: {},
    getItem(k) { return k in this.d ? this.d[k] : null; },
    setItem(k, v) { this.d[k] = String(v); },
    removeItem(k) { delete this.d[k]; }
  };

  saveSettings(mem, { locale: 'en' });
  assert.equal(mem.d[LOCALE_KEY], 'en');
  assert.equal(JSON.parse(mem.d[SETTINGS_KEY]).locale, 'en', '两处一起写，不会分叉');
  assert.equal(initialLocale(mem), 'en', '用户手动切过就一直记住');

  // 顶层键被清掉（老版本升上来）时退回设置里的副本
  delete mem.d[LOCALE_KEY];
  assert.equal(initialLocale(mem), 'en');
  // 两处都是垃圾值时回默认语言，不抛
  mem.d[LOCALE_KEY] = 'klingon';
  mem.d[SETTINGS_KEY] = '{"locale":"klingon"}';
  assert.equal(initialLocale(mem), 'zh-CN');
});

test('localStorage 整个抛异常（隐私模式）时也能定出语言', async () => {
  const { initialLocale } = await import('../storage.js');
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); }
  };
  assert.equal(initialLocale(hostile), 'zh-CN');
});
