// public/app/storage.js
// 页面层的本机存储适配：v2 键位、v1 迁移与快照、访客/账户快照隔离。
// 纯逻辑、无 DOM：storage 由调用方注入（浏览器传 window.localStorage，测试传内存桩）。
// 迁移原则：保留原始快照与可回退路径。

import { migrate, isV2, createState, signOutLocalState } from '../core/index.js';

/* ---------------- 键位 ---------------- */

export const V2_KEY = 'sl.v2';                 // 访客（未登录）本机数据
export const V1_KEY = 'stoploss.v1';           // 旧版 items（迁移后**不删**，回退路径）
export const V1_HKEY = 'stoploss.history.v1';  // 旧版 history（同上）
export const BACKUP_PREFIX = 'sl.v1.backup.';  // 迁移当时的 v1 原样快照
export const CONFLICT_KEY = 'sl.v2.conflict';  // 待处理的同步冲突副本
export const SETTINGS_KEY = 'sl.settings';
export const TOKEN_KEY = 'sl.token';
export const USER_KEY = 'sl.user';
export const ENTERED_KEY = 'sl.entered';       // 用户点过「不登录，直接开始」
// 语言单独占一个顶层键：法务页等「不认识 sl.settings 结构」的页面也要读得到。
// sl.settings.locale 仍然跟着写，两边由 saveSettings / setLocale 一起更新，读取以本键优先。
export const LOCALE_KEY = 'sl.locale';

/** 某账户在本机的数据快照键；退出账号时只删这一个，不碰访客键、不碰云端。 */
export const accountKey = user => 'sl.v2.u.' + String(user || '');

/** 当前该读写哪个键：登录了用账户键，没登录用访客键。 */
export const stateKeyFor = user => (user ? accountKey(user) : V2_KEY);

/* ---------------- 读写 ---------------- */

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    const v = JSON.parse(raw);
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function removeKey(storage, key) {
  try { storage.removeItem(key); return true; } catch (e) { return false; }
}

/** state 里有没有任何用户产生的记录（决定合不合并、要不要提示的唯一判据）。 */
export function hasRecords(state) {
  if (!isV2(state)) return false;
  return state.tasks.length > 0 || state.sessions.length > 0 || state.decisions.length > 0;
}

/**
 * 读本机数据。
 * - 已有 v2：直接读。
 * - 只有旧的 KEY/HKEY：`migrate()`，**保留旧键不删**，并写一份 `sl.v1.backup.{ts}` 快照。
 * - 两者都没有：空 state。
 * @returns {{state, migrated:boolean, backupKey:string|null, key:string}}
 */
export function loadLocalState(storage, opts) {
  const o = opts || {};
  const key = stateKeyFor(o.user);
  const ctx = o.ctx;
  const existing = readJson(storage, key, null);
  if (isV2(existing)) return { state: existing, migrated: false, backupKey: null, key };

  // 旧键只属于「这台设备上的既有用户」，账户快照不去捡它（那是访客数据）。
  if (o.user) return { state: createState({}, ctx), migrated: false, backupKey: null, key };

  const v1Items = readJson(storage, V1_KEY, null);
  const v1History = readJson(storage, V1_HKEY, null);
  const hasV1 = (Array.isArray(v1Items) && v1Items.length) || (Array.isArray(v1History) && v1History.length);
  if (!hasV1) return { state: createState({}, ctx), migrated: false, backupKey: null, key };

  const state = migrate({ items: v1Items || [], history: v1History || [] }, ctx);
  const at = state.legacy && state.legacy.capturedAt ? state.legacy.capturedAt : Date.now();
  const backupKey = BACKUP_PREFIX + at;
  // 原样快照，独立于 state.legacy——即使 state 被覆盖或清掉，这份也还在。
  writeJson(storage, backupKey, { version: 1, capturedAt: at, items: v1Items || [], history: v1History || [] });
  writeJson(storage, key, state);
  // 刻意不删 V1_KEY / V1_HKEY：旧版页面还能读，是明确的回退路径。
  return { state, migrated: true, backupKey, key };
}

export function saveLocalState(storage, state, user) {
  return writeJson(storage, stateKeyFor(user), state);
}

export function readLocalState(storage, user) {
  const v = readJson(storage, stateKeyFor(user), null);
  return isV2(v) ? v : null;
}

/** 退出账号：清掉该账户的本机快照（不动云端，也不把账户数据留给访客）。 */
export function signOut(storage, user, ctx) {
  removeKey(storage, accountKey(user));
  removeKey(storage, TOKEN_KEY);
  removeKey(storage, USER_KEY);
  return signOutLocalState(ctx);
}

/** 登录并处理完访客数据之后，把访客槽清空——账户数据不能留在访客槽里。 */
export function clearGuestSlot(storage) {
  return removeKey(storage, V2_KEY);
}

/* ---------------- 冲突副本 ---------------- */

export function saveConflict(storage, record) {
  return writeJson(storage, CONFLICT_KEY, record);
}
export function loadConflict(storage) {
  return readJson(storage, CONFLICT_KEY, null);
}
export function clearConflict(storage) {
  return removeKey(storage, CONFLICT_KEY);
}

/* ---------------- 设置 ---------------- */

export const DEFAULT_SETTINGS = Object.freeze({
  reminderMaxAlerts: 3,      // 到点后最多再响几次（PRODUCT 第 2 节：温和默认上限）
  reminderIntervalMs: 60000, // 间隔 60 秒
  muted: false,
  analytics: false,          // 匿名统计默认关
  locale: 'zh-CN',
  // ---- Pro：自定义提醒。全部只存在本机（sl.settings），不进同步整包 ----
  preAlertMs: 0,             // 预告提醒：到点前多久先响一次，0 = 不预告
  soundId: '',               // 默认铃声：'' = 基础预设铃声，否则是 IndexedDB 里的 clip id
  taskSounds: {}             // 按事项绑定：{ [taskId]: clipId }。绑定的音频删掉时这里也跟着清
});

// 预告提醒的可选值（分钟）。给固定几档，不做任意输入：预告不是第二个决定时刻，
// 细到分钟级的自定义只会让人把它当成新的截止时间。
export const PRE_ALERT_CHOICES = Object.freeze([0, 1, 2, 3, 5, 10]);

export function loadSettings(storage) {
  const raw = readJson(storage, SETTINGS_KEY, null);
  return normalizeSettings(raw);
}

const isLocale = v => v === 'en' || v === 'zh-CN';

/**
 * 当前该用哪种语言。顶层 `sl.locale` 优先，其次设置里的副本，都没有就是 zh-CN。
 *
 * **刻意不看 navigator.language**：产品的默认语言就是中文，英文版是用户自己切过去的。
 * 跟随浏览器语言会让本机语言设成英文的中文用户一打开就看到英文界面（实测发生过），
 * 而他们并没有表达过任何偏好。只有「用户手动切换」才写 sl.locale，才被记住。
 */
export function initialLocale(storage) {
  let top = null;
  try { top = storage.getItem(LOCALE_KEY); } catch (e) { /* 隐私模式下读不到，往下退 */ }
  if (isLocale(top)) return top;
  const raw = readJson(storage, SETTINGS_KEY, null);
  if (raw && typeof raw === 'object' && isLocale(raw.locale)) return raw.locale;
  return 'zh-CN';
}

export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const int = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const preMin = Math.round(Number(s.preAlertMs) / 60000);
  const taskSounds = {};
  if (s.taskSounds && typeof s.taskSounds === 'object' && !Array.isArray(s.taskSounds)) {
    for (const [k, v] of Object.entries(s.taskSounds)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v) taskSounds[k] = v.slice(0, 80);
    }
  }
  return {
    reminderMaxAlerts: int(s.reminderMaxAlerts, DEFAULT_SETTINGS.reminderMaxAlerts, 0, 10),
    reminderIntervalMs: int(s.reminderIntervalMs, DEFAULT_SETTINGS.reminderIntervalMs, 10000, 600000),
    muted: s.muted === true,
    analytics: s.analytics === true,
    locale: s.locale === 'en' ? 'en' : 'zh-CN',
    // 只认给定的几档；写了别的值（老版本、手改 localStorage）一律当「不预告」，不四舍五入到最近一档
    preAlertMs: PRE_ALERT_CHOICES.includes(preMin) ? preMin * 60000 : 0,
    soundId: typeof s.soundId === 'string' ? s.soundId.slice(0, 80) : '',
    taskSounds
  };
}

/** 音频被删掉时，把引用它的默认铃声与事项绑定一并清掉，别留下指向空气的 id。 */
export function forgetSound(settings, clipId) {
  const s = normalizeSettings(settings);
  if (!clipId) return s;
  if (s.soundId === clipId) s.soundId = '';
  const next = {};
  for (const [k, v] of Object.entries(s.taskSounds)) if (v !== clipId) next[k] = v;
  s.taskSounds = next;
  return s;
}

export function saveSettings(storage, settings) {
  const next = normalizeSettings(settings);
  // 顶层 sl.locale 与 sl.settings.locale 一起写，避免两边分叉。
  try { storage.setItem(LOCALE_KEY, next.locale); } catch (e) { /* 写不进去不影响本次会话 */ }
  return writeJson(storage, SETTINGS_KEY, next);
}

/* ---------------- 导出 ---------------- */

/** 导出整包（含 legacy 原始快照），文件名带日期，给「导出本机／容量满了／放弃访客数据」用。 */
export function buildExport(state, opts) {
  const o = opts || {};
  const at = Number.isFinite(o.at) ? o.at : Date.now();
  const d = new Date(at);
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return {
    filename: `${o.prefix || 'stop-loss-timer'}-${stamp}.json`,
    mime: 'application/json',
    text: JSON.stringify({ exportedAt: at, source: o.source || 'local', data: state }, null, 2)
  };
}
