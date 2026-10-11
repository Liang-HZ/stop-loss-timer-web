// public/app/app.js — Web 客户端（v2 领域逻辑 + M1 体验合同）
//
// 这里只做三件事：读写本机存储、驱动 DOM、把用户动作翻译成 packages/core 的纯函数调用。
// 所有「事项—轮次—决定」的语义都在 /core/ 里，这个文件里**不许**再写一份判断。
// 所有用户可见文案都走 t()（表在 packages/core/copy.js），为英文版留好口子。
//
// 别破坏的机制（README 同名小节）：
//   - 到点铃预排到 Web Audio 音频时钟（beepAt），后台标签被节流也不漂；不要改成 setTimeout。
//   - 心跳用 Blob Worker，失败自动退回普通 setInterval。
//   - 上云走 pushChain 串行队列 + 5 秒防抖合并提交；syncMute 防止拉取回写时自我触发。
//   - 提醒按 sessionId 去重与取消（ReminderScheduler）。

import {
  createState, migrate, isV2,
  startPlanned, enterImmediate, openReassessment, decide, cancelSession, resumeLater, followUp,
  saveOnDeck, dismissOnDeck, completeOnDeck,
  checkCapacity, CapacityError, FlowError,
  groupByDay, todayReview, todayReviewMarkdown, taskTotals, formatDuration,
  resolveGuestLogin, mergeStates,
  findTask, findSession, sessionElapsedMs, sessionsOf,
  saveTemplate, deleteTemplate, builtInTemplates, advancedReview, SCENES,
  t as coreT, LIMITS
} from '../core/index.js?v=20260919_core_v1';
import { getEnergy, awardEnergy, REASONS } from './energy.js';

import * as store from './storage.js';
import * as sync from './sync-client.js';
import * as sounds from './sounds.js';
import { ReminderScheduler, overdueMs, effectiveElapsedMs } from './reminders.js';
import { EventBuffer } from './events.js';

const API = '/api';
const LS = window.localStorage;

/* ==========================================================================
   基础工具
   ========================================================================== */

const $ = id => document.getElementById(id);
const escapeHtml = str => String(str == null ? '' : str).replace(/[&<>'"]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[c]));

// 首次打开跟随浏览器语言（navigator.language）；之后以这台设备上存过的选择为准。
let settings = store.normalizeSettings({ ...store.loadSettings(LS), locale: store.initialLocale(LS) });
const t = (key, vars) => coreT(key, settings.locale, vars);
const dur = ms => formatDuration(ms, settings.locale);

// 标签与内容之间的分隔：中文用全角冒号，英文用半角加空格。写死「：」在英文界面里会很刺眼。
const sep = () => (settings.locale === 'en' ? ': ' : '：');
const paren = text => (settings.locale === 'en' ? ' (' + text + ')' : '（' + text + '）');
// 英文的单复数：只有「1 个」这一种特例，不为此引入 Intl.PluralRules（零依赖 + 只有两种语言）。
const nDecisions = n => t(n === 1 ? 'adv.decisions.one' : 'adv.decisions', { n });
const setText = (id, key, vars) => { const el = $(id); if (el) el.textContent = t(key, vars); };
const setAttr = (id, attr, key, vars) => { const el = $(id); if (el) el.setAttribute(attr, t(key, vars)); };

function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = (s % 60) | 0;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0');
}

/* ---- 日期 / 时间：全部走 Intl，按当前语言与**本机时区**显示 ----
   事件与记录里存的都是 UTC 毫秒；显示层才转成本地时区（
   事件时间保存 UTC，自然日按用户时区，跨时区不重复算一天）。
   Intl.DateTimeFormat 实例不便宜，按 locale 缓存一份；切语言时清掉。 */
const intlCache = new Map();
function fmt(kind, opts) {
  const key = settings.locale + ':' + kind;
  if (!intlCache.has(key)) {
    intlCache.set(key, new Intl.DateTimeFormat(settings.locale === 'en' ? 'en-US' : 'zh-CN', opts));
  }
  return intlCache.get(key);
}
// 倒计时旁边的「几点几分」：中文用 24 小时制，英文跟随 en-US 的 12 小时习惯。
const hhmm = ms => fmt('hhmm', { hour: '2-digit', minute: '2-digit', hour12: settings.locale === 'en' }).format(new Date(ms));
const fmtDate = ms => fmt('date', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms));
const fmtDateTime = ms => fmt('datetime', {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: settings.locale === 'en'
}).format(new Date(ms));
// 复盘的日期标题：把 'YYYY-MM-DD' 这个稳定键按当前语言显示，不改存储里的键
const fmtDayKey = dayKey => {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  if (!y || !m || !d) return dayKey;
  return fmt('day', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(y, m - 1, d));
};
// 时区名只在复盘页脚露一次：跨时区看记录时，得知道这些时刻是按哪个时区显示的
const localTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
};
const tzOffsetMinutes = () => -new Date().getTimezoneOffset();

// 落地页锚点平滑滚动：计算吸顶导航高度并保留舒缓留白，彻底防止小标题被遮挡
function scrollWithNavOffset(el) {
  if (!el) return;
  const nav = document.querySelector('.site-nav');
  const navHeight = nav ? nav.offsetHeight : 68;
  const targetTop = el.getBoundingClientRect().top + window.pageYOffset - navHeight - 32;
  window.scrollTo({
    top: Math.max(0, targetTop),
    behavior: 'smooth'
  });
}

/* ==========================================================================
   运行时状态
   ========================================================================== */

let state = createState({});
let cloudRev = 0;                 // 与云端一致的基线 rev，PUT 的 If-Match 用它
let dirty = false;                // 本机有未推送的改动
let syncMute = false;             // 拉取回写时静音，防止自我触发推送
let pushChain = Promise.resolve();
let pushTimer = null;
const PUSH_DEBOUNCE_MS = 5000;    // 免费档 KV 只有 1000 次写/天，合并提交是硬需求

const getToken = () => LS.getItem(store.TOKEN_KEY) || '';
const getUser = () => LS.getItem(store.USER_KEY) || '';

const runtime = new Map();        // sessionId -> { notified, alertsSeen }
let clientOutdated = false;
let capacityBlocked = null;
let authExpired = false;

/* ---- 自定义提醒音 ---- */

// 自定义提醒音：解码后的 AudioBuffer 按 clip id 缓存，别每次排铃都解一遍几百 KB
const soundCache = new Map();
let soundsList = [];              // IndexedDB 里的音频元数据（不含 blob）
let soundsUsable = sounds.isSupported();

/* ==========================================================================
   声音与到点提醒
   ========================================================================== */

let ac = null;
function unlockAudio() {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch (e) { /* 没有音频也要能用：只是听不到铃 */ }
}

/**
 * 预排到音频时钟：后台标签被节流也不漂。返回 gain 节点数组，silence() 用它撤销。
 * @param delaySec 相对现在的秒数
 * @param opts {{buffer?:AudioBuffer, pre?:boolean}}
 *   buffer：Pro 导入的个人音频（已解码）。走同一条「预排到 AudioContext 时钟」的路，
 *          不能改成 setTimeout 播放——那正是后台标签会漂的原因（README「别破坏的机制」）。
 *   pre：预告提醒。刻意比到点那次轻（音量减半、只响一下），它不是决定时刻。
 */
function beepAt(delaySec, opts) {
  if (!ac) return [];
  const o = opts || {};
  const base = ac.currentTime + Math.max(0, delaySec);
  if (o.buffer) {
    try {
      const src = ac.createBufferSource();
      const g = ac.createGain();
      src.buffer = o.buffer;
      g.gain.setValueAtTime(o.pre ? 0.35 : 0.9, base);
      src.connect(g);
      g.connect(ac.destination);
      src.start(base);
      // 自定义音频最长放 10 秒：导入的可能是一整首歌，铃声不该变成播放器
      src.stop(base + Math.min(10, o.buffer.duration || 10));
      return [g];
    } catch (e) { /* 自定义音频排不上就退回下面的基础铃，不能让提醒整个哑掉 */ }
  }
  const out = [];
  const peak = o.pre ? 0.15 : 0.3;
  const beats = o.pre ? [0] : [0, 0.4, 0.8];
  beats.forEach(d => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, base + d);
    g.gain.exponentialRampToValueAtTime(peak, base + d + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, base + d + 0.32);
    o.connect(g);
    g.connect(ac.destination);
    o.start(base + d);
    o.stop(base + d + 0.34);
    out.push(g);
  });
  return out;
}
function silence(gains) {
  (gains || []).forEach(g => { try { g.disconnect(); } catch (e) { /* 已断开 */ } });
}

/** 这一轮该用哪段音频：先看这个事项绑的，再看默认铃声。 */
function bufferForSession(sessionId) {
  const session = findSession(state, sessionId);
  const bound = session ? settings.taskSounds[session.taskId] : '';
  const id = bound || settings.soundId;
  if (!id) return null;
  return soundCache.get(id) || null;   // 没解码好就这次先用基础铃，解码完成后会整体重排
}

const reminders = new ReminderScheduler({
  schedule: (delaySec, meta) => {
    // 一次排期只报一条：同一轮的第 2、3 次重复提醒不是新的调度，别把计数灌成三倍。
    // 预告（index -1）也不报——它不是一次新的提醒调度。
    if (meta.index === 0) trackEvent('reminder_scheduled', { sessionId: meta.sessionId });
    return beepAt(delaySec, { buffer: bufferForSession(meta.sessionId), pre: meta.kind === 'pre' });
  },
  cancel: silence
});

/** 预排到音频时钟的铃全部重排一次。解码完音频、换默认铃声之后都要调。 */
function rescheduleReminders() {
  reminders.cancelAll();
  reminders.syncWith(openRounds().map(r => r.session), effectiveSettings());
}

/** 真正交给排期器的设置。 */
function effectiveSettings() {
  return settings;
}

function notify(name) {
  try {
    if (window.Notification && Notification.permission === 'granted') {
      new Notification(t('reassess.title'), { body: name || t('entry.immediate.placeholderName') });
    }
  } catch (e) { /* 通知被拒绝不影响其它提醒手段 */ }
}

const events = new EventBuffer({
  enabled: settings.analytics,
  send: async batch => {
    await fetch(API + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch })
    });
  }
});

// 攒批 + 10 秒防抖：分析请求不该跟着每个动作走一次，也不该攒到关页面才发。
let eventFlushTimer = null;
function trackEvent(name, input) {
  const e = events.track(name, input);
  if (!e) return null;
  clearTimeout(eventFlushTimer);
  eventFlushTimer = setTimeout(() => events.flush(), 10000);
  return e;
}

/* ==========================================================================
   本机存储与提交
   ========================================================================== */

function openRounds() {
  return state.sessions
    .filter(s => s.endedAt === undefined && Number.isFinite(s.deadlineAt))
    .map(s => ({ session: s, task: findTask(state, s.taskId) }))
    .filter(r => r.task && r.task.status === 'active')
    .sort((a, b) => a.session.deadlineAt - b.session.deadlineAt);
}

/** 所有会改数据的动作都经过这里：落本机 → 排提醒 → 合并上云 → 重绘。 */
function commit(next, opts) {
  state = next;
  store.saveLocalState(LS, state, getUser());
  reminders.syncWith(openRounds().map(r => r.session), effectiveSettings());
  if (!syncMute) {
    dirty = true;
    schedulePush(opts && opts.flush === true);
  }
  render();
}

/** 把可能抛容量错的核心调用包起来：满仓就提示 + 给导出入口，不静默丢数据。 */
function guard(fn) {
  try {
    capacityBlocked = null;
    return fn();
  } catch (e) {
    if (e instanceof CapacityError) {
      capacityBlocked = e.detail && e.detail.blocked && e.detail.blocked[0] ? e.detail.blocked[0] : { kind: 'tasks', count: 0, limit: 0 };
      renderBanners();
      showToast(t('capacity.full', capacityBlocked));
      return null;
    }
    if (e instanceof FlowError) { showToast(t('error.generic', { msg: e.message })); return null; }
    throw e;
  }
}

/* ==========================================================================
   顿悟时刻提示 (Milestones)
   ========================================================================== */

let milestoneTimer = null;
function showMilestoneToast(kind) {
  const toast = $('milestoneToast');
  if (!toast) return;
  const title = $('milestoneToastTitle');
  const desc = $('milestoneToastDesc');
  const btnCta = $('btnMilestoneCta');
  const btnDismiss = $('btnMilestoneDismiss');

  if (kind === 'first_decision') {
    title.textContent = t('milestone.decision.title');
    desc.textContent = t('milestone.decision.guest');
    btnCta.textContent = t('milestone.decision.cta');
    btnCta.onclick = () => { closeMilestoneToast(); openAuthModal(); };
  }

  btnDismiss.onclick = closeMilestoneToast;
  toast.style.display = 'flex';

  if (milestoneTimer) clearTimeout(milestoneTimer);
  milestoneTimer = setTimeout(closeMilestoneToast, 12000);
}

function closeMilestoneToast() {
  const toast = $('milestoneToast');
  if (toast) toast.style.display = 'none';
  if (milestoneTimer) { clearTimeout(milestoneTimer); milestoneTimer = null; }
}

/* ==========================================================================
   云同步：5 秒防抖合并提交，关键时刻立即 flush
   ========================================================================== */

function updateSyncStatus(status) {
  const el = $('syncStatusBadge');
  const txt = $('syncStatusText');
  if (!el || !txt) return;
  const dot = el.querySelector('.sync-dot');

  const pendingCount = (state && Array.isArray(state.tasks))
    ? state.tasks.filter(t => t.status === 'later').length
    : 0;

  el.classList.remove('is-guest', 'is-free', 'is-pro');

  if (!getToken()) {
    // 未登录：一切都在本机，数据不上云。
    el.classList.add('is-guest');
    txt.textContent = t('tier.guest.pill', { n: pendingCount });
    el.title = t('auth.signIn') + ' (开启云同步)';
    if (dot) dot.style.background = '#f59e0b';
    return;
  }

  // 已登录：数据在本机与云端之间同步。
  el.classList.add('is-free');
  el.title = t('app.settings');
  if (status === 'syncing') {
    txt.textContent = t('sync.syncing');
    if (dot) dot.style.background = 'var(--warn)';
  } else if (status === 'error') {
    txt.textContent = t('sync.failed');
    if (dot) dot.style.background = 'var(--danger)';
  } else {
    txt.textContent = t('tier.free.pill', { n: pendingCount });
    if (dot) dot.style.background = 'var(--accent)';
  }
}

function schedulePush(immediate) {
  if (!getToken()) return;
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  if (immediate) { flushPush(); return; }
  pushTimer = setTimeout(flushPush, PUSH_DEBOUNCE_MS);
}

function flushPush() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  if (!getToken() || !dirty) return pushChain;
  pushChain = pushChain.then(pushData).catch(() => {});
  return pushChain;
}

async function pushData() {
  const token = getToken();
  if (!token || !dirty) return;
  updateSyncStatus('syncing');
  const payload = { ...state, schemaVersion: 2, updatedAt: Date.now() };
  let r, body;
  try {
    r = await fetch(API + '/data', {
      method: 'PUT',
      headers: sync.putHeaders(token, cloudRev),
      body: JSON.stringify(payload)
    });
    body = await r.json().catch(() => ({}));
  } catch (e) {
    updateSyncStatus('error');
    return;
  }
  const c = sync.classifyPut(r.status, body);
  if (c.kind === 'ok') {
    // 内容没变时服务端返回 unchanged:true 并保持 rev（省 KV 写配额），基线照样对得上。
    if (Number.isFinite(c.rev)) cloudRev = c.rev;
    dirty = false;
    clientOutdated = false;
    capacityBlocked = null;
    updateSyncStatus('synced');
    renderBanners();
    return;
  }
  if (c.kind === 'unauthorized') { handleAuthExpired(); return; }
  if (c.kind === 'conflict') {
    const record = sync.buildConflictRecord(state, c.server, Date.now());
    store.saveConflict(LS, record);
    updateSyncStatus('error');
    renderBanners();
    return;
  }
  if (c.kind === 'client_outdated') {
    clientOutdated = true;
    updateSyncStatus('error');
    renderBanners();
    return;
  }
  if (c.kind === 'capacity_full') {
    const counts = checkCapacity(state).counts;
    capacityBlocked = { kind: 'tasks', count: counts.tasks, limit: LIMITS.tasks };
    updateSyncStatus('error');
    renderBanners();
    return;
  }
  updateSyncStatus('error');
}

async function pullData(force) {
  const token = getToken();
  if (!token) return;
  if (dirty && !force) return;   // 本机还有没推上去的改动，先别覆盖
  updateSyncStatus('syncing');
  let r, body;
  try {
    r = await fetch(API + '/data', { headers: sync.getHeaders(token) });
    body = await r.json().catch(() => null);
  } catch (e) { updateSyncStatus('error'); return; }

  const c = sync.classifyGet(r.status, body, r.headers);
  if (c.kind === 'unauthorized') { handleAuthExpired(); return; }
  if (c.kind !== 'ok') {
    if (c.kind === 'not_v2') clientOutdated = false;
    updateSyncStatus('error');
    return;
  }

  const warn = sync.shouldWarnOnPull(cloudRev, c.rev, dirty);
  if (warn.warn) {
    store.saveConflict(LS, sync.buildConflictRecord(state, c.state, Date.now()));
    updateSyncStatus('error');
    renderBanners();
    return;
  }
  syncMute = true;
  cloudRev = c.rev;
  commit(c.state);
  syncMute = false;
  dirty = false;
  updateSyncStatus('synced');
}

function handleAuthExpired() {
  authExpired = true;
  const user = getUser();
  state = store.signOut(LS, user);
  cloudRev = 0;
  dirty = false;
  reminders.cancelAll();
  refreshEntitlement();      // 登录过期 = 没有账户 = 免费档
  renderAll();
}

/* ==========================================================================
   提示条：同步冲突、容量、登录过期、客户端过旧
   ========================================================================== */

function bannerCard(kind, title, text, actions) {
  const el = document.createElement('div');
  el.className = 'banner-card ' + kind;
  const body = document.createElement('div');
  body.className = 'banner-text';
  if (title) {
    const b = document.createElement('span');
    b.className = 'banner-title';
    b.textContent = title;
    body.appendChild(b);
  }
  body.appendChild(document.createTextNode(text));
  el.appendChild(body);
  const acts = document.createElement('div');
  acts.className = 'banner-acts';
  for (const a of actions || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    if (a.primary) btn.className = 'primary';
    btn.onclick = a.onClick;
    acts.appendChild(btn);
  }
  el.appendChild(acts);
  return el;
}

function renderBanners() {
  const host = $('banners');
  if (!host) return;
  host.innerHTML = '';

  const conflict = store.loadConflict(LS);
  if (conflict) {
    host.appendChild(bannerCard('danger', t('sync.conflictTitle'), t('sync.conflict') + ' ' + t('sync.conflictSaved'), [
      { label: t('sync.keepCloud'), onClick: () => applyConflictChoice('cloud', conflict) },
      { label: t('sync.keepLocal'), onClick: () => applyConflictChoice('local', conflict) },
      { label: t('sync.merge'), primary: true, onClick: () => applyConflictChoice('merge', conflict) },
      { label: t('sync.exportLocal'), onClick: () => downloadExport(conflict.local, 'conflict-local') }
    ]));
  }

  if (clientOutdated) {
    host.appendChild(bannerCard('danger', t('sync.conflictTitle'), t('sync.clientOutdated'), [
      { label: t('sync.retry'), primary: true, onClick: () => location.reload() }
    ]));
  }

  if (authExpired) {
    host.appendChild(bannerCard('warn', '', t('auth.expired'), [
      { label: t('auth.signIn'), primary: true, onClick: () => showLand(true) }
    ]));
  }

  if (capacityBlocked) {
    host.appendChild(bannerCard('danger', '', t('capacity.full', capacityBlocked), [
      { label: t('capacity.export'), primary: true, onClick: () => downloadExport(state, 'export') }
    ]));
  } else {
    const cap = checkCapacity(state);
    if (cap.level === 'warn') {
      const kind = cap.warn[0];
      host.appendChild(bannerCard('warn', '', t('capacity.warn', { kind, count: cap.counts[kind], limit: cap.limits[kind] }), [
        { label: t('capacity.export'), onClick: () => downloadExport(state, 'export') }
      ]));
    }
  }
}

function applyConflictChoice(choice, record) {
  const r = sync.resolveConflict(choice, record);
  store.clearConflict(LS);
  cloudRev = r.nextRev;
  syncMute = true;
  commit(r.state);
  syncMute = false;
  if (choice === 'cloud' && r.discardedLocal) {
    // 被放弃的访客/本机数据不许静默丢：直接给一份导出。
    downloadExport(r.discardedLocal, 'discarded-local');
  }
  if (r.needsPush) { dirty = true; schedulePush(true); }
  else { dirty = false; updateSyncStatus('synced'); }
  renderBanners();
}

function downloadExport(data, prefix) {
  const out = store.buildExport(data || state, { prefix: 'stop-loss-timer-' + prefix });
  const blob = new Blob([out.text], { type: out.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = out.filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  showToast(t('toast.exported'));
}

/* ==========================================================================
   Toast
   ========================================================================== */

let toastTimer = null;
function showToast(msg) {
  const el = $('toastBubble');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ==========================================================================
   静态文案填充
   ========================================================================== */

function fillStaticCopy() {
  document.documentElement.lang = settings.locale === 'en' ? 'en' : 'zh-CN';
  document.title = t('app.name');
  renderLangLink();

  // 落地页顶部导航与入口
  setText('navFeatLink', 'nav.features');
  setText('navPhilLink', 'nav.philosophy');
  setText('btnOpenAuthModal', 'auth.signIn');
  setText('btnHeroGuestText', 'hero.guest');
  setText('landCtaText', 'land.cta.auth');

  // 落地页
  setText('authTitle', 'app.name');
  setText('authSubtitle', 'app.promise');
  setText('tabL', 'auth.tabLogin');
  setText('tabR', 'auth.tabRegister');
  setAttr('aUser', 'placeholder', 'auth.username');
  setAttr('aPass', 'placeholder', 'auth.password');
  setText('aGo', 'auth.submit.login');
  setText('landGuest', 'land.cta.guest');
  setText('aNote', 'auth.note');
  setText('authLegalAgree', 'auth.legalAgree');
  setText('authLegalAnd', 'auth.legalAnd');
  setText('authLinkTerms', 'legal.terms');
  setText('authLinkPrivacy', 'legal.privacy');
  setText('recoveryToggle', 'recovery.forgot');
  setAttr('rcUser', 'placeholder', 'auth.username');
  setAttr('rcCode', 'placeholder', 'recovery.code');
  setAttr('rcPass', 'placeholder', 'recovery.newPassword');
  setText('rcGo', 'recovery.submit');
  setText('landBrandTag', 'land.brandTag');
  const headlineEl = $('landHeadline');
  if (headlineEl) {
    headlineEl.innerHTML = t('hero.headline');
  }
  setText('landSub', 'hero.sub');
  setText('landDemoTitle', 'land.demoTitle');
  setText('landDemoBadge', 'status.active');
  setText('landCta', 'land.cta.auth');
  const lb = $('landBack');
  if (lb) lb.textContent = '← ' + t('app.back');
  setAttr('landBack', 'title', 'app.back');

  const scen = $('landScenarios');
  if (scen) {
    scen.innerHTML = '';
    const icons = { compare: '💡', stuck: '🚀', detail: '⚖️', argue: '🔄', debug: '🎯' };
    for (const k of ['compare', 'stuck', 'detail', 'argue', 'debug']) {
      const li = document.createElement('li');
      li.className = 'scenario-chip';
      li.innerHTML = `<span class="scenario-icon">${icons[k] || '✦'}</span><span class="scenario-text">${escapeHtml(t('land.scenario.' + k))}</span>`;
      scen.appendChild(li);
    }
  }
  const feats = $('landFeatures');
  if (feats) {
    feats.innerHTML = '';
    const featIcons = {
      remind: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></svg>',
      record: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
      sync: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>'
    };
    for (const k of ['remind', 'record', 'sync']) {
      const box = document.createElement('div');
      box.className = 'feature-item';
      box.innerHTML = `<div class="feature-icon-box">${featIcons[k] || '✦'}</div><div class="feature-text"><span class="feature-title"></span><span class="feature-desc"></span></div>`;
      box.querySelector('.feature-title').textContent = t('land.feature.' + k + '.title');
      box.querySelector('.feature-desc').textContent = t('land.feature.' + k + '.desc');
      feats.appendChild(box);
    }
  }

  // 落地页信任背书
  setText('heroTrust1', 'land.hero.trust1');
  setText('heroTrust2', 'land.hero.trust2');
  setText('heroTrust3', 'land.hero.trust3');

  // 落地页卡片演示区
  setText('mockupTab1', 'land.mockup.tab1');
  setText('mockupTab2', 'land.mockup.tab2');
  setText('mockupTab3', 'land.mockup.tab3');
  setText('mockupStatusTag', 'land.mockup.statusTag');
  setText('mockupActiveTask', 'land.mockup.activeTask');
  setText('mockupSpent', 'land.mockup.spent');
  setText('mockupRemain', 'land.mockup.remain');
  setText('mockupHead', 'land.mockup.head');
  setText('mockupDesc', 'land.mockup.desc');
  setText('mockupOpt1', 'land.mockup.opt1');
  setText('mockupOpt2', 'land.mockup.opt2');
  setText('mockupOpt3', 'land.mockup.opt3');
  setText('mockupStopBadge', 'land.mockup.stopBadge');
  setText('btnEnterAppFromMockup', 'land.mockup.cta');

  // 哲学对比区
  setText('philoTitle', 'land.philo.title');
  setText('philoDesc', 'land.philo.sub');
  setText('philoTradBadge', 'land.philo.tradBadge');
  setText('philoTradTitle', 'land.philo.tradTitle');
  const pTrad1 = $('philoTrad1');
  if (pTrad1) pTrad1.innerHTML = `<strong>${escapeHtml(t('land.philo.trad1.bold'))}</strong>${escapeHtml(t('land.philo.trad1.text'))}`;
  const pTrad2 = $('philoTrad2');
  if (pTrad2) pTrad2.innerHTML = `<strong>${escapeHtml(t('land.philo.trad2.bold'))}</strong>${escapeHtml(t('land.philo.trad2.text'))}`;
  const pTrad3 = $('philoTrad3');
  if (pTrad3) pTrad3.innerHTML = `<strong>${escapeHtml(t('land.philo.trad3.bold'))}</strong>${escapeHtml(t('land.philo.trad3.text'))}`;

  setText('philoPosBadge', 'land.philo.posBadge');
  setText('philoPosTitle', 'land.philo.posTitle');
  const pPos1 = $('philoPos1');
  if (pPos1) pPos1.innerHTML = `<strong>${escapeHtml(t('land.philo.pos1.bold'))}</strong>${escapeHtml(t('land.philo.pos1.text'))}`;
  const pPos2 = $('philoPos2');
  if (pPos2) pPos2.innerHTML = `<strong>${escapeHtml(t('land.philo.pos2.bold'))}</strong>${escapeHtml(t('land.philo.pos2.text'))}`;
  const pPos3 = $('philoPos3');
  if (pPos3) pPos3.innerHTML = `<strong>${escapeHtml(t('land.philo.pos3.bold'))}</strong>${escapeHtml(t('land.philo.pos3.text'))}`;

  // Bento Grid 特性展示
  setText('bentoTitle', 'land.bento.title');
  setText('bentoDesc', 'land.bento.sub');
  setText('bentoCard1Title', 'land.bento.card1.title');
  setText('bentoCard1Desc', 'land.bento.card1.desc');
  setText('bentoCard2Title', 'land.bento.card2.title');
  setText('bentoCard2Desc', 'land.bento.card2.desc');
  setText('bentoCard3Title', 'land.bento.card3.title');
  setText('bentoCard3Desc', 'land.bento.card3.desc');
  setText('bentoCard4Title', 'land.bento.card4.title');
  setText('bentoCard4Desc', 'land.bento.card4.desc');

  // 创作者口碑
  setText('testiTitle', 'land.testi.title');
  setText('testiDesc', 'land.testi.sub');
  setText('testi1Quote', 'land.testi1.quote');
  setText('testi1Author', 'land.testi1.author');
  setText('testi2Quote', 'land.testi2.quote');
  setText('testi2Author', 'land.testi2.author');
  setText('testi3Quote', 'land.testi3.quote');
  setText('testi3Author', 'land.testi3.author');

  // 底部行动号召横幅
  setText('bannerTitle', 'land.banner.title');
  setText('bannerDesc', 'land.banner.desc');
  setText('btnHeroGuestBottomText', 'land.banner.btnGuest');

  // 落地页全站页脚
  setText('landFooterCopy', 'land.footer.copy');
  setText('landFooterHome', 'land.footer.home');

  // 顶栏
  setText('topBrandTitle', 'app.name');
  setText('topBrandSlogan', 'land.brandTag');
  setText('navNowText', 'nav.now');
  setText('navPoolText', 'nav.pool');
  setText('navReviewText', 'nav.review');
  setText('poolSectTitle', 'app.sectionPool');
  setText('poolSectSubtitle', 'pool.subtitle');
  setAttr('poolQuickInput', 'placeholder', 'pool.quickAddPlaceholder');
  setText('btnPoolQuickSaveText', 'pool.quickAddBtn');
  setAttr('poolSearchInput', 'placeholder', 'pool.searchPlaceholder');
  setText('btnRandomWakePoolText', 'ondeck.randomWake');
  setAttr('btnRandomWakePool', 'title', 'ondeck.randomWake');
  setText('funnelBadgeText', 'funnel.badge');
  setText('funnelTitle', 'funnel.title');
  setText('funnelSubtitle', 'funnel.subtitle');
  setText('funnelStep1Label', 'funnel.step1.label');
  setText('funnelStep1Sub', 'funnel.step1.sub');
  setText('funnelStep2Label', 'funnel.step2.label');
  setText('funnelStep3Label', 'funnel.step3.label');
  setText('funnelStopRate', 'funnel.step3.sub');
  setText('funnelStep4Label', 'funnel.step4.label');
  setText('settingsBtnText', 'app.settings');
  setAttr('settingsBtn', 'title', 'app.settings');
  setText('acctLabel', 'auth.signedInAs');
  setText('aOut2', 'auth.signOut');
  setText('setAccountSignInLabel', 'settings.account.guest');
  setText('setSignInBtn', 'auth.signIn');
  setText('nowSectTitle', 'app.sectionNow');
  setText('reviewSectTitle', 'app.sectionReview');
  setText('reviewSectSubtitle', 'review.subtitle');
  setText('btnFsBoardText', 'now.fullscreen');
  setText('footerNote', 'sync.guestNotice');

  // 主表单
  setText('lblCreateTitle', 'launchpad.cardTitle');
  setText('lblCreateSub', 'launchpad.cardSub');
  setText('btnToggleCreatorText', 'now.addAnother');
  setText('btnToggleHypoText', hypoExpanded ? 'launchpad.conditionClose' : 'launchpad.conditionAdd');
  setText('lblName', 'field.taskName');
  setAttr('name', 'placeholder', 'launchpad.placeholder');
  setText('lblHypo', 'field.hypothesis');
  setText('lblHypoOpt', 'field.hypothesis.optional');
  // 「可以不填」只出现在字段标签上这一处，输入框的 placeholder 给的是例子而不是再说一遍
  setAttr('hypothesis', 'placeholder', 'field.hypothesis.placeholder');
  setText('tplPickerBtn', 'template.picker');
  setText('reviewMenuBtn', 'review.actions');
  setText('tabTimingDurText', 'timing.mode.duration');
  setText('tabTimingWhenText', 'timing.mode.deadline');
  setText('lblDur', 'field.duration');
  setText('lblOr', 'field.duration.or');
  setText('lblDurUnit', 'field.duration.unit');
  setAttr('dur', 'aria-label', 'field.duration');
  setText('lblWhen', 'field.deadline');
  setAttr('when', 'aria-label', 'field.deadline');
  setAttr('when', 'title', 'field.deadline.hint');
  setText('btnSaveOnDeckText', 'launchpad.saveOnDeck');
  setText('lblOnDeckTitle', 'ondeck.sectionTitle');
  setText('btnRandomWakeText', 'ondeck.randomWake');
  setText('energyModalBrand', 'energy.modalTitle');
  updateDurationPill();
  const initialDur = $('dur') ? parseFloat($('dur').value) : 15;
  setText('startSubmitText', 'launchpad.launch', { d: (initialDur || 15) + 'm' });
  // 胶囊用短标签：窄栏里「30 分钟 / 30 minutes」会折成三行，「30 分 / 30 min」不会
  document.querySelectorAll('.dur-chips-wrap .chip').forEach(c => {
    const min = Number(c.dataset.min);
    c.textContent = min % 60 === 0
      ? t('duration.chip.hour', { n: min / 60 })
      : t('duration.chip.min', { n: min });
  });

  setText('immediateHint', 'entry.immediate.hint');
  setText('lblImName', 'field.taskName');
  setText('lblImNameOpt', 'app.optional');
  setAttr('imName', 'placeholder', 'entry.immediate.placeholderName');
  setText('btnReassessNowText', 'entry.reassessNow');
  setText('lblShortReminder', 'entry.shortReminder');
  setText('shortReminderHint', 'entry.shortReminder.hint');
  document.querySelectorAll('[data-short]').forEach(b => {
    b.textContent = t('duration.chip.min', { n: b.dataset.short });
  });

  // 重评面板
  setText('raTitleText', 'reassess.title');
  setText('raSub', 'reassess.subtitle');
  setText('raHypoTag', 'field.hypothesis');
  setText('raPriorLabel', 'field.priorEstimate');
  setText('raPriorHint', 'field.priorEstimate.hint');
  setAttr('raPrior', 'placeholder', 'reassess.continue.unit');
  setText('raExpectationLabel', 'field.expectation');
  // 「可以不填」在这一组只由 raOptionalHint 说一次，两个输入框不再各写一遍
  setText('raOptionalHint', 'reassess.expectation.hint');
  setText('raActStopTitle', 'decision.stop');
  setText('raActStopHint', 'decision.stop.hint');
  setText('raActSwitchTitle', 'decision.switch');
  setText('raActSwitchHint', 'decision.switch.hint');
  setText('raActContinueTitle', 'decision.continue');
  setText('raActContinueHint', 'decision.continue.hint');
  setText('raLaterLabel', 'decision.later');
  setText('raLaterHint', 'decision.later.hint');
  setText('raCompletedLabel', 'decision.completed');
  setText('raContinueCustomLabel', 'reassess.continue.custom');
  setText('raContinueUnit', 'reassess.continue.unit');
  setAttr('raContinueCustom', 'aria-label', 'reassess.continue.custom');
  setText('raNoteLabel', 'field.note');
  setText('raLaterBtn', 'reassess.close');
  setText('raConfirmBtn', 'app.confirm');
  setText('raOptionalSummary', 'reassess.optionalToggle');
  document.querySelectorAll('#raContinuePanel .chip').forEach(c => {
    c.textContent = t('duration.minutes', { n: c.dataset.add });
  });

  // 访客合并选择
  setText('guestTitleText', 'guest.title');
  setText('guestHint', 'guest.hint');
  setText('guestMergeTitle', 'sync.merge');
  setText('guestCloudTitle', 'sync.keepCloud');
  setText('guestCloudHint', 'guest.cloudWarn');
  setText('guestLocalTitle', 'sync.keepLocal');

  // 设置
  setText('setTitleText', 'settings.title');
  setText('setReminderTitle', 'settings.reminder');
  setText('setMaxAlertsLabel', 'settings.reminder.max');
  setText('setIntervalLabel', 'settings.reminder.interval');
  setText('setMutedLabel', 'settings.reminder.mute');
  setText('setAnalyticsTitle', 'settings.privacy');
  setAttr('setAnalytics', 'aria-label', 'settings.analytics');
  setText('setAnalyticsHelp', 'settings.analytics.hint');
  setText('setAccountTitle', 'settings.account');
  setText('setRecoveryLabel', 'recovery.title');
  setText('setRecoveryHelp', 'recovery.regenerateHint');
  setText('setRecoveryBtn', 'recovery.generate');
  setText('setDataTitle', 'settings.data');
  setText('setExportBtn', 'review.exportData');
  setText('setClearBtn', 'review.clear');
  setText('setLanguageTitle', 'settings.language');
  setAttr('setLanguage', 'aria-label', 'settings.language');
  setText('setLanguageHelp', 'settings.language.hint');
  setText('setPreAlertLabel', 'prealert.title');
  setText('setPreAlertHelp', 'prealert.hint');
  setText('setSoundLabel', 'sound.pick');
  setText('setSoundHelp', 'sound.importHint');
  setText('setSoundImportLabel', 'sound.custom');
  setText('setSoundImportHelp', 'sound.import');
  setText('setRulesTitle', 'settings.rules');
  setText('setRulesHelp', 'template.hint');
  setText('setTemplatesBtn', 'template.title');
  setText('setAdvBtn', 'adv.title');
  setText('setIntervalLabel', 'repeat.title');

  // 找回码
  setText('rcTitleText', 'recovery.title');
  setText('rcShownHint', 'recovery.shown');
  setText('rcCopyBtn', 'recovery.copy');
  setText('rcDoneBtn', 'app.close');

  // 全屏
  setText('fsBrandText', 'app.name');
  setText('fsModeSingleBtn', 'now.fs.single');
  setText('fsModeGridBtn', 'now.fs.grid');
  setText('fsPipBtnText', 'now.pip');
  setText('fsCloseBtnText', 'app.close');
  setText('fsMindsetPrompt', 'app.promise');
  setText('fsLblCheckin', 'field.deadline');
  setText('fsLblElapsed', 'time.elapsed');
  setText('fsLblCum', 'time.cumulative');
  setText('fsLblOverdue', 'time.overdue');
  setText('fsDoneBtnText', 'now.endEarly');
  setText('fsSwitchBtnText', 'now.switchMethod');
  setText('fsContinueBtnText', 'now.extend15');
  setText('fsAbandonBtnText', 'decision.cancel');
  setText('fsGridTitle', 'now.fs.grid');

  // 复盘简报
  setText('briefingTitle', 'review.title');
  setText('briefingListTitle', 'review.decisions');
  setText('briefingFooter', 'review.footer');
  setText('btnBriefingCopyText', 'review.export');
  setText('btnBriefingImgText', 'review.exportImage');
  setText('btnBriefingCloseText', 'app.close');

  // 通用确认弹窗
  setText('confirmModalTitle', 'confirm.cancelRound.title');
  setText('confirmModalDesc', 'confirm.cancelRound.desc');
  setText('btnConfirmCancel', 'confirm.cancelRound.cancel');
  setText('btnConfirmProceed', 'confirm.cancelRound.proceed');

  // 灵感随机唤醒浮层
  setText('wakeBadgeText', 'wake.badge');
  setText('wakeModalHint', 'wake.hint');
  setText('btnWakeClose', 'wake.close');
  setText('btnWakeLaunchText', 'wake.launch');
}

/* ==========================================================================
   曜石能量与待启念头 (On Deck & Energy)
   ========================================================================== */

function renderEnergy() {
  const energy = getEnergy();
  const stonesEl = $('energyStonesVal');
  const streakEl = $('energyStreakVal');
  if (stonesEl) stonesEl.textContent = String(energy.stones);
  if (streakEl) streakEl.textContent = String(energy.streak);

  const modalStones = $('modalEnergyStones');
  const modalStreak = $('modalEnergyStreak');
  const modalFreeze = $('modalFreezeCount');
  if (modalStones) modalStones.textContent = String(energy.stones);
  if (modalStreak) modalStreak.textContent = `专注已连续 ${energy.streak} 天`;
  if (modalFreeze) modalFreeze.textContent = String(energy.streakFreezeCount);
}

function triggerEnergyReward(amount, label) {
  const bubble = document.createElement('div');
  bubble.className = 'energy-float-particle';
  bubble.innerHTML = `<span class="float-gem">✦</span><span class="float-amount">+${amount}</span><span class="float-label">${label || ''}</span>`;
  document.body.appendChild(bubble);
  setTimeout(() => { if (bubble.parentNode) bubble.remove(); }, 2000);
}

function openEnergyModal() {
  renderEnergy();
  const overlay = $('energyOverlay');
  if (overlay) overlay.style.display = 'flex';
}

function closeEnergyModal() {
  const overlay = $('energyOverlay');
  if (overlay) overlay.style.display = 'none';
}

function showConfirmDialog({ title, desc, confirmText, danger = true, onConfirm }) {
  const overlay = $('confirmOverlay');
  if (!overlay) {
    if (confirm(desc || title)) onConfirm();
    return;
  }
  const titleEl = $('confirmModalTitle');
  const descEl = $('confirmModalDesc');
  const btnProceed = $('btnConfirmProceed');
  const btnCancel = $('btnConfirmCancel');

  if (titleEl) titleEl.textContent = title || t('app.confirm');
  if (descEl) descEl.textContent = desc || '';
  if (btnProceed) {
    btnProceed.textContent = confirmText || t('app.confirm');
    btnProceed.className = danger ? 'btn-danger' : 'btn-primary';
    btnProceed.onclick = () => {
      overlay.style.display = 'none';
      onConfirm();
    };
  }
  if (btnCancel) {
    btnCancel.onclick = () => {
      overlay.style.display = 'none';
    };
  }
  overlay.style.display = 'flex';
}

function renderOnDeck(searchQuery) {
  const host = $('onDeckList');
  const badge = $('onDeckBadge');
  const poolBadge = $('poolBadge');
  const countBadge = $('poolCountBadge');
  if (!host) return;
  host.innerHTML = '';

  let pendingTasks = state.tasks.filter(t => t.status === 'later');
  if (badge) badge.textContent = String(pendingTasks.length);
  if (poolBadge) {
    poolBadge.textContent = String(pendingTasks.length);
    poolBadge.style.display = pendingTasks.length ? 'inline-flex' : 'none';
  }
  if (countBadge) countBadge.textContent = pendingTasks.length ? t('pool.count', { n: pendingTasks.length }) : t('pool.countEmpty');

  const nudge = $('poolNudgeBar');
  if (nudge) {
    const show = !getToken() && pendingTasks.length >= 3 && pendingTasks.length <= 5;
    nudge.style.display = show ? 'flex' : 'none';
    const nudgeText = $('poolNudgeText');
    if (nudgeText) nudgeText.textContent = t('pool.nudgeText', { n: pendingTasks.length });
    const btnNudge = $('btnPoolNudgeLogin');
    if (btnNudge) {
      btnNudge.textContent = t('pool.nudgeLogin');
      btnNudge.onclick = openAuthModal;
    }
  }

  const query = (searchQuery !== undefined ? searchQuery : ($('poolSearchInput') ? $('poolSearchInput').value : '')).trim().toLowerCase();
  if (query) {
    pendingTasks = pendingTasks.filter(t => (t.name && t.name.toLowerCase().includes(query)) || (t.hypothesis && t.hypothesis.toLowerCase().includes(query)));
  }

  if (!pendingTasks.length) {
    const empty = document.createElement('li');
    empty.className = 'ondeck-empty';
    empty.textContent = query ? t('pool.searchEmpty') : t('pool.empty');
    host.appendChild(empty);
    return;
  }

  for (const task of [...pendingTasks].reverse()) {
    const li = document.createElement('li');
    li.className = 'ondeck-item';

    const info = document.createElement('div');
    info.className = 'ondeck-item-info';

    const name = document.createElement('span');
    name.className = 'ondeck-item-name';
    name.textContent = task.name || t('entry.immediate.placeholderName');
    name.title = task.name;
    info.appendChild(name);

    if (task.hypothesis) {
      const tag = document.createElement('span');
      tag.className = 'ondeck-item-tag';
      tag.innerHTML = `<span class="tag-hypo-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle></svg></span><span>${escapeHtml(t('pool.tagHypo'))}${escapeHtml(task.hypothesis)}</span>`;
      info.appendChild(tag);
    }

    const acts = document.createElement('div');
    acts.className = 'ondeck-item-actions';

    // 核心原则：列表里一个条目只配一个高频主按钮「启动」
    const btnLaunch = document.createElement('button');
    btnLaunch.type = 'button';
    btnLaunch.className = 'btn-pool-launch';
    btnLaunch.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>${escapeHtml(t('pool.launch15'))}</span>`;
    btnLaunch.title = t('pool.launchTitle');
    btnLaunch.onclick = () => doLaunchOnDeck(task.taskId);
    acts.appendChild(btnLaunch);

    // 次级动作收进简洁的更多操作下拉，杜绝并排杂乱
    const menuWrap = document.createElement('div');
    menuWrap.className = 'pool-item-menu-wrap';

    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'btn-pool-more';
    moreBtn.textContent = '···';
    moreBtn.title = t('pool.moreActions');

    const dropdown = document.createElement('div');
    dropdown.className = 'pool-dropdown-menu';
    dropdown.style.display = 'none';

    const actDone = document.createElement('button');
    actDone.type = 'button';
    actDone.className = 'pool-dropdown-item';
    actDone.innerHTML = `<span>✓</span> ${escapeHtml(t('pool.done'))}`;
    actDone.onclick = (e) => { e.stopPropagation(); dropdown.style.display = 'none'; doCompleteOnDeck(task.taskId); };

    const actDel = document.createElement('button');
    actDel.type = 'button';
    actDel.className = 'pool-dropdown-item danger';
    actDel.innerHTML = `<span>✕</span> ${escapeHtml(t('pool.delete'))}`;
    actDel.onclick = (e) => { e.stopPropagation(); dropdown.style.display = 'none'; doDismissOnDeck(task.taskId); };

    dropdown.appendChild(actDone);
    dropdown.appendChild(actDel);

    moreBtn.onclick = (e) => {
      e.stopPropagation();
      const open = dropdown.style.display === 'block';
      document.querySelectorAll('.pool-dropdown-menu').forEach(m => m.style.display = 'none');
      dropdown.style.display = open ? 'none' : 'block';
    };

    menuWrap.appendChild(moreBtn);
    menuWrap.appendChild(dropdown);
    acts.appendChild(menuWrap);

    li.appendChild(info);
    li.appendChild(acts);
    host.appendChild(li);
  }
}

function doSaveOnDeck() {
  const nameInput = $('name');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    showToast(t('error.nameRequired'));
    if (nameInput) nameInput.focus();
    return;
  }
  const hypoInput = $('hypothesis');
  const hypo = hypoInput ? hypoInput.value.trim() : '';

  const r = guard(() => saveOnDeck(state, {
    name,
    hypothesis: hypo || undefined,
    scene: appliedTemplate ? appliedTemplate.scene : undefined,
    templateId: appliedTemplate ? appliedTemplate.templateId : undefined
  }));
  if (!r) return;
  commit(r.state);
  awardEnergy(2, REASONS.ON_DECK, name);
  triggerEnergyReward(2, '念头入库');
  renderEnergy();
  showToast(t('toast.savedToPool'));

  if (nameInput) nameInput.value = '';
  if (hypoInput) hypoInput.value = '';
  clearAppliedTemplate();
  toggleTimingDrawer(false);
  setHypoExpanded(false);
  renderNow();
  renderOnDeck();
}

function doSavePoolQuick() {
  const input = $('poolQuickInput');
  const val = input ? input.value.trim() : '';
  if (!val) {
    showToast(t('error.nameRequired'));
    if (input) input.focus();
    return;
  }
  const r = guard(() => saveOnDeck(state, { name: val }));
  if (!r) return;
  commit(r.state);
  awardEnergy(2, REASONS.ON_DECK, val);
  triggerEnergyReward(2, '念头入库');
  renderEnergy();
  if (input) input.value = '';
  renderOnDeck();
  showToast(t('toast.savedToPool'));
}

function doLaunchOnDeck(taskId) {
  const mins = Math.max(1, parseFloat($('dur').value) || 15);
  const r = guard(() => resumeLater(state, { taskId, plannedMs: mins * 60000 }));
  if (!r) return;
  unlockAudio();
  commit(r.state);
  awardEnergy(5, REASONS.LAUNCH, r.task ? r.task.name : '');
  triggerEnergyReward(5, '破冰启动');
  renderEnergy();
  trackEvent('resume_started', { sessionId: r.session.sessionId, entryMode: 'planned' });
  switchView('now');
  showToast(t('toast.resumed', { d: dur(mins * 60000) }));
  renderNow();
}

function doDismissOnDeck(taskId) {
  const r = guard(() => dismissOnDeck(state, taskId));
  if (!r) return;
  commit(r.state);
  showToast(t('toast.stopped'));
  renderNow();
  renderOnDeck();
}

function doCompleteOnDeck(taskId) {
  const r = guard(() => completeOnDeck(state, taskId));
  if (!r) return;
  commit(r.state);
  awardEnergy(5, 'complete', r.task ? r.task.name : '');
  triggerEnergyReward(5, '顺手搞定');
  renderEnergy();
  showToast(t('decision.completed'));
  renderNow();
  renderOnDeck();
}

let currentWakingTaskId = null;

function doRandomWake() {
  const pendingTasks = state.tasks.filter(t => t.status === 'later');
  if (!pendingTasks.length) {
    showToast(t('pool.empty'));
    return;
  }
  const picked = pendingTasks[Math.floor(Math.random() * pendingTasks.length)];
  currentWakingTaskId = picked.taskId;

  const overlay = $('wakeOverlay');
  if (overlay) {
    $('wakeTaskName').textContent = picked.name || t('entry.immediate.placeholderName');
    const hypoBox = $('wakeHypoBox');
    if (picked.hypothesis) {
      hypoBox.style.display = 'flex';
      $('wakeHypoText').textContent = picked.hypothesis;
    } else {
      hypoBox.style.display = 'none';
    }
    overlay.style.display = 'flex';
  } else {
    doLaunchOnDeck(picked.taskId);
    showToast(t('toast.randomAwakened', { name: picked.name || t('entry.immediate.placeholderName') }));
  }
}

function renderConversionFunnel() {
  const card = $('conversionFunnelCard');
  if (!card) return;

  const totalTasks = state.tasks.length;
  const launchedTasks = state.tasks.filter(t => {
    return sessionsOf(state, t.taskId).length > 0 || state.decisions.some(d => d.taskId === t.taskId);
  }).length;

  const stoppedDecisions = state.decisions.filter(d => (d.kind === 'stop' && !d.completed) || d.kind === 'switch').length
    + state.sessions.filter(s => s.status === 'cancelled').length;

  const completedCount = state.decisions.filter(d => d.completed === true).length
    + state.tasks.filter(t => t.status === 'completed' && !state.decisions.some(d => d.taskId === t.taskId && d.completed)).length;

  const launchRate = totalTasks > 0 ? Math.round((launchedTasks / totalTasks) * 100) : 0;
  const completeRate = launchedTasks > 0 ? Math.round((completedCount / launchedTasks) * 100) : 0;

  setText('funnelRecordedNum', totalTasks);
  setText('funnelLaunchedNum', launchedTasks);
  setText('funnelStoppedNum', stoppedDecisions);
  setText('funnelCompletedNum', completedCount);

  const lRateEl = $('funnelLaunchRate');
  if (lRateEl) lRateEl.textContent = t('funnel.step2.sub', { rate: launchRate });

  const cRateEl = $('funnelCompleteRate');
  if (cRateEl) cRateEl.textContent = t('funnel.step4.sub', { rate: completeRate });

  const barLaunch = $('funnelBarLaunch');
  const barStop = $('funnelBarStop');
  const barComplete = $('funnelBarComplete');
  if (barLaunch) barLaunch.style.width = Math.min(100, launchRate) + '%';
  if (barStop) barStop.style.width = Math.min(100, totalTasks > 0 ? Math.round((stoppedDecisions / Math.max(1, launchedTasks)) * 100) : 0) + '%';
  if (barComplete) barComplete.style.width = Math.min(100, completeRate) + '%';

  const insightEl = $('funnelInsight');
  if (insightEl) {
    insightEl.textContent = stoppedDecisions > 0
      ? t('funnel.insight.stopped', { n: stoppedDecisions })
      : t('funnel.insight.default');
  }
}

/* ==========================================================================
   渲染：现在这一轮
   ========================================================================== */

let creatorExpanded = false;

function renderNow() {
  const ul = $('nowlist');
  if (!ul) return;
  ul.innerHTML = '';
  const rounds = openRounds();

  const creator = $('creatorCard');
  const toggleWrap = $('creatorToggleWrap');
  const toggleBtn = $('btnToggleCreator');
  const toggleText = $('btnToggleCreatorText');
  const btnCancel = $('btnCancelCreator');

  if (toggleBtn && !toggleBtn._bound) {
    toggleBtn._bound = true;
    toggleBtn.onclick = () => {
      creatorExpanded = true;
      renderNow();
      const nameInput = $('name');
      if (nameInput) nameInput.focus();
    };
  }

  if (btnCancel && !btnCancel._bound) {
    btnCancel._bound = true;
    btnCancel.onclick = () => {
      creatorExpanded = false;
      renderNow();
    };
  }

  if (!window._escCreatorBound) {
    window._escCreatorBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && creatorExpanded && openRounds().length > 0) {
        creatorExpanded = false;
        renderNow();
      }
    });
  }

  if (rounds.length > 0) {
    if (toggleWrap) {
      toggleWrap.style.display = creatorExpanded ? 'none' : 'block';
      if (toggleText) toggleText.textContent = t('now.addAnother');
    }
    if (creator) {
      creator.style.display = creatorExpanded ? 'block' : 'none';
    }
    if (btnCancel) {
      btnCancel.style.display = creatorExpanded ? 'inline-flex' : 'none';
    }
  } else {
    if (toggleWrap) toggleWrap.style.display = 'none';
    if (creator) creator.style.display = 'block';
    if (btnCancel) btnCancel.style.display = 'none';
  }

  const nowBadge = $('nowBadge');
  if (nowBadge) {
    if (rounds.length > 0) {
      nowBadge.textContent = String(rounds.length);
      nowBadge.style.display = 'inline-flex';
    } else {
      nowBadge.style.display = 'none';
    }
  }

  const nowTitleBar = document.querySelector('#viewNow .sect-title-bar');
  if (nowTitleBar) {
    nowTitleBar.style.display = rounds.length ? 'flex' : 'none';
  }

  const fsBtn = $('btnFsBoard');
  if (fsBtn) {
    fsBtn.style.display = rounds.length ? 'inline-flex' : 'none';
    fsBtn.onclick = () => openFullscreen(0, rounds.length > 1 ? 'grid' : 'single');
  }

  if (!rounds.length) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.innerHTML = '<div class="empty-icon">⏱</div><div class="empty-desc"></div>';
    li.querySelector('.empty-desc').textContent = t('now.empty') + ' ' + t('now.empty.hint');
    ul.appendChild(li);
    if (fsActive) closeFullscreen();
    renderOnDeck();
    renderEnergy();
    return;
  }

  const now = Date.now();
  for (const { session, task } of rounds) {
    const li = document.createElement('li');
    const over = now >= session.deadlineAt;
    li.className = 'timer-card' + (over ? ' expired' : '');

    const totals = taskTotals(state, task.taskId);
    const lastContinue = [...state.decisions].reverse()
      .find(d => d.taskId === task.taskId && d.kind === 'continue' && d.expectation);

    li.innerHTML = `
      <div class="timer-top">
        <div class="timer-name-group">
          <span class="timer-name"></span>
          <span class="now-checkin${over ? ' overdue' : ''}"></span>
        </div>
      </div>
      <div class="timer-hypo-row"><span class="timer-hypo-tag">🎯</span><span class="timer-hypo-text"></span></div>
      <div class="timer-main">
        <div class="timer-clock-wrap">
          <div class="timer-countdown">00:00</div>
        </div>
        <div class="timer-actions">
          <button class="btn-done" type="button"><span class="btn-done-text"></span></button>
          <div class="timer-actions-sub">
            <button class="btn-pip" type="button"></button>
            <button class="btn-fs" type="button"></button>
            <button class="btn-abandon" type="button"></button>
          </div>
        </div>
      </div>
      <div class="now-faint"></div>
      <div class="progress-track"><i class="progress-fill"></i></div>`;

    li.querySelector('.timer-name').textContent = task.name || t('entry.immediate.placeholderName');
    li.querySelector('.timer-name').title = task.name;
    li.querySelector('.now-checkin').textContent = over
      ? t('now.overdue')
      : t('now.checkinAt', { time: hhmm(session.deadlineAt) });

    const hypoRow = li.querySelector('.timer-hypo-row');
    if (task.hypothesis) {
      hypoRow.querySelector('.timer-hypo-text').textContent = task.hypothesis;
      hypoRow.style.display = 'flex';
    } else {
      hypoRow.style.display = 'none';
    }

    // 累计投入弱显示，并与「再投入会得到什么」配对
    const faint = li.querySelector('.now-faint');
    const bits = [];
    if (session.legacyPlanned && Number.isFinite(session.plannedMs)) {
      bits.push(t('time.legacyPlanned') + ' ' + dur(session.plannedMs));
    } else if (totals.elapsedMs > 0 || Number.isFinite(session.startedAt)) {
      const cum = totals.elapsedMs + (effectiveElapsedMs(session, now) || 0);
      bits.push(t('now.cumulative', { d: dur(cum) }));
    } else {
      bits.push(t('time.noRecord'));
    }
    if (lastContinue) bits.push(t('field.expectation') + ' ' + lastContinue.expectation);
    for (const b of bits) {
      const s = document.createElement('span');
      s.textContent = b;
      faint.appendChild(s);
    }
    if (over) {
      const s = document.createElement('span');
      s.className = 'now-overdue-chip';
      s.dataset.overdue = session.sessionId;
      s.textContent = t('now.overdueWaiting', { d: dur(overdueMs(session, now)) }) + paren(t('now.overdueWaiting.hint'));
      faint.appendChild(s);
    }

    const actions = li.querySelector('.timer-actions');
    if (!over) {
      // 运行中：主操作为「提早结束」，次操作为「废弃本次 (✕)」
      actions.innerHTML = `
        <button class="btn-done btn-end-early" type="button" title="${t('now.endEarly')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span class="btn-done-text">${t('now.endEarly')}</span>
        </button>
        <button class="btn-pip" type="button" title="${t('now.pip')}">⧉</button>
        <button class="btn-fs" type="button" title="${t('now.fullscreen')}">⛶</button>
        <button class="btn-abandon" type="button" title="${t('decision.cancel')}">✕</button>
      `;

      actions.querySelector('.btn-end-early').onclick = () => {
        openReassess({ sessionId: session.sessionId, early: true });
      };
    } else {
      // 到点（超时）：直接平权展示「就到这里」「换个办法」「+15 分钟」，零弹窗直接操作
      actions.innerHTML = `
        <button class="btn-done btn-stop-here" type="button" title="${t('now.stopHere')}">
          <span>${t('now.stopHere')}</span>
        </button>
        <button class="btn-switch-inline" type="button" title="${t('now.switchMethod')}">
          <span>${t('now.switchMethod')}</span>
        </button>
        <button class="btn-continue-inline" type="button" title="${t('now.extend15')}">
          <span>${t('now.extend15')}</span>
        </button>
        <button class="btn-pip" type="button" title="${t('now.pip')}">⧉</button>
        <button class="btn-fs" type="button" title="${t('now.fullscreen')}">⛶</button>
        <button class="btn-abandon" type="button" title="${t('decision.cancel')}">✕</button>
      `;

      actions.querySelector('.btn-stop-here').onclick = () => {
        const eff = effectiveElapsedMs(session, Date.now());
        reminders.cancel(session.sessionId);
        unlockAudio();
        const r = guard(() => decide(state, {
          sessionId: session.sessionId,
          kind: 'stop',
          completed: false
        }));
        if (!r) return;
        commit(r.state, { flush: true });
        awardEnergy(10, REASONS.DECISION, '就此收场');
        triggerEnergyReward(10, '清醒决断');
        renderEnergy();
        trackEvent('decision_confirmed', { decisionId: r.decision.decisionId, decisionKind: 'stop' });
        showToast(t('toast.stoppedHere', { d: dur(eff) }));
      };

      actions.querySelector('.btn-switch-inline').onclick = () => {
        reminders.cancel(session.sessionId);
        unlockAudio();
        const r = guard(() => decide(state, {
          sessionId: session.sessionId,
          kind: 'switch'
        }));
        if (!r) return;
        commit(r.state, { flush: true });
        awardEnergy(10, REASONS.DECISION, '换个思路');
        triggerEnergyReward(10, '调整思路');
        renderEnergy();
        trackEvent('decision_confirmed', { decisionId: r.decision.decisionId, decisionKind: 'switch' });
        const nameInput = $('name');
        const hypoInput = $('hypothesis');
        if (nameInput) nameInput.value = task.name || '';
        if (hypoInput) hypoInput.value = '';
        $('dur').value = '30';
        document.querySelectorAll('.dur-chips-wrap .chip').forEach(c => c.classList.toggle('on', c.dataset.min === '30'));
        linkFromDur();
        const creator = $('creatorCard');
        if (creator) {
          creator.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          setTimeout(() => { if (hypoInput) hypoInput.focus(); }, 150);
        }
        showToast(t('toast.switchedMethod', { name: task.name || t('entry.immediate.placeholderName') }));
      };

      actions.querySelector('.btn-continue-inline').onclick = () => {
        reminders.cancel(session.sessionId);
        unlockAudio();
        const r = guard(() => decide(state, {
          sessionId: session.sessionId,
          kind: 'continue',
          continueMs: 15 * 60000
        }));
        if (!r) return;
        commit(r.state, { flush: true });
        awardEnergy(5, REASONS.LAUNCH, '继续投入');
        triggerEnergyReward(5, '继续推进');
        renderEnergy();
        trackEvent('decision_confirmed', { decisionId: r.decision.decisionId, decisionKind: 'continue' });
        trackEvent('session_started', { sessionId: r.session.sessionId, entryMode: r.session.entryMode });
        showToast(t('toast.extended15'));
      };
    }

    const pip = actions.querySelector('.btn-pip');
    if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) pip.style.display = 'none';
    else pip.onclick = () => togglePip(session.sessionId);

    const fs = actions.querySelector('.btn-fs');
    fs.onclick = () => openFullscreen(rounds.findIndex(r => r.session.sessionId === session.sessionId), 'single');

    const ab = actions.querySelector('.btn-abandon');
    ab.onclick = () => {
      showConfirmDialog({
        title: '确认取消这一轮？',
        desc: t('now.cancelRound.confirm'),
        confirmText: '确认取消',
        danger: true,
        onConfirm: () => {
          reminders.cancel(session.sessionId);
          const r = guard(() => cancelSession(state, { sessionId: session.sessionId }));
          if (!r) return;
          commit(r.state);
          showToast(t('toast.cancelled'));
        }
      });
    };

    li._refs = {
      left: li.querySelector('.timer-countdown'),
      bar: li.querySelector('.progress-fill'),
      sessionId: session.sessionId
    };
    ul.appendChild(li);
  }
  tick();
  renderOnDeck();
  renderEnergy();
}

/* ==========================================================================
   渲染：归档 · 复盘（按天列决定）
   ========================================================================== */

const KIND_KEY = { stop: 'decision.stop', switch: 'decision.switch', continue: 'decision.continue' };
const DAY_MS = 86400000;

/**
 * 复盘的全部出口收在标题栏右上那一个菜单里：今日复盘、导出、以及 Pro 用户的高级复盘。
 * 平铺成三枚胶囊时它们和记录本身抢注意力，而这三件事一天用不到一次。
 */
function renderReviewMenu() {
  const menu = $('reviewMenu');
  if (!menu) return;
  menu.innerHTML = '';
  const mk = (label, fn, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rv-menu-item' + (cls ? ' ' + cls : '');
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.onclick = () => { closeReviewMenu(); fn(); };
    menu.appendChild(b);
    return b;
  };
  mk(t('review.title'), openBriefing);
  mk(t('review.exportData'), () => downloadExport(state, 'export'));
  mk(t('adv.title'), openAdvanced);
}

function openReviewMenu() {
  renderReviewMenu();
  $('reviewMenu').hidden = false;
  $('reviewMenuBtn').setAttribute('aria-expanded', 'true');
}
function closeReviewMenu() {
  const menu = $('reviewMenu');
  if (!menu) return;
  menu.hidden = true;
  $('reviewMenuBtn').setAttribute('aria-expanded', 'false');
}

function deleteDecisionRecord(decisionId) {
  if (!decisionId) return;
  const idx = state.decisions.findIndex(d => d.decisionId === decisionId);
  if (idx === -1) return;

  const decision = state.decisions[idx];
  const targetSessionId = decision.sessionId;
  const targetTaskId = decision.taskId;

  const nextDecisions = state.decisions.filter(d => d.decisionId !== decisionId);

  // 若关联的 session 没有其它 decision，则一并清理
  let nextSessions = state.sessions;
  if (targetSessionId && !nextDecisions.some(d => d.sessionId === targetSessionId)) {
    nextSessions = state.sessions.filter(s => s.sessionId !== targetSessionId);
  }

  // 若关联的 task 没有其它 decision 或 session，则一并清理
  let nextTasks = state.tasks;
  if (targetTaskId && !nextDecisions.some(d => d.taskId === targetTaskId) && !nextSessions.some(s => s.taskId === targetTaskId)) {
    nextTasks = state.tasks.filter(t => t.taskId !== targetTaskId);
  }

  const nextState = {
    ...state,
    tasks: nextTasks,
    sessions: nextSessions,
    decisions: nextDecisions,
    updatedAt: Date.now()
  };

  commit(nextState, { flush: true });
  showToast(t('review.deleted'));
}

function renderReview() {
  closeReviewMenu();

  const host = $('reviewList');
  if (!host) return;
  host.innerHTML = '';

  // 「以后再看」的事项：唯一提供接续入口的地方
  const laters = state.tasks.filter(x => x.status === 'later');
  if (laters.length) {
    const box = document.createElement('div');
    box.className = 'rv-day';
    const head = document.createElement('div');
    head.className = 'rv-day-head';
    head.innerHTML = '<span class="rv-day-name"></span>';
    head.querySelector('.rv-day-name').textContent = t('status.later');
    box.appendChild(head);
    for (const task of laters) {
      const row = document.createElement('div');
      row.className = 'rv-row';
      row.innerHTML = '<div class="rv-row-top"><span class="rv-name"></span></div>';
      row.querySelector('.rv-name').textContent = task.name || t('entry.immediate.placeholderName');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rv-act';
      btn.style.alignSelf = 'flex-start';
      btn.textContent = t('resume.title');
      btn.onclick = () => doResume(task.taskId);
      row.appendChild(btn);
      box.appendChild(row);
    }
    host.appendChild(box);
  }

  const days = groupByDay(state).reverse();
  if (!days.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div class="empty-icon">📄</div><div class="empty-desc"></div>';
    empty.querySelector('.empty-desc').textContent = t('review.empty') + ' ' + t('review.empty.hint');
    host.appendChild(empty);
    return;
  }

  const todayKey = new Date().toLocaleDateString('sv-SE');   // sv-SE 就是 YYYY-MM-DD
  const now = Date.now();

  for (const day of days.slice(0, 30)) {
    const box = document.createElement('div');
    box.className = 'rv-day';
    const head = document.createElement('div');
    head.className = 'rv-day-head';
    head.innerHTML = '<span class="rv-day-name"></span><span class="rv-day-count"></span>';
    head.querySelector('.rv-day-name').textContent = day.day === todayKey ? t('review.today') : fmtDayKey(day.day);
    head.querySelector('.rv-day-count').textContent = nDecisions(day.decisions.length);
    box.appendChild(head);

    for (const d of [...day.decisions].reverse()) {
      const row = document.createElement('div');
      row.className = 'rv-row';

      const top = document.createElement('div');
      top.className = 'rv-row-top';
      top.innerHTML = `<span class="rv-time"></span><span class="rv-name"></span><div class="rv-row-actions"><span class="rv-tag"></span><button class="rv-restart-btn" type="button" title="${escapeHtml(t('action.restart') || '以此事项开启新计时')}" aria-label="${escapeHtml(t('action.restart') || '以此事项开启新计时')}">↺</button><button class="rv-del-btn" type="button" title="${escapeHtml(t('review.delete'))}" aria-label="${escapeHtml(t('review.delete'))}">×</button></div>`;
      top.querySelector('.rv-time').textContent = hhmm(d.at);
      top.querySelector('.rv-name').textContent = d.taskName || t('entry.immediate.placeholderName');
      const restartBtn = top.querySelector('.rv-restart-btn');
      if (restartBtn) {
        restartBtn.onclick = (e) => {
          e.stopPropagation();
          const taskName = d.taskName || '';
          $('name').value = taskName;
          switchView('now');
          creatorExpanded = true;
          renderNow();
          const nameInput = $('name');
          if (nameInput) {
            nameInput.focus();
            nameInput.select();
          }
        };
      }
      const delBtn = top.querySelector('.rv-del-btn');
      if (delBtn) {
        delBtn.onclick = (e) => {
          e.stopPropagation();
          if (confirm(t('review.delete.confirm'))) {
            deleteDecisionRecord(d.decisionId);
          }
        };
      }
      const tag = top.querySelector('.rv-tag');
      if (d.kind === 'stop') {
        if (d.completed) {
          tag.className = 'rv-tag kind-early';
          tag.textContent = t('now.endEarly');
        } else {
          tag.className = 'rv-tag kind-stop';
          tag.textContent = t('now.stopHere');
        }
      } else if (d.kind === 'switch') {
        tag.className = 'rv-tag kind-switch';
        tag.textContent = t('now.switchMethod');
      } else if (d.kind === 'continue') {
        tag.className = 'rv-tag kind-continue';
        tag.textContent = '+' + dur(d.continueMs || 15 * 60000);
      } else {
        tag.className = 'rv-tag kind-' + d.kind;
        tag.textContent = t(KIND_KEY[d.kind]) || d.kind;
      }
      row.appendChild(top);

      // 元数据行：清爽呼吸感文字排版（借鉴早期极简设计），彻底摒弃破碎的药丸徽章
      const meta = document.createElement('div');
      meta.className = 'rv-sub' + (d.legacyPlanned ? ' rv-legacy' : '');
      const metaParts = [];

      // 实测用时：若到点后超时才回来收尾，专注时长只算设定的重评点时长（有效投入），不把离开电脑的挂机时间虚报为用时
      const sess = d.sessionId ? findSession(state, d.sessionId) : null;
      const eff = sess && Number.isFinite(sess.startedAt)
        ? (effectiveElapsedMs(sess, sess.endedAt || d.at) ?? d.elapsedMs)
        : d.elapsedMs;

      if (eff !== null && eff !== undefined) {
        const timeStr = eff < 60000 ? (settings.locale === 'en' ? '< 1 min' : '< 1 分钟') : dur(eff);
        metaParts.push(`${t('time.elapsed')} <span class="rv-time-val">${timeStr}</span>`);
      } else if (d.legacyPlanned && d.plannedMs) {
        metaParts.push(`${t('time.legacyPlanned')} <span class="rv-time-val">${dur(d.plannedMs)}</span>`);
      }

      if (d.userEstimatedPriorMs !== null && d.userEstimatedPriorMs > 0) {
        metaParts.push(`${t('time.userEstimate')} <span class="rv-time-val">${dur(d.userEstimatedPriorMs)}</span>`);
      }
      if (d.later) {
        metaParts.push(t('decision.later'));
      }
      if (d.entryMode === 'immediate') {
        metaParts.push(t('review.entryImmediate'));
      }

      if (metaParts.length) {
        meta.innerHTML = metaParts.join(' · ');
        row.appendChild(meta);
      }

      // 设想或预期（如果有）
      const task = findTask(state, d.taskId);
      const hypo = d.expectation || (task && task.hypothesis) || '';
      if (hypo) {
        const el = document.createElement('div');
        el.className = 'rv-note-line';
        el.innerHTML = `<span class="rv-note-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle></svg></span><span class="rv-note-label">底线设想：</span><span class="rv-note-text">${escapeHtml(hypo)}</span>`;
        row.appendChild(el);
      }

      // 笔记（如果有）
      if (d.note) {
        const el = document.createElement('div');
        el.className = 'rv-note-line';
        el.innerHTML = `<span class="rv-note-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg></span><span class="rv-note-label">反思心得：</span><span class="rv-note-text">${escapeHtml(d.note)}</span>`;
        row.appendChild(el);
      }

      // 已有的隔日心得（静默展示，不打扰）
      if (d.followUp && (d.followUp.stillAgree !== null || d.followUp.feeling)) {
        const agree = d.followUp.stillAgree === true ? t('review.followUp.agree')
          : d.followUp.stillAgree === false ? t('review.followUp.disagree') : '';
        const feelingStr = [agree, d.followUp.feeling].filter(Boolean).join(' · ');
        if (feelingStr) {
          const el = document.createElement('div');
          el.className = 'rv-note-line';
          el.innerHTML = `<span class="rv-note-icon">🌱</span><span class="rv-note-label">${t('review.followUp')}：</span><span class="rv-note-text">${escapeHtml(feelingStr)}</span>`;
          row.appendChild(el);
        }
      }

      box.appendChild(row);
    }
    host.appendChild(box);
  }
}

function followUpPrompt(d) {
  const box = document.createElement('div');
  box.className = 'rv-followup';

  const badgeBar = document.createElement('div');
  badgeBar.className = 'rv-followup-badge-bar';
  badgeBar.innerHTML = '<span class="rv-followup-tag">🌱 隔日心境回访</span><span class="rv-followup-tip">脱离了当时的紧绷，回头看这次决断如何？</span>';
  box.appendChild(badgeBar);

  const ask = document.createElement('span');
  ask.className = 'ask';
  ask.textContent = t('review.followUp.ask');
  box.appendChild(ask);

  const actionWrap = document.createElement('div');
  actionWrap.className = 'rv-followup-action-wrap';

  const feeling = document.createElement('input');
  feeling.className = 'ra-input';
  feeling.placeholder = t('review.followUp.feeling');
  actionWrap.appendChild(feeling);

  const btnWrap = document.createElement('div');
  btnWrap.className = 'rv-followup-btns';

  const mk = (label, stillAgree, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-fu ' + (cls || '');
    b.textContent = label;
    b.onclick = () => {
      if (stillAgree === null) { box.remove(); return; }   // 跳过
      const r = guard(() => followUp(state, { decisionId: d.decisionId, stillAgree, feeling: feeling.value.trim() || undefined }));
      if (!r) return;
      commit(r.state);
      showToast(t('toast.followUpSaved'));
    };
    btnWrap.appendChild(b);
  };
  mk('👍 ' + t('review.followUp.yes'), true, 'fu-yes');
  mk('🤔 ' + t('review.followUp.no'), false, 'fu-no');
  mk(t('app.skip'), null, 'fu-skip');

  actionWrap.appendChild(btnWrap);
  box.appendChild(actionWrap);
  return box;
}

function doResume(taskId) {
  const mins = Math.max(1, parseFloat($('dur').value) || 30);
  const r = guard(() => resumeLater(state, { taskId, plannedMs: mins * 60000 }));
  if (!r) return;
  unlockAudio();
  commit(r.state);
  trackEvent('resume_started', { sessionId: r.session.sessionId, entryMode: 'planned' });
  switchView('now');
  showToast(t('toast.resumed', { d: dur(mins * 60000) }));
}

/* ==========================================================================
   渲染入口
   ========================================================================== */

function render() {
  renderNow();
  renderOnDeck();
  renderReview();
  renderBanners();
  updateSyncStatus();
  if (fsActive) renderFullscreen();
}

function openAuthModal() {
  const overlay = $('authModalOverlay');
  if (overlay) overlay.style.display = 'flex';
  if ($('aUser')) $('aUser').focus();
}

function closeAuthModal() {
  const overlay = $('authModalOverlay');
  if (overlay) overlay.style.display = 'none';
}

function renderAuth() {
  const user = getUser();
  const acct = $('acctName');
  if (acct) acct.textContent = user;
  // 账户分组永远在（未登录时它就是登录入口），只是里面显示哪几行随登录状态变
  const signedIn = Boolean(user);
  const set = (id, show) => { const el = $(id); if (el) el.hidden = !show; };
  set('setAccountSignedInRow', signedIn);
  set('setRecoveryRow', signedIn);
  set('setAccountSignInRow', !signedIn);
  updateSyncStatus('synced');
}

function renderAll() {
  fillStaticCopy();
  renderAuth();
  renderAppliedTemplate();
  render();
}

/* ==========================================================================
   视图与入口状态管理
   ========================================================================== */

let currentView = 'now'; // 'now' | 'pool' | 'review'

function switchView(view) {
  currentView = view || 'now';
  const isNow = currentView === 'now';
  const isPool = currentView === 'pool';
  const isRev = currentView === 'review';

  const vNow = $('viewNow');
  const vPool = $('viewPool');
  const vReview = $('viewReview');
  if (vNow) vNow.style.display = isNow ? 'block' : 'none';
  if (vPool) vPool.style.display = isPool ? 'block' : 'none';
  if (vReview) vReview.style.display = isRev ? 'block' : 'none';

  const tabNow = $('tabViewNow');
  const tabPool = $('tabViewPool');
  const tabRev = $('tabViewReview');
  if (tabNow) {
    tabNow.classList.toggle('on', isNow);
    tabNow.setAttribute('aria-selected', isNow ? 'true' : 'false');
  }
  if (tabPool) {
    tabPool.classList.toggle('on', isPool);
    tabPool.setAttribute('aria-selected', isPool ? 'true' : 'false');
  }
  if (tabRev) {
    tabRev.classList.toggle('on', isRev);
    tabRev.setAttribute('aria-selected', isRev ? 'true' : 'false');
  }

  if (isPool) renderOnDeck();
  if (isRev) {
    renderReview();
    renderConversionFunnel();
  }
}

let hypoExpanded = false;

let timingDrawerOpen = false;

function updateDurationPill() {
  const pill = $('currentDurationPill');
  if (!pill) return;
  if (currentTimingMode === 'when') {
    pill.textContent = t('launchpad.pillWhen');
  } else {
    const n = parseFloat($('dur') ? $('dur').value : 30) || 30;
    pill.textContent = n >= 60 && n % 60 === 0
      ? `${n / 60} 时`
      : t('launchpad.pillDuration', { d: n });
  }
}

function toggleTimingDrawer(open) {
  timingDrawerOpen = (open !== undefined) ? open : !timingDrawerOpen;
  const drawer = $('launchDrawer');
  const panel = $('timingDrawerPanel');
  const chevron = $('timingChevron');
  const btn = $('btnToggleTiming');
  if (panel) panel.style.display = timingDrawerOpen ? 'block' : 'none';
  if (drawer) {
    const hypoOpen = $('hypoInputContainer') && $('hypoInputContainer').style.display !== 'none';
    drawer.style.display = (timingDrawerOpen || hypoOpen) ? 'block' : 'none';
  }
  if (chevron) chevron.textContent = timingDrawerOpen ? '▴' : '▾';
  if (btn) btn.classList.toggle('active', timingDrawerOpen);
}

function setHypoExpanded(expanded) {
  hypoExpanded = expanded;
  const container = $('hypoInputContainer');
  const drawer = $('launchDrawer');
  const btn = $('btnToggleHypo');
  if (container) container.style.display = expanded ? 'block' : 'none';
  if (drawer) {
    const timingOpen = $('timingDrawerPanel') && $('timingDrawerPanel').style.display !== 'none';
    drawer.style.display = (expanded || timingOpen) ? 'block' : 'none';
  }
  if (btn) {
    btn.classList.toggle('active', expanded);
    const text = $('btnToggleHypoText');
    if (text) text.textContent = expanded ? t('launchpad.conditionClose') : t('launchpad.conditionAdd');
  }
  if (expanded) {
    const input = $('hypothesis');
    if (input) setTimeout(() => input.focus(), 50);
  }
}

/* ==========================================================================
   落地页 / 应用切换（没有登录墙：不登录也能完整使用）
   ========================================================================== */

function showLand(force) {
  fillStaticCopy();
  $('land').style.display = 'block';
  $('app').style.display = 'none';
  document.body.classList.add('landing');
  const back = $('landBack');
  if (back) back.style.display = 'none';
}

function showApp() {
  $('land').style.display = 'none';
  $('app').style.display = 'block';
  document.body.classList.remove('landing');
  switchView(currentView);
  setHypoExpanded(hypoExpanded);
  render();
}

function decideInitialView() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('auth') === '1' || params.get('login') === '1') {
      showLand(false);
      setTimeout(() => openAuthModal(), 120);
      return;
    }
    if (params.get('guest') === '1' || params.get('app') === '1') {
      LS.setItem(store.ENTERED_KEY, '1');
      showApp();
      return;
    }

    const hash = (location.hash || '').toLowerCase();
    const isLandingHash = hash === '#features' || hash === '#philosophy' || hash.startsWith('#land');
    if (params.get('land') === '1' || isLandingHash) {
      showLand(true);
      if (hash && hash !== '#') {
        setTimeout(() => {
          const el = document.querySelector(hash);
          if (el) scrollWithNavOffset(el);
        }, 120);
      }
      return;
    }
  } catch (e) {}
  // 默认访问根路径或点击 Logo 必须进入产品主页 / 落地页，绝不硬跳内部 App
  showLand(false);
}

/* ==========================================================================
   入口 A：先定个重评点
   ========================================================================== */

const pad2 = x => String(x).padStart(2, '0');
const toLocalInput = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
let currentTimingMode = 'dur'; // 'dur' | 'when'

function setTimingMode(mode) {
  currentTimingMode = mode;
  const isDur = mode === 'dur';
  const tabDur = $('tabTimingDur');
  const tabWhen = $('tabTimingWhen');
  const panelDur = $('timingDurPanel');
  const panelWhen = $('timingWhenPanel');
  if (tabDur) {
    tabDur.classList.toggle('on', isDur);
    tabDur.setAttribute('aria-selected', isDur ? 'true' : 'false');
  }
  if (tabWhen) {
    tabWhen.classList.toggle('on', !isDur);
    tabWhen.setAttribute('aria-selected', !isDur ? 'true' : 'false');
  }
  if (panelDur) panelDur.style.display = isDur ? '' : 'none';
  if (panelWhen) panelWhen.style.display = !isDur ? '' : 'none';

  if (!isDur && (!$('when').value || new Date($('when').value).getTime() <= Date.now())) {
    initWhenInput();
  }
  updateDurationPill();
}

function initWhenInput() {
  const defaultTarget = new Date(Date.now() + 30 * 60000);
  $('when').value = toLocalInput(defaultTarget);
}

function linkFromDur() {
  const n = parseFloat($('dur').value);
  document.querySelectorAll('.dur-chips-wrap .chip').forEach(c => {
    c.classList.toggle('on', parseFloat(c.dataset.min) === n);
  });
  const submitText = $('startSubmitText');
  if (submitText) {
    submitText.textContent = n > 0 ? `启动 ${n}m` : t('start.submit');
  }
  updateDurationPill();
}
function linkFromWhen() {
  const submitText = $('startSubmitText');
  if (submitText) {
    submitText.textContent = '启动指定时刻';
  }
  updateDurationPill();
}

function submitPlanned(e) {
  e.preventDefault();
  const nameErr = $('nameErr');
  nameErr.textContent = '';
  const name = $('name').value.trim();
  if (!name) { nameErr.textContent = t('error.nameRequired'); $('name').focus(); return; }

  let deadlineAt = 0;
  if (currentTimingMode === 'when') {
    deadlineAt = $('when').value ? new Date($('when').value).getTime() : 0;
    if (!deadlineAt) { nameErr.textContent = t('error.durationRequired'); return; }
    if (deadlineAt <= Date.now()) { nameErr.textContent = t('error.deadlinePast'); $('when').focus(); return; }
  } else {
    const n = parseFloat($('dur').value);
    if (!(n > 0)) { nameErr.textContent = t('error.durationRequired'); $('dur').focus(); return; }
    deadlineAt = Date.now() + n * 60000;
  }

  unlockAudio();
  // 场景不在开始时问（那是第三个可选字段，只会把主表单撑长）。
  // 它由套用的规则带进来，或者事后在复盘里补——高级复盘据此分组。
  const r = guard(() => startPlanned(state, {
    name,
    deadlineAt,
    hypothesis: $('hypothesis').value.trim() || undefined,
    scene: appliedTemplate ? appliedTemplate.scene : undefined,
    templateId: appliedTemplate ? appliedTemplate.templateId : undefined
  }));
  if (!r) return;
  commit(r.state);
  awardEnergy(5, REASONS.LAUNCH, name);
  triggerEnergyReward(5, '破冰启动');
  renderEnergy();
  trackEvent('session_started', { sessionId: r.session.sessionId, entryMode: 'planned' });
  showToast(t('toast.started', { time: hhmm(deadlineAt) }));

  creatorExpanded = false;
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
  $('name').value = '';
  $('hypothesis').value = '';
  clearAppliedTemplate();
  $('name').focus();
  linkFromDur();
}

/* ==========================================================================
   决策足迹 · 复盘
   ========================================================================== */

/* ==========================================================================
   统一重评面板：到点、提前收尾、全屏、画中画、列表上的继续都走这里
   ========================================================================== */

let raDraft = null, raTask = null, raSession = null, raKind = null, raContinueMs = 5 * 60000;

function openReassess(target) {
  const r = guard(() => openReassessment(state, target));
  if (!r) return;
  raDraft = r.draft;
  raTask = r.task;
  raSession = r.session;
  raKind = null;
  raContinueMs = 5 * 60000;

  // 打开重评就把这一轮排队中的铃停掉——用户已经回来了。
  if (raSession) reminders.cancel(raSession.sessionId);

  $('raTaskName').textContent = raTask.name || t('entry.immediate.placeholderName');
  const now = Date.now();
  if (raSession) {
    const elapsed = effectiveElapsedMs(raSession, now);
    const over = overdueMs(raSession, now);
    const parts = [];
    if (elapsed !== null) parts.push(t('reassess.elapsed', { d: dur(elapsed) }));
    if (over > 0) parts.push(t('now.overdueWaiting', { d: dur(over) }));
    const isEarly = !!(target && target.early);
    parts.unshift(isEarly ? '提前结束' : (r.draft.overdue ? t('reassess.overdue') : t('reassess.early')));
    $('raTaskTime').textContent = parts.join(' · ');
  } else {
    $('raTaskTime').textContent = t('reassess.noSession');
  }
  // 副标题只说一句给用户的话；这一轮的状态（到没到点、实测多久）归事项那一行。
  const isEarly = !!(target && target.early);
  $('raSub').textContent = isEarly ? '已提早结束。请确认归档状态或写下心得：' : t('reassess.subtitle');

  const hypoBox = $('raHypoBox');
  if (raTask.hypothesis) {
    hypoBox.style.display = 'flex';
    $('raHypoText').textContent = raTask.hypothesis;
  } else hypoBox.style.display = 'none';

  // 这一轮是从哪条规则开的，就把那条规则里的提醒语摆出来
  const tpl = raTask.templateId ? allTemplates().find(x => x.templateId === raTask.templateId) : null;
  const remBox = $('raReminderBox');
  if (tpl && tpl.reminderText) {
    remBox.style.display = 'flex';
    $('raReminderText').textContent = tpl.reminderText;
  } else remBox.style.display = 'none';

  // 用户估计的此前投入：只在**没有计时轮次**的即时重评里问。
  // 有计时记录时不问——那会把估计值和实测混在一起。
  const priorBox = $('raPriorBox');
  priorBox.style.display = raSession ? 'none' : 'flex';
  $('raPrior').value = '';

  $('raExpectation').value = '';
  $('raNote').value = '';
  $('raLater').checked = false;
  $('raCompleted').checked = isEarly;
  $('raContinueCustom').value = '';
  if ($('raNextHypo')) $('raNextHypo').value = '';
  $('raErr').textContent = '';
  document.querySelectorAll('#raContinuePanel .chip').forEach(c => c.classList.toggle('on', c.dataset.add === '5'));
  const optDetails = $('raOptionalDetails');
  if (optDetails) {
    optDetails.open = isEarly;
    optDetails.style.display = isEarly ? 'block' : 'none';
  }
  setRaKind(isEarly ? 'stop' : null);

  $('raOverlay').style.display = 'flex';
  trackEvent('reassessment_opened', {
    decisionId: raDraft.decisionId,
    entryMode: raDraft.entryMode,
    sessionId: raDraft.sessionId || undefined
  });
}

function updateConfirmBtnText() {
  const btn = $('raConfirmBtn');
  if (!btn) return;
  if (!raKind) {
    setText('raConfirmBtn', 'app.confirm');
  } else if (raKind === 'stop') {
    setText('raConfirmBtn', 'decision.confirm.stop');
  } else if (raKind === 'switch') {
    setText('raConfirmBtn', 'decision.confirm.switch');
  } else if (raKind === 'continue') {
    const custom = parseFloat($('raContinueCustom').value);
    const ms = custom > 0 ? custom * 60000 : raContinueMs;
    setText('raConfirmBtn', 'decision.confirm.continue', { d: dur(ms) });
  }
}

function setRaKind(kind) {
  raKind = kind;
  document.querySelectorAll('.ra-act').forEach(b => {
    const on = b.dataset.kind === kind;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $('raStopPanel').style.display = kind === 'stop' ? 'flex' : 'none';
  $('raSwitchPanel').style.display = kind === 'switch' ? 'flex' : 'none';
  $('raContinuePanel').style.display = kind === 'continue' ? 'flex' : 'none';
  if (kind === 'switch' && $('raNextHypo')) setTimeout(() => $('raNextHypo').focus(), 100);

  const optDetails = $('raOptionalDetails');
  if (optDetails) {
    optDetails.style.display = kind ? 'block' : 'none';
    if (!kind) optDetails.open = false;
  }
  $('raConfirmBtn').disabled = !kind;
  updateConfirmBtnText();
  $('raErr').textContent = '';
}

function closeReassess() {
  $('raOverlay').style.display = 'none';
  const optDetails = $('raOptionalDetails');
  if (optDetails) optDetails.open = false;
  raDraft = null; raTask = null; raSession = null; raKind = null;
  // 没做决定就关掉：这一轮还活着，铃按当前设置重新排上。
  reminders.syncWith(openRounds().map(x => x.session), effectiveSettings());
}

function confirmReassess() {
  if (!raDraft) return;
  if (!raKind) { $('raErr').textContent = t('reassess.subtitle'); return; }

  const input = {
    decisionId: raDraft.decisionId,
    taskId: raDraft.taskId,
    sessionId: raDraft.sessionId || undefined,
    entryMode: raDraft.entryMode,
    kind: raKind,
    note: $('raNote').value.trim() || undefined,
    expectation: $('raExpectation').value.trim() || undefined
  };
  if (!raSession) {
    // 分钟 → 毫秒。留空就是没估计，不写 0（「没说」和「说了 0 分钟」不是一回事）
    const priorMin = parseFloat($('raPrior').value);
    if (Number.isFinite(priorMin) && priorMin >= 0) input.userEstimatedPriorMs = { value: Math.round(priorMin * 60000) };
  }
  if (raKind === 'stop') {
    input.later = $('raLater').checked;
    input.completed = $('raCompleted').checked;
    if (input.later && input.completed) { $('raErr').textContent = t('decision.later.hint'); return; }
  }
  if (raKind === 'continue') {
    const custom = parseFloat($('raContinueCustom').value);
    input.continueMs = custom > 0 ? custom * 60000 : raContinueMs;
  }

  const closedId = raDraft.sessionId;
  const oldTaskName = (raTask && raTask.name) || (raDraft && raDraft.taskName) || t('entry.immediate.placeholderName');
  const nextHypo = $('raNextHypo') ? $('raNextHypo').value.trim() : '';

  const r = guard(() => decide(state, input));
  if (!r) return;
  if (closedId) reminders.cancel(closedId);
  unlockAudio();
  commit(r.state, { flush: true });
  awardEnergy(10, REASONS.DECISION, raKind);
  triggerEnergyReward(10, '清醒决断');
  renderEnergy();
  trackEvent('decision_confirmed', {
    decisionId: r.decision.decisionId,
    decisionKind: r.decision.kind,
    entryMode: r.decision.entryMode,
    sessionId: r.decision.sessionId || undefined
  });
  if (raKind === 'continue' && r.session) {
    trackEvent('session_started', { sessionId: r.session.sessionId, entryMode: r.session.entryMode });
  }

  closeReassess();

  if (!getToken()) {
    setTimeout(() => showMilestoneToast('first_decision'), 500);
  }

  if (raKind === 'switch') {
    // 换个办法：上一轮已止损归档，自动为用户准备新一轮输入，实现心智无缝衔接
    const nameInput = $('name');
    const hypoInput = $('hypothesis');
    if (nameInput) nameInput.value = oldTaskName;
    if (hypoInput) hypoInput.value = nextHypo || '';
    $('dur').value = '30';
    document.querySelectorAll('.dur-chips-wrap .chip').forEach(c => c.classList.toggle('on', c.dataset.min === '30'));
    linkFromDur();

    const creator = $('creatorCard');
    if (creator) {
      creator.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const target = nextHypo ? $('dur') : hypoInput;
      if (target) setTimeout(() => target.focus(), 150);
    }
    showToast(`已为「${oldTaskName}」止损（换个办法）。新思路已就绪，随时点击开始！`);
  } else {
    const msg = raKind === 'stop' ? t('toast.stopped') : t('toast.continued', { d: dur(input.continueMs) });
    showToast(msg);
  }
}

/* ==========================================================================
   全屏看板
   ========================================================================== */

let fsActive = false, fsMode = 'single', fsIndex = 0;

function openFullscreen(idx, mode) {
  const rounds = openRounds();
  if (!rounds.length) return;
  fsActive = true;
  fsIndex = Math.max(0, Math.min(rounds.length - 1, idx || 0));
  fsMode = rounds.length <= 1 ? 'single' : (mode || 'single');
  $('fsOverlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  } catch (e) { /* 全屏被拦就用固定覆盖层 */ }
  renderFullscreen();
}

function closeFullscreen() {
  fsActive = false;
  $('fsOverlay').style.display = 'none';
  document.body.style.overflow = '';
  try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); } catch (e) { /* 已退出 */ }
}

function renderFullscreen() {
  const rounds = openRounds();
  if (!rounds.length) { closeFullscreen(); return; }
  const now = Date.now();
  fsIndex = Math.max(0, Math.min(rounds.length - 1, fsIndex));
  const multi = rounds.length > 1;
  $('fsModeTabs').style.display = multi ? 'flex' : 'none';
  $('fsKbMulti').style.display = multi ? 'inline' : 'none';
  $('fsModeSingleBtn').classList.toggle('on', fsMode === 'single');
  $('fsModeGridBtn').classList.toggle('on', fsMode === 'grid');

  if (fsMode === 'grid' && multi) {
    $('fsStageSingle').style.display = 'none';
    $('fsStageGrid').style.display = 'flex';
    $('fsGridSubtitle').textContent = t('now.fs.activeCount', { n: rounds.length });
    const host = $('fsGridContainer');
    host.innerHTML = '';
    rounds.forEach(({ session, task }, i) => {
      const card = document.createElement('div');
      card.className = 'fs-card';
      card.innerHTML = `
        <div class="fs-card-top"><span class="fs-card-title"></span><span class="fs-card-badge"></span></div>
        <div class="fs-card-time">00:00</div>
        <div class="fs-card-track"><i class="fs-card-fill"></i></div>
        <div class="fs-card-footer">
          <span class="fs-card-eta"></span>
          <div class="fs-card-actions"><button class="btn-done" type="button"></button></div>
        </div>`;
      card.querySelector('.fs-card-title').textContent = task.name || t('entry.immediate.placeholderName');
      const isOver = (session.deadlineAt - now) <= 0;
      const b = card.querySelector('.btn-done');
      b.textContent = isOver ? t('now.stopHere') : t('now.endEarly');
      const badge = card.querySelector('.fs-card-badge');
      if (badge) {
        badge.textContent = isOver ? '#' + (i + 1) + ' · ' + (settings.locale === 'en' ? 'Waiting' : '待响应') : '#' + (i + 1);
        if (isOver) badge.classList.add('danger');
      }
      const eta = card.querySelector('.fs-card-eta');
      if (eta) eta.textContent = t('now.checkinAt', { time: hhmm(session.deadlineAt) });
      b.onclick = ev => {
        ev.stopPropagation();
        const eff = effectiveElapsedMs(session, Date.now());
        reminders.cancel(session.sessionId);
        unlockAudio();
        const out = guard(() => decide(state, {
          sessionId: session.sessionId,
          kind: 'stop',
          completed: !isOver
        }));
        if (!out) return;
        commit(out.state, { flush: true });
        renderFullscreen();
        if (!isOver) {
          showToast(t('toast.endedEarly', { name: task.name || t('entry.immediate.placeholderName'), d: dur(eff) }));
        } else {
          showToast(t('toast.stoppedHere', { d: dur(eff) }));
        }
      };
      card.onclick = () => { fsIndex = i; fsMode = 'single'; renderFullscreen(); };
      card._sessionId = session.sessionId;
      host.appendChild(card);
    });
  } else {
    fsMode = 'single';
    $('fsStageSingle').style.display = 'flex';
    $('fsStageGrid').style.display = 'none';
    const { session, task } = rounds[fsIndex];
    $('fsTaskTitle').textContent = task.name || t('entry.immediate.placeholderName');
    $('fsMindsetPrompt').textContent = task.hypothesis || t('app.promise');
    $('fsTimeStart').textContent = Number.isFinite(session.startedAt) ? hhmm(session.startedAt) : t('time.noRecord');
    $('fsTimeEnd').textContent = hhmm(session.deadlineAt);
    $('fsMetricCheckin').textContent = hhmm(session.deadlineAt);

    const bar = $('fsSwitcherBar');
    if (multi) {
      bar.style.display = 'flex';
      bar.innerHTML = '';
      rounds.forEach(({ task: tk }, i) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'fs-switch-pill' + (i === fsIndex ? ' on' : '');
        pill.textContent = (i + 1) + '. ' + (tk.name || t('entry.immediate.placeholderName'));
        pill.onclick = () => { fsIndex = i; renderFullscreen(); };
        bar.appendChild(pill);
      });
    } else { bar.style.display = 'none'; bar.innerHTML = ''; }
  }
  updateFullscreenClock();
}

function updateFullscreenClock() {
  if (!fsActive) return;
  const rounds = openRounds();
  if (!rounds.length) { closeFullscreen(); return; }
  const now = Date.now();
  $('fsWallClock').textContent = hhmm(now);

  if (fsMode === 'grid') {
    document.querySelectorAll('#fsGridContainer .fs-card').forEach((card, idx) => {
      const s = findSession(state, card._sessionId);
      if (!s) return;
      const left = (s.deadlineAt - now) / 1000;
      const isOver = left <= 0;
      card.querySelector('.fs-card-time').textContent = left > 0 ? fmtClock(left) : t('now.overdue');
      const span = s.deadlineAt - (s.startedAt || s.deadlineAt);
      const pct = span > 0 ? Math.min(100, Math.max(0, (1 - (left * 1000) / span) * 100)) : 100;
      card.querySelector('.fs-card-fill').style.width = pct + '%';
      card.classList.toggle('expired', isOver);
      const btn = card.querySelector('.btn-done');
      if (btn) btn.textContent = isOver ? t('now.stopHere') : t('now.endEarly');
      const badge = card.querySelector('.fs-card-badge');
      if (badge) {
        badge.textContent = isOver ? '#' + (idx + 1) + ' · ' + (settings.locale === 'en' ? 'Waiting' : '待响应') : '#' + (idx + 1);
        badge.classList.toggle('danger', isOver);
      }
      const eta = card.querySelector('.fs-card-eta');
      if (eta) eta.textContent = t('now.checkinAt', { time: hhmm(s.deadlineAt) });
    });
    return;
  }

  const { session } = rounds[Math.min(fsIndex, rounds.length - 1)];
  const left = (session.deadlineAt - now) / 1000;
  const span = session.deadlineAt - (session.startedAt || session.deadlineAt);
  const pct = span > 0 ? Math.min(100, Math.max(0, (1 - (left * 1000) / span) * 100)) : 100;
  $('fsCountdown').textContent = left > 0 ? fmtClock(left) : t('now.overdue');
  $('fsCountdown').classList.toggle('expired', left <= 0);
  $('fsTimelineBar').style.width = pct + '%';
  const eff = effectiveElapsedMs(session, now);
  $('fsMetricElapsed').textContent = eff === null ? t('time.noRecord') : dur(eff);
  $('fsTimeProgressText').textContent = Math.round(pct) + '%';
  const totals = taskTotals(state, session.taskId);
  $('fsMetricCum').textContent = session.legacyPlanned && Number.isFinite(session.plannedMs)
    ? dur(session.plannedMs)
    : dur(totals.elapsedMs + (eff || 0));
  const over = overdueMs(session, now);
  $('fsMetricOverdue').textContent = over > 0 ? dur(over) : '—';

  const pill = $('fsStatusPill');
  const aura = $('fsAura');
  if (left <= 0) {
    pill.className = 'fs-state-pill danger';
    pill.textContent = t('now.overdue');
    aura.className = 'fs-aura expired';
    $('fsTimelineBar').style.background = 'var(--danger)';
  } else if (span > 0 && left * 1000 <= span * 0.2) {
    pill.className = 'fs-state-pill warn';
    pill.textContent = t('now.checkinAt', { time: hhmm(session.deadlineAt) });
    aura.className = 'fs-aura warning';
    $('fsTimelineBar').style.background = 'var(--warn)';
  } else {
    pill.className = 'fs-state-pill';
    pill.textContent = t('status.active');
    aura.className = 'fs-aura';
    $('fsTimelineBar').style.background = 'var(--accent)';
  }

  // 动作按钮极简联动：倒计时中仅「提早结束」，到点后展示「就到这里」「换个办法」「+15 分钟」
  const isOver = left <= 0;
  const doneBtnText = $('fsDoneBtnText');
  const switchBtn = $('fsSwitchBtn');
  const continueBtn = $('fsContinueBtn');
  if (doneBtnText) {
    doneBtnText.textContent = isOver ? t('now.stopHere') : t('now.endEarly');
  }
  if (switchBtn) switchBtn.style.display = isOver ? 'inline-flex' : 'none';
  if (continueBtn) continueBtn.style.display = isOver ? 'inline-flex' : 'none';
}

/* ==========================================================================
   画中画悬浮小窗
   ========================================================================== */

let pipSessionId = null, pipStream = null;

function roundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function drawPip() {
  const canvas = $('pipCanvas');
  const session = pipSessionId ? findSession(state, pipSessionId) : null;
  if (!canvas || !session) return;
  const task = findTask(state, session.taskId);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, now = Date.now();
  const left = (session.deadlineAt - now) / 1000;
  const span = session.deadlineAt - (session.startedAt || session.deadlineAt);
  const pct = span > 0 ? Math.min(1, Math.max(0, 1 - (left * 1000) / span)) : 1;

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0f172a'); bg.addColorStop(1, '#1e293b');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

  const expired = left <= 0;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 14px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(expired ? t('now.overdue') : t('now.checkinAt', { time: hhmm(session.deadlineAt) }), 26, 44);

  ctx.fillStyle = '#f8fafc';
  ctx.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';
  let name = task ? (task.name || t('entry.immediate.placeholderName')) : '';
  while (ctx.measureText(name).width > 460 && name.length) name = name.slice(0, -1);
  ctx.fillText(name, 26, 82);

  ctx.font = '700 76px -apple-system, BlinkMacSystemFont, monospace';
  ctx.fillStyle = expired ? '#f87171' : '#f8fafc';
  ctx.textAlign = 'center';
  ctx.fillText(left > 0 ? fmtClock(left) : '00:00', w / 2, 180);

  if (task && task.hypothesis) {
    ctx.textAlign = 'left';
    ctx.font = '500 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#94a3b8';
    let sub = task.hypothesis;
    while (ctx.measureText(sub).width > 460 && sub.length) sub = sub.slice(0, -1);
    ctx.fillText(sub, 26, 218);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, 24, 236, w - 48, 10, 5); ctx.fill();
  ctx.fillStyle = expired ? '#ef4444' : '#10b981';
  roundRect(ctx, 24, 236, Math.max(10, (w - 48) * pct), 10, 5); ctx.fill();
}

async function togglePip(sessionId) {
  const video = $('pipVideo'), canvas = $('pipCanvas');
  if (!video || !canvas) return;
  if (document.pictureInPictureElement) {
    if (pipSessionId === sessionId) {
      try { await document.exitPictureInPicture(); } catch (e) { /* 已关闭 */ }
      pipSessionId = null;
      return;
    }
    pipSessionId = sessionId;
    drawPip();
    return;
  }
  pipSessionId = sessionId;
  drawPip();
  try {
    if (!pipStream) {
      pipStream = canvas.captureStream ? canvas.captureStream(30) : null;
      if (!pipStream) throw new Error('captureStream unsupported');
      video.srcObject = pipStream;
      await video.play();
    }
    await video.requestPictureInPicture();
  } catch (e) {
    showToast(t('toast.pipFailed'));
  }
}

if ('pictureInPictureEnabled' in document) {
  document.addEventListener('leavepictureinpicture', () => { pipSessionId = null; });
}

/* ==========================================================================
   今日复盘简报
   ========================================================================== */

let briefingData = null;

function openBriefing() {
  briefingData = todayReview(state);
  // 自然日按本机时区算（review.js 的 localDayBounds），所以把时区名一并标出来：
  // 跨时区看同一份记录时，得知道这些时刻是按哪个时区显示的。
  const tz = localTimeZone();
  $('briefingDate').textContent = fmtDayKey(briefingData.day) + (tz ? ' · ' + tz : '');

  const stats = $('briefingStats');
  stats.innerHTML = '';
  const rows = [
    [t('review.decisions'), String(briefingData.decisionCount)],
    [t('decision.stop'), String(briefingData.counts.stop)],
    [t('decision.switch'), String(briefingData.counts.switch)],
    [t('decision.continue'), String(briefingData.counts.continue)]
  ];
  for (const [label, val] of rows) {
    const box = document.createElement('div');
    box.className = 'briefing-stat-box';
    box.innerHTML = '<span class="briefing-stat-lbl"></span><span class="briefing-stat-val"></span>';
    box.querySelector('.briefing-stat-lbl').textContent = label;
    box.querySelector('.briefing-stat-val').textContent = val;
    stats.appendChild(box);
  }

  const list = $('briefingItemList');
  list.innerHTML = '';
  if (!briefingData.items.length) {
    const d = document.createElement('div');
    d.style.cssText = 'color:var(--ink3);font-size:13px;padding:16px 0;text-align:center';
    d.textContent = t('review.empty');
    list.appendChild(d);
  } else {
    for (const item of briefingData.items) {
      const row = document.createElement('div');
      row.className = 'briefing-item';
      row.innerHTML = `<div class="briefing-item-main">
          <div class="briefing-item-left"><span class="briefing-item-name"></span></div>
          <div class="briefing-item-right"><span class="briefing-item-time"></span></div>
        </div>`;
      row.querySelector('.briefing-item-name').textContent = item.name || t('entry.immediate.placeholderName');
      const bits = [t('status.' + item.status)];
      if (item.elapsedMs > 0) bits.push(t('time.elapsed') + ' ' + dur(item.elapsedMs));
      if (item.legacyPlannedMs > 0) bits.push(t('time.legacyPlanned') + ' ' + dur(item.legacyPlannedMs));
      row.querySelector('.briefing-item-time').textContent = bits.join(' · ');
      list.appendChild(row);
    }
  }
  $('briefingOverlay').style.display = 'flex';
}

function copyBriefing() {
  const md = todayReviewMarkdown(state, { locale: settings.locale, review: briefingData || undefined });
  navigator.clipboard.writeText(md)
    .then(() => showToast(t('toast.copied')))
    .catch(() => showToast(t('toast.copyFailed')));
}

function exportBriefingImage() {
  const data = briefingData || todayReview(state);
  const width = 1080;
  const rows = Math.max(1, data.items.length);
  const height = 360 + rows * 96;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#0b0f19'); bg.addColorStop(1, '#0f172a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#334155'; ctx.lineWidth = 3; ctx.strokeRect(20, 20, width - 40, height - 40);

  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 34px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(t('review.title'), 60, 96);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 22px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(data.day, width - 60, 96);

  ctx.textAlign = 'left';
  ctx.font = '500 20px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(`${t('review.decisions')}: ${data.decisionCount}  ·  ${t('decision.stop')} ${data.counts.stop}  ·  ${t('decision.switch')} ${data.counts.switch}  ·  ${t('decision.continue')} ${data.counts.continue}`, 60, 150);

  let y = 220;
  if (!data.items.length) {
    ctx.fillStyle = '#64748b';
    ctx.font = '19px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(t('review.empty'), 60, y);
    y += 80;
  } else {
    for (const item of data.items) {
      ctx.fillStyle = 'rgba(30,41,59,0.6)';
      ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1;
      roundRect(ctx, 60, y - 34, width - 120, 80, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 22px -apple-system, BlinkMacSystemFont, sans-serif';
      let nm = item.name || t('entry.immediate.placeholderName');
      while (ctx.measureText(nm).width > 620 && nm.length) nm = nm.slice(0, -1);
      ctx.fillText(nm, 84, y);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
      const bits = [t('status.' + item.status)];
      if (item.elapsedMs > 0) bits.push(t('time.elapsed') + ' ' + dur(item.elapsedMs));
      if (item.legacyPlannedMs > 0) bits.push(t('time.legacyPlanned') + ' ' + dur(item.legacyPlannedMs));
      ctx.fillText(bits.join(' · '), 84, y + 26);
      y += 96;
    }
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#64748b';
  ctx.font = '17px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(t('review.footer'), width / 2, height - 60);

  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = t('review.title') + '-' + data.day + '.png';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    showToast(t('toast.exported'));
  }, 'image/png');
}

/* ==========================================================================
   设置
   ========================================================================== */

/**
 * 打开设置。`focusGroup` 给的是要展开并滚到的那一组的 id（比如从顶栏的同步状态点进账户）。
 * 其余分组保持各自的默认开合，不替用户全部展开。
 */
function openSettings(focusGroup) {
  $('setMaxAlerts').value = settings.reminderMaxAlerts;
  $('setInterval').value = Math.round(settings.reminderIntervalMs / 1000);
  $('setMuted').checked = settings.muted;
  $('setAnalytics').checked = settings.analytics;

  const langSel = $('setLanguage');
  langSel.innerHTML = '';
  for (const loc of ['zh-CN', 'en']) {
    const opt = document.createElement('option');
    opt.value = loc;
    opt.textContent = t('lang.' + loc);
    langSel.appendChild(opt);
  }
  langSel.value = settings.locale;

  renderSoundPickers();
  renderSoundList();
  renderAuth();
  $('settingsOverlay').style.display = 'flex';
  if (focusGroup) {
    const grp = $(focusGroup);
    if (grp) { grp.open = true; grp.scrollIntoView({ block: 'nearest' }); }
  }
}

function applySettings() {
  settings = store.normalizeSettings({
    ...settings,
    reminderMaxAlerts: $('setMaxAlerts').value,
    reminderIntervalMs: Number($('setInterval').value) * 1000,
    muted: $('setMuted').checked,
    analytics: $('setAnalytics').checked,
    preAlertMs: Number($('setPreAlert').value) * 60000,
    soundId: $('setSound').value
  });
  store.saveSettings(LS, settings);
  events.setEnabled(settings.analytics);
  if (settings.soundId && !soundCache.has(settings.soundId)) {
    // 换了默认铃声：解码完再整体重排一次，否则这一轮还会用基础铃
    sounds.decodeClip(ac, settings.soundId, soundCache).then(() => rescheduleReminders());
  }
  rescheduleReminders();
}

/* ==========================================================================
   账户：登录、注册、访客数据三选一、退出、找回码
   ========================================================================== */

let regMode = false;

async function doAuth() {
  const u = $('aUser').value.trim().toLowerCase();
  const p = $('aPass').value;
  const err = $('aErr');
  err.textContent = '';
  if (!u || !p) { err.textContent = t('auth.err.empty'); return; }
  const btn = $('aGo');
  btn.disabled = true;
  btn.textContent = t(regMode ? 'auth.submitting.register' : 'auth.submitting.login');
  try {
    const r = await fetch(API + (regMode ? '/register' : '/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error || t('auth.err.http', { status: r.status }); return; }
    await afterAuth(j.token, u, regMode);
  } catch (e) {
    err.textContent = t('auth.err.network');
  } finally {
    btn.disabled = false;
    btn.textContent = t(regMode ? 'auth.submit.register' : 'auth.submit.login');
  }
}

async function afterAuth(token, user, isNew) {
  LS.setItem(store.TOKEN_KEY, token);
  LS.setItem(store.USER_KEY, user);
  LS.setItem(store.ENTERED_KEY, '1');
  authExpired = false;

  // 本机访客数据：登录时显式三选一，云端拉取不得静默覆盖它
  const guest = store.readLocalState(LS, '') || createState({});
  const cloud = await fetchCloudState();
  cloudRev = cloud.rev;

  // 新注册的找回码等访客数据处理完再弹，两个浮层不能叠在一起
  pendingRecoveryCode = isNew === true;

  if (store.hasRecords(guest)) {
    pendingGuest = { guest, cloud: cloud.state, user };
    applyGuestChoice('merge');
    const count = (guest.tasks && guest.tasks.length) || 0;
    if (count > 0) showToast(t('auth.guestMerged', { n: count }));
    closeAuthModal();
    return;
  }
  syncMute = true;
  commit(cloud.state);
  syncMute = false;
  dirty = false;
  closeAuthModal();
  finishAuth(user);
}

let pendingRecoveryCode = false;

let pendingGuest = null;

async function fetchCloudState() {
  try {
    const r = await fetch(API + '/data', { headers: sync.getHeaders(getToken()) });
    const body = await r.json().catch(() => null);
    const c = sync.classifyGet(r.status, body, r.headers);
    if (c.kind === 'ok') return { state: c.state, rev: c.rev };
  } catch (e) { /* 拿不到就当空云端，本机数据不会被覆盖 */ }
  return { state: createState({}), rev: 0 };
}

function applyGuestChoice(choice) {
  if (!pendingGuest) return;
  const r = resolveGuestLogin(choice, { local: pendingGuest.guest, cloud: pendingGuest.cloud });
  $('guestOverlay').style.display = 'none';
  syncMute = true;
  commit(r.state);
  syncMute = false;
  store.clearGuestSlot(LS);                 // 账户数据不留在访客槽里
  store.saveLocalState(LS, state, pendingGuest.user);
  if (r.discarded) downloadExport(r.discarded, 'guest-discarded');   // 放弃的访客数据必须给导出
  dirty = choice !== 'cloud';
  finishAuth(pendingGuest.user);
  pendingGuest = null;
  if (dirty) schedulePush(true);
}

function finishAuth(user) {
  closeAuthModal();
  closeMilestoneToast();
  renderAll();
  showApp();
  reminders.cancelAll();
  reminders.syncWith(openRounds().map(r => r.session), effectiveSettings());
  if (pendingRecoveryCode) {
    pendingRecoveryCode = false;
    showRecoveryCode();
  }
}

function doSignOut() {
  $('settingsOverlay').style.display = 'none';
  flushPush();
  const user = getUser();
  state = store.signOut(LS, user);     // 只清该账户本机快照，不动云端，也不留给访客
  cloudRev = 0;
  dirty = false;
  reminders.cancelAll();
  // 权益跟着账户走：退出后立刻退回免费档，Pro 能力当场收回。
  // 不这么做的话，同一台设备上的下一个人会白捡一个 Pro。
  refreshEntitlement();
  renderAll();
  decideInitialView();
}

async function showRecoveryCode() {
  try {
    const r = await fetch(API + '/recovery/code', { method: 'POST', headers: { Authorization: 'Bearer ' + getToken() } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.code) return;
    $('rcValue').textContent = j.code;
    $('recoveryOverlay').style.display = 'flex';
  } catch (e) { /* 拿不到找回码不阻塞登录；设置页里可以再生成 */ }
}

async function doRecover() {
  const err = $('rcErr');
  err.textContent = '';
  const u = $('rcUser').value.trim().toLowerCase();
  const code = $('rcCode').value.trim();
  const p = $('rcPass').value;
  if (!u || !code || !p) { err.textContent = t('auth.err.empty'); return; }
  try {
    const r = await fetch(API + '/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, code, password: p })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) { err.textContent = j.error || t('recovery.failed'); return; }
    showToast(t('recovery.done'));
    await afterAuth(j.token, u, false);
  } catch (e) {
    err.textContent = t('auth.err.network');
  }
}

/* ==========================================================================
   心跳
   ========================================================================== */

function tick() {
  const now = Date.now();
  const rounds = openRounds();
  let nearest = Infinity, anyOver = false;

  let needRerender = false;
  document.querySelectorAll('#nowlist .timer-card').forEach(li => {
    const refs = li._refs;
    if (!refs) return;
    const s = findSession(state, refs.sessionId);
    if (!s) return;
    const left = (s.deadlineAt - now) / 1000;
    const wasExpired = li.classList.contains('expired');
    const isExpired = left <= 0;
    if (wasExpired !== isExpired) {
      needRerender = true;
    }
    refs.left.textContent = fmtClock(Math.max(0, left));
    // 到点那一刻卡片不重建，所以「重评时刻」这块提示要在心跳里翻面
    const chipEl = li.querySelector('.now-checkin');
    if (chipEl) {
      chipEl.classList.toggle('overdue', left <= 0);
      chipEl.textContent = left <= 0 ? t('now.overdue') : t('now.checkinAt', { time: hhmm(s.deadlineAt) });
    }
    const span = s.deadlineAt - (s.startedAt || s.deadlineAt);
    const pct = span > 0 ? Math.min(100, Math.max(0, (1 - (left * 1000) / span) * 100)) : 100;
    refs.bar.style.width = pct + '%';
    refs.bar.style.background = left <= 0 ? 'var(--danger)'
      : (left * 1000 > span * 0.2 ? 'var(--accent)' : 'var(--warn)');
    li.classList.toggle('expired', left <= 0);
    const chip = li.querySelector('[data-overdue]');
    if (chip) chip.textContent = t('now.overdueWaiting', { d: dur(overdueMs(s, now)) }) + paren(t('now.overdueWaiting.hint'));
  });

  if (needRerender) {
    renderNow();
    return;
  }

  for (const { session, task } of rounds) {
    const left = (session.deadlineAt - now) / 1000;
    if (left <= 0) {
      anyOver = true;
      let rt = runtime.get(session.sessionId);
      if (!rt) { rt = { notified: false }; runtime.set(session.sessionId, rt); }
      if (!rt.notified) {
        rt.notified = true;
        notify(task.name);
        trackEvent('reminder_trigger_observed', { sessionId: session.sessionId });
      }
    } else nearest = Math.min(nearest, left);
  }

  document.title = anyOver
    ? '⏰ ' + t('reassess.title')
    : (nearest < Infinity ? fmtClock(nearest) + ' · ' + t('app.name') : t('app.name'));

  if (pipSessionId && document.pictureInPictureElement) drawPip();
  if (fsActive) updateFullscreenClock();

  // 每分钟一次的「超时待响应」重绘由 renderNow 负责；这里只更新数字，不重建 DOM。
}


/* ==========================================================================
   语言切换
   ==========================================================================
   所有可见文案都走 t()（表在 packages/core/copy.js）；这里只负责换语言并整页重绘。
   语言存在本机的顶层键 sl.locale（sl.settings.locale 是同步写的副本，读取以顶层键优先）。
   首次打开跟随 navigator.language，之后以用户的选择为准。 */

function toggleLocale() {
  const next = settings.locale === 'en' ? 'zh-CN' : 'en';
  setLocale(next);
}

function setLocale(locale) {
  const next = locale === 'en' ? 'en' : 'zh-CN';
  if (next === settings.locale) return;
  settings = store.normalizeSettings({ ...settings, locale: next });
  store.saveSettings(LS, settings);
  try {
    localStorage.setItem('sl.locale', next);
    document.cookie = 'sl.locale=' + next + '; path=/; max-age=31536000; samesite=lax';
  } catch (e) {}
  intlCache.clear();                      // Intl 实例是按 locale 缓存的，换语言必须丢掉旧的
  document.documentElement.lang = next;
  renderAll();
  if ($('templateOverlay') && $('templateOverlay').style.display === 'flex') renderTemplateOverlay();
  if ($('advOverlay') && $('advOverlay').style.display === 'flex') renderAdvanced();
  if ($('settingsOverlay') && $('settingsOverlay').style.display === 'flex') openSettings();
}

function closeAllLangMenus() {
  document.querySelectorAll('.lang-dropdown-menu').forEach(m => { m.style.display = 'none'; });
  document.querySelectorAll('.btn-nav-lang-drop, .btn-app-lang-drop').forEach(b => { b.setAttribute('aria-expanded', 'false'); });
}

function updateLangMenuStates() {
  const current = settings.locale === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('.lang-dropdown-menu').forEach(menu => {
    menu.querySelectorAll('.lang-menu-item').forEach(item => {
      const isCurrent = item.dataset.lang === current;
      item.classList.toggle('active', isCurrent);
      if (isCurrent) {
        item.setAttribute('aria-current', 'true');
      } else {
        item.removeAttribute('aria-current');
      }
    });
  });
}

function bindLangDropdown(wrapId, btnId, menuId) {
  const wrap = $(wrapId);
  const btn = $(btnId);
  const menu = $(menuId);
  if (!wrap || !btn || !menu) return;

  btn.onclick = (e) => {
    e.stopPropagation();
    const isHidden = menu.style.display === 'none' || window.getComputedStyle(menu).display === 'none';
    closeAllLangMenus();
    if (isHidden) {
      menu.style.display = 'block';
      btn.setAttribute('aria-expanded', 'true');
    }
  };

  menu.querySelectorAll('.lang-menu-item').forEach(item => {
    item.onclick = (e) => {
      e.stopPropagation();
      const targetLang = item.dataset.lang;
      setLocale(targetLang);
      closeAllLangMenus();
    };
  });
}

/**
 * 全站语言切换入口同步更新：
 * 1. 顶栏主界面语言下拉菜单 (#appLangWrap)
 * 2. 落地页顶栏导航语言下拉菜单 (#landLangWrap)
 * 3. 页脚语言文字链 (#footerLangLink)
 * 4. 设置面板中的语言下拉框 (#setLanguage)
 */
function renderLangLink() {
  const other = settings.locale === 'en' ? 'zh-CN' : 'en';
  const otherLabel = t('lang.' + other);
  const dropdownTitle = t('lang.dropdown.title') || '切换语言 / Switch language';

  updateLangMenuStates();

  const landBtn = $('landLangMenuBtn');
  if (landBtn) landBtn.title = dropdownTitle;

  const appBtn = $('appLangMenuBtn');
  if (appBtn) appBtn.title = dropdownTitle;

  const langBtnText = $('langBtnText');
  if (langBtnText) langBtnText.textContent = settings.locale === 'en' ? '中' : 'EN';
  const langBtn = $('langBtn');
  if (langBtn) {
    langBtn.title = dropdownTitle;
    langBtn.onclick = toggleLocale;
  }

  const legacyLandBtn = $('landLangBtn');
  if (legacyLandBtn) {
    legacyLandBtn.textContent = otherLabel;
    legacyLandBtn.title = dropdownTitle;
    legacyLandBtn.onclick = toggleLocale;
  }

  const footerLink = $('footerLangLink');
  if (footerLink) {
    footerLink.textContent = otherLabel;
    footerLink.title = dropdownTitle;
    footerLink.onclick = toggleLocale;
  }

  const setLang = $('setLanguage');
  if (setLang) setLang.value = settings.locale;
}

/* ==========================================================================
   Pro 能力一：自定义提醒（导入个人音频 / 预告 / 重复间隔 / 按事项绑定）
   ==========================================================================
   音频只存在这台设备的 IndexedDB 里（sl.sounds 库，clips 表），不上传、不进同步整包。 */

async function primeSounds() {
  if (!soundsUsable) return;
  try {
    soundsList = await sounds.listClips();
  } catch (e) {
    soundsUsable = false;                 // 隐私模式/配额用尽：降级回基础铃声，不影响使用
    soundsList = [];
  }
  // 预解码当前会用到的音频，到点时才能直接排到音频时钟上
  const wanted = new Set([settings.soundId, ...Object.values(settings.taskSounds)].filter(Boolean));
  for (const id of wanted) {
    if (soundCache.has(id)) continue;
    await sounds.decodeClip(ac, id, soundCache);
  }
  rescheduleReminders();
  // 下拉也要重画：primeSounds 是异步的，openSettings 那次渲染时列表还是空的，
  // 不补这一下，「默认铃声」会一直停在「基础预设铃声」上（实测）。
  renderSoundPickers();
  renderSoundList();
}

function renderSoundList() {
  const host = $('soundList');
  if (!host) return;
  host.innerHTML = '';
  const note = $('setSoundNote');
  if (!soundsUsable) {
    if (note) { note.className = 'pro-note err'; note.textContent = t('sound.unsupported'); }
    return;
  }
  if (!soundsList.length) {
    const d = document.createElement('div');
    d.className = 'tpl-item-meta';
    d.textContent = t('sound.none');
    host.appendChild(d);
    return;
  }
  for (const clip of soundsList) {
    const row = document.createElement('div');
    row.className = 'tpl-item';
    row.innerHTML = '<div class="tpl-item-top"><span class="tpl-item-name"></span></div>'
      + '<span class="tpl-item-meta"></span><div class="tpl-item-acts"></div>';
    row.querySelector('.tpl-item-name').textContent = clip.name;
    row.querySelector('.tpl-item-meta').textContent = sounds.formatSize(clip.size) + ' · ' + fmtDate(clip.addedAt);
    const acts = row.querySelector('.tpl-item-acts');
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'rv-act';
    play.textContent = t('sound.preview');
    play.onclick = async () => {
      unlockAudio();
      const buf = await sounds.decodeClip(ac, clip.id, soundCache);
      if (buf) beepAt(0, { buffer: buf }); else beepAt(0);
    };
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rv-act';
    del.textContent = t('sound.remove');
    del.onclick = async () => {
      try { await sounds.deleteClip(clip.id); } catch (e) { /* 删不掉就当没删，下面的设置清理照做 */ }
      soundCache.delete(clip.id);
      settings = store.forgetSound(settings, clip.id);   // 不留指向空气的 id
      store.saveSettings(LS, settings);
      soundsList = soundsList.filter(x => x.id !== clip.id);
      showToast(t('sound.removed'));
      renderSoundPickers();
      renderSoundList();
      rescheduleReminders();
    };
    acts.appendChild(play);
    acts.appendChild(del);
    host.appendChild(row);
  }
}

function renderSoundPickers() {
  const pre = $('setPreAlert');
  if (pre) {
    pre.innerHTML = '';
    for (const min of store.PRE_ALERT_CHOICES) {
      const opt = document.createElement('option');
      opt.value = String(min);
      opt.textContent = min === 0 ? t('prealert.off') : t('prealert.minutes', { n: min });
      pre.appendChild(opt);
    }
    pre.value = String(Math.round(settings.preAlertMs / 60000));
  }
  const sel = $('setSound');
  if (sel) {
    sel.innerHTML = '';
    const base = document.createElement('option');
    base.value = '';
    base.textContent = t('sound.builtin');
    sel.appendChild(base);
    for (const clip of soundsList) {
      const opt = document.createElement('option');
      opt.value = clip.id;
      opt.textContent = clip.name;
      sel.appendChild(opt);
    }
    sel.value = soundsList.some(c => c.id === settings.soundId) ? settings.soundId : '';
  }
}

async function importSound(file) {
  const note = $('setSoundNote');
  note.className = 'pro-note';
  note.textContent = '';
  try {
    const meta = await sounds.putClip(file);
    soundsList = [...soundsList, meta];
    unlockAudio();
    await sounds.decodeClip(ac, meta.id, soundCache);
    note.className = 'pro-note ok';
    note.textContent = t('sound.saved');
    renderSoundPickers();
    renderSoundList();
  } catch (e) {
    note.className = 'pro-note err';
    note.textContent = e && e.code === 'too_big' ? t('sound.tooBig')
      : e && e.code === 'bad_type' ? t('sound.badType')
        : t('sound.unsupported');
  }
}


/* ==========================================================================
   Pro 能力二：个人重评规则（模板）
   ==========================================================================
   内置例子对所有人可用；
   保存／编辑／复用自己的规则是 Pro。模板只是输入预设，套用它和手填开一轮产生的记录完全一样。 */

let tplEditingId = null;

const allTemplates = () => [...builtInTemplates(settings.locale), ...(state.templates || [])];

function sceneLabel(scene) {
  return scene ? t('scene.' + scene) : '';
}

function fillSceneSelect(el, value) {
  if (!el) return;
  el.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = t('scene.other');
  el.appendChild(blank);
  for (const scene of SCENES) {
    if (scene === 'other') continue;          // 「其它／不填写」就是上面那个空值，不重复给两次
    const opt = document.createElement('option');
    opt.value = scene;
    opt.textContent = t('scene.' + scene);
    el.appendChild(opt);
  }
  el.value = value || '';
}

/**
 * 模板选择器的下拉内容。**只在用户点开时才渲染**：默认收起，没选过模板时
 * 表单里除了那一行「用我的模板」之外不出现任何模板痕迹。
 * 免费用户看到 5 个内置例子，Pro 用户在下面多一段自己保存的规则。
 */
function renderTemplateMenu() {
  const menu = $('tplPickerMenu');
  if (!menu) return;
  menu.innerHTML = '';

  const add = (tpl) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tpl-menu-item';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = '<span class="tpl-name"></span><span class="tpl-sub"></span>';
    item.querySelector('.tpl-name').textContent = tpl.name;
    // 内置例子的名字本身就写着场景（「比价：到此为止」），再挂一个「比价」是重复；
    // 自己存的规则名字可能只是「下班前」，那时场景标签才有信息量。
    item.querySelector('.tpl-sub').textContent =
      [tpl.builtIn ? '' : sceneLabel(tpl.scene), tpl.hypothesis].filter(Boolean).join(' · ');
    item.onclick = () => { closeTemplateMenu(); applyTemplate(tpl); };
    menu.appendChild(item);
  };

  for (const tpl of builtInTemplates(settings.locale)) add(tpl);
  const mine = state.templates || [];
  if (mine.length) {
    const sep = document.createElement('div');
    sep.className = 'tpl-menu-sep';
    menu.appendChild(sep);
    for (const tpl of mine) add(tpl);
  }

  const sep2 = document.createElement('div');
  sep2.className = 'tpl-menu-sep';
  menu.appendChild(sep2);
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'tpl-menu-item';
  manage.setAttribute('role', 'menuitem');
  // 这颗按钮打开的是「新建 / 编辑 / 删除」那张表，标签就写「新建规则」，
  // 别写成「设置 · 个人重评规则」——那在英文里读起来像一条面包屑。
  manage.textContent = '＋ ' + t('template.new');
  manage.onclick = () => { closeTemplateMenu(); openTemplateOverlay(); };
  menu.appendChild(manage);
}

function openTemplateMenu() {
  renderTemplateMenu();
  const menu = $('tplPickerMenu');
  if (menu) menu.hidden = false;
  const btn = $('tplPickerBtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
}
function closeTemplateMenu() {
  const menu = $('tplPickerMenu');
  if (menu) menu.hidden = true;
  const btn = $('tplPickerBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/** 表单里那枚「已套用：xx」的小标。没套用模板时整个不存在。 */
function renderAppliedTemplate() {
  const box = $('tplApplied');
  if (!box) return;
  if (!appliedTemplate) { box.hidden = true; return; }
  box.hidden = false;
  $('tplAppliedText').textContent = t('template.current', { name: appliedTemplate.name });
}

/** 取消套用：只清掉这次开轮次要带的来源信息，已经填进表单的文字留给用户自己改。 */
function clearAppliedTemplate() {
  appliedTemplate = null;
  renderAppliedTemplate();
}

/** 套用规则：只填表单，不提交、不开轮次——按不按「开始」仍然由用户决定。 */
function applyTemplate(tpl) {
  if (tpl.hypothesis) {
    $('hypothesis').value = tpl.hypothesis;
    setHypoExpanded(true);
  }
  const durations = Array.isArray(tpl.durationsMs) ? tpl.durationsMs : [];
  if (durations.length) {
    const mins = Math.round(durations[0] / 60000);
    $('dur').value = String(mins);
    document.querySelectorAll('.dur-chips-wrap .chip').forEach(c => c.classList.toggle('on', Number(c.dataset.min) === mins));
    linkFromDur();
  }
  // 内置例子的 id 也记下来：到点时要靠它把这条规则的提醒语摆出来。
  // 内置 id 是固定字符串（builtin_*），删不掉也不占用户的模板容量。
  appliedTemplate = { templateId: tpl.templateId, scene: tpl.scene || undefined, reminderText: tpl.reminderText || '', name: tpl.name };
  renderAppliedTemplate();
  showToast(t('template.used', { name: tpl.name }));
  $('name').focus();
}

// 当前表单套用的是哪条规则：开轮次时把 scene / templateId 记到 Task 上，高级复盘才分得了组。
let appliedTemplate = null;

function openTemplateOverlay() {
  renderTemplateOverlay();
  $('templateOverlay').style.display = 'flex';
}

function renderTemplateOverlay() {
  setText('tplTitleText', 'template.title');
  setText('tplHint', 'template.hint');
  setText('tplBuiltinTitle', 'template.builtinTitle');
  setText('tplBuiltinHint', 'template.builtinHint');
  setText('tplMineTitle', 'template.mine');
  setText('tplNameLabel', 'template.name');
  setAttr('tplName', 'placeholder', 'template.name.placeholder');
  setText('tplHypoLabel', 'field.hypothesis');
  setAttr('tplHypo', 'placeholder', 'field.hypothesis.optional');
  setText('tplReminderLabel', 'template.reminderText');
  setAttr('tplReminder', 'placeholder', 'template.reminderText.placeholder');
  setText('tplSceneLabel', 'scene.pick');
  setText('tplDurationsLabel', 'template.durations');
  setAttr('tplDurations', 'placeholder', 'template.durations.placeholder');
  setText('tplSaveBtn', 'template.save');
  setText('tplResetBtn', 'app.cancel');

  const mkList = (host, list, opts) => {
    host.innerHTML = '';
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'tpl-item-meta';
      d.textContent = t('template.empty');
      host.appendChild(d);
      return;
    }
    for (const tpl of list) {
      const row = document.createElement('div');
      row.className = 'tpl-item';
      row.innerHTML = '<div class="tpl-item-top"><span class="tpl-item-name"></span><span class="tpl-scene tpl-item-meta"></span></div>'
        + '<span class="tpl-item-meta"></span><div class="tpl-item-acts"></div>';
      row.querySelector('.tpl-item-name').textContent = tpl.name;
      row.querySelector('.tpl-scene').textContent = sceneLabel(tpl.scene);
      const bits = [];
      if (tpl.hypothesis) bits.push(tpl.hypothesis);
      if (tpl.reminderText) bits.push(tpl.reminderText);
      if (tpl.durationsMs && tpl.durationsMs.length) bits.push(tpl.durationsMs.map(ms => dur(ms)).join(' / '));
      row.querySelectorAll('.tpl-item-meta')[1].textContent = bits.join(' · ');
      const acts = row.querySelector('.tpl-item-acts');
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'rv-act';
      use.textContent = t('template.use');
      use.onclick = () => { applyTemplate(tpl); $('templateOverlay').style.display = 'none'; };
      acts.appendChild(use);
      if (opts && opts.editable) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'rv-act';
        edit.textContent = t('template.edit');
        edit.onclick = () => loadTemplateIntoEditor(tpl);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'rv-act';
        del.textContent = t('template.delete');
        del.onclick = () => {
          if (!confirm(t('template.delete.confirm'))) return;
          const r = guard(() => deleteTemplate(state, tpl.templateId));
          if (!r) return;
          commit(r.state);
          if (tplEditingId === tpl.templateId) resetTemplateEditor();
          // 删掉的正好是表单当前套用的那条：来源信息一并清掉，别留下指向空气的 templateId
          if (appliedTemplate && appliedTemplate.templateId === tpl.templateId) clearAppliedTemplate();
          renderTemplateOverlay();
        };
        acts.appendChild(edit);
        acts.appendChild(del);
      }
      host.appendChild(row);
    }
  };

  mkList($('tplBuiltinList'), builtInTemplates(settings.locale), { editable: false });
  mkList($('tplMineList'), state.templates || [], { editable: true });
  fillSceneSelect($('tplScene'), $('tplScene').value);
}

function loadTemplateIntoEditor(tpl) {
  tplEditingId = tpl.templateId;
  $('tplName').value = tpl.name || '';
  $('tplHypo').value = tpl.hypothesis || '';
  $('tplReminder').value = tpl.reminderText || '';
  fillSceneSelect($('tplScene'), tpl.scene);
  $('tplDurations').value = (tpl.durationsMs || []).map(ms => Math.round(ms / 60000)).join(' ');
  $('tplNameErr').textContent = '';
  $('tplName').focus();
}

function resetTemplateEditor() {
  tplEditingId = null;
  $('tplName').value = '';
  $('tplHypo').value = '';
  $('tplReminder').value = '';
  fillSceneSelect($('tplScene'), '');
  $('tplDurations').value = '';
  $('tplNameErr').textContent = '';
}

function submitTemplate() {
  const err = $('tplNameErr');
  err.textContent = '';
  const name = $('tplName').value.trim();
  if (!name) { err.textContent = t('template.nameRequired'); $('tplName').focus(); return; }
  const durationsMs = $('tplDurations').value.split(/[^0-9.]+/)
    .map(x => parseFloat(x))
    .filter(n => Number.isFinite(n) && n > 0)
    .map(n => Math.round(n * 60000));
  const input = {
    templateId: tplEditingId || undefined,
    name,
    hypothesis: $('tplHypo').value.trim() || undefined,
    reminderText: $('tplReminder').value.trim() || undefined,
    scene: $('tplScene').value || undefined,
    durationsMs
  };
  const r = guard(() => saveTemplate(state, input));
  if (!r) {
    // guard 已经把容量满提示出去了；这里补一句更贴近这个场景的话
    err.textContent = t('template.full', { limit: LIMITS.templates });
    return;
  }
  commit(r.state);
  resetTemplateEditor();
  renderTemplateOverlay();
  showToast(t('template.saved'));
}

/* ==========================================================================
   高级复盘
   ==========================================================================
   只把记录按场景与时段摆出来，外加本人的后续自评。
   **不排名、不评分、不判定谁的选择更理性**。 */

let advRangeDays = 7;

function openAdvanced() {
  renderAdvanced();
  $('advOverlay').style.display = 'flex';
}

function renderAdvanced() {
  setText('advTitleText', 'adv.title');
  setText('advHint', 'adv.hint');
  setText('advRangeLabel', 'adv.range');
  setText('advSceneTitle', 'adv.byScene');
  setText('advHourTitle', 'adv.byHour');
  setText('advRepeatTitle', 'adv.repeats');
  setText('advRepeatHint', 'adv.repeats.hint');

  document.querySelectorAll('#advOverlay [data-range]').forEach(b => {
    const days = Number(b.dataset.range);
    b.textContent = days === 0 ? t('adv.range.all') : t('adv.range.' + days);
    b.style.borderColor = days === advRangeDays ? 'var(--accent-border)' : '';
    b.onclick = () => { advRangeDays = days; renderAdvanced(); };
  });

  const legend = $('advLegend');
  legend.innerHTML = '';
  for (const [kind, key] of [['stop', 'decision.stop'], ['switch', 'decision.switch'], ['continue', 'decision.continue']]) {
    const span = document.createElement('span');
    span.innerHTML = '<i></i><em style="font-style:normal"></em>';
    span.querySelector('i').style.background = kind === 'stop' ? 'var(--accent)' : (kind === 'switch' ? 'var(--warn)' : 'var(--ink-faint)');
    span.querySelector('em').textContent = t(key);
    legend.appendChild(span);
  }

  const from = advRangeDays > 0 ? Date.now() - advRangeDays * DAY_MS : undefined;
  const data = advancedReview(state, { from, tzOffsetMinutes: tzOffsetMinutes() });

  // 按场景
  const scenesHost = $('advScenes');
  scenesHost.innerHTML = '';
  if (!data.scenes.length) {
    const d = document.createElement('div');
    d.className = 'tpl-item-meta';
    d.textContent = t('adv.empty');
    scenesHost.appendChild(d);
  }
  for (const row of data.scenes) {
    const box = document.createElement('div');
    box.className = 'adv-scene-row';
    box.innerHTML = '<div class="adv-scene-top"><span class="adv-scene-name"></span><span class="adv-scene-count"></span></div>'
      + '<div class="adv-kinds"></div><span class="adv-scene-meta"></span><span class="adv-scene-meta"></span>';
    box.querySelector('.adv-scene-name').textContent = t('scene.' + row.key);
    box.querySelector('.adv-scene-count').textContent = nDecisions(row.decisions);
    const bars = box.querySelector('.adv-kinds');
    for (const kind of ['stop', 'switch', 'continue']) {
      const i = document.createElement('i');
      i.className = 'k-' + kind;
      i.style.flex = String(row.counts[kind]);
      i.title = t(KIND_KEY[kind]) + ' ' + row.counts[kind];
      bars.appendChild(i);
    }
    const metas = box.querySelectorAll('.adv-scene-meta');
    const bits = [];
    if (row.elapsedMs > 0) bits.push(t('adv.measured', { d: dur(row.elapsedMs) }));
    if (row.userEstimatedPriorMs > 0) bits.push(t('adv.estimated', { d: dur(row.userEstimatedPriorMs) }));
    if (row.immediate > 0) bits.push(t('adv.immediate', { n: row.immediate }));
    metas[0].textContent = bits.join(' · ');
    metas[1].textContent = t('adv.followUp') + sep() + t('adv.followUp.summary', {
      agree: row.followUp.agree, disagree: row.followUp.disagree, none: row.followUp.none + row.followUp.unanswered
    });
    scenesHost.appendChild(box);
  }

  // 按时段：24 根柱子，零值也留着——看得出空档才有意义
  const hoursHost = $('advHours');
  const axisHost = $('advHourAxis');
  hoursHost.innerHTML = '';
  axisHost.innerHTML = '';
  const peak = Math.max(1, ...data.hours.map(h => h.decisions));
  for (const h of data.hours) {
    const col = document.createElement('div');
    col.className = 'adv-hour';
    const bar = document.createElement('i');
    bar.style.height = Math.round((h.decisions / peak) * 100) + '%';
    if (!h.decisions) bar.className = 'zero';
    col.title = t('adv.hourLabel', { h: h.key }) + ' · ' + nDecisions(h.decisions);
    col.appendChild(bar);
    hoursHost.appendChild(col);
    const ax = document.createElement('span');
    ax.textContent = h.key % 6 === 0 ? String(h.key) : '';
    if (h.key % 6 !== 0) ax.className = 'hide';
    axisHost.appendChild(ax);
  }

  // 反复继续的事项：只是数数，不是评语
  const repeatsHost = $('advRepeats');
  repeatsHost.innerHTML = '';
  if (!data.repeats.length) {
    const d = document.createElement('div');
    d.className = 'tpl-item-meta';
    d.textContent = t('adv.empty');
    repeatsHost.appendChild(d);
  }
  for (const row of data.repeats) {
    const box = document.createElement('div');
    box.className = 'adv-scene-row';
    box.innerHTML = '<div class="adv-scene-top"><span class="adv-scene-name"></span><span class="adv-scene-count"></span></div><span class="adv-scene-meta"></span>';
    box.querySelector('.adv-scene-name').textContent = row.name || t('entry.immediate.placeholderName');
    box.querySelector('.adv-scene-count').textContent = t('adv.repeats.count', { n: row.continueCount });
    const bits = [];
    if (row.scene) bits.push(sceneLabel(row.scene));
    if (row.elapsedMs > 0) bits.push(t('adv.measured', { d: dur(row.elapsedMs) }));
    bits.push(fmtDateTime(row.lastAt));
    box.querySelector('.adv-scene-meta').textContent = bits.join(' · ');
    repeatsHost.appendChild(box);
  }
}

/* ==========================================================================
   事件绑定
   ========================================================================== */

function bind() {
  // 顶部视图导航切换（此时 vs 灵感池 vs 记录）
  if ($('tabViewNow')) $('tabViewNow').onclick = () => switchView('now');
  if ($('tabViewPool')) $('tabViewPool').onclick = () => switchView('pool');
  if ($('tabViewReview')) $('tabViewReview').onclick = () => switchView('review');

  // 灵感池专属交互
  if ($('btnRandomWakePool')) $('btnRandomWakePool').onclick = doRandomWake;
  if ($('btnPoolQuickSave')) $('btnPoolQuickSave').onclick = doSavePoolQuick;
  const poolQuick = $('poolQuickInput');
  if (poolQuick) {
    poolQuick.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSavePoolQuick();
      }
    });
  }
  const poolSearch = $('poolSearchInput');
  if (poolSearch) {
    poolSearch.addEventListener('input', () => {
      renderOnDeck(poolSearch.value);
    });
  }
  if ($('btnWakeLaunch')) {
    $('btnWakeLaunch').onclick = () => {
      $('wakeOverlay').style.display = 'none';
      if (currentWakingTaskId) {
        doLaunchOnDeck(currentWakingTaskId);
        currentWakingTaskId = null;
      }
    };
  }
  if ($('btnWakeClose')) {
    $('btnWakeClose').onclick = () => {
      $('wakeOverlay').style.display = 'none';
      currentWakingTaskId = null;
    };
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.pool-item-menu-wrap')) {
      document.querySelectorAll('.pool-dropdown-menu').forEach(m => m.style.display = 'none');
    }
  });

  // 设点方式切换（多久之后 vs 指定时刻）
  if ($('tabTimingDur')) $('tabTimingDur').onclick = () => setTimingMode('dur');
  if ($('tabTimingWhen')) $('tabTimingWhen').onclick = () => setTimingMode('when');

  // 启动参数与时限折叠抽屉
  if ($('btnToggleTiming')) $('btnToggleTiming').onclick = () => toggleTimingDrawer();
  if ($('btnToggleHypo')) $('btnToggleHypo').onclick = () => setHypoExpanded(!hypoExpanded);
  if ($('btnCloseHypo')) $('btnCloseHypo').onclick = () => setHypoExpanded(false);
  $('hypothesis').addEventListener('input', e => {
    if (e.target.value.trim().length > 0) setHypoExpanded(true);
  });

  // 模板选择器：若页面存在则绑定，否则安全跳过
  if ($('tplPickerBtn')) {
    $('tplPickerBtn').onclick = () => {
      const menu = $('tplPickerMenu');
      if (menu && menu.hidden) openTemplateMenu(); else closeTemplateMenu();
    };
  }
  if ($('tplClearBtn')) {
    $('tplClearBtn').onclick = clearAppliedTemplate;
  }

  // 复盘的出口菜单
  if ($('reviewMenuBtn')) {
    $('reviewMenuBtn').onclick = () => {
      if ($('reviewMenu') && $('reviewMenu').hidden) openReviewMenu(); else closeReviewMenu();
    };
  }

  // 点到别处就收起浮层
  document.addEventListener('click', e => {
    const tplMenu = $('tplPickerMenu');
    if (tplMenu && !tplMenu.hidden && !e.target.closest('.tpl-picker')) closeTemplateMenu();
    const rvMenu = $('reviewMenu');
    if (rvMenu && !rvMenu.hidden && !e.target.closest('.rv-menu-wrap')) closeReviewMenu();
  });

  $('plannedForm').onsubmit = submitPlanned;
  if ($('btnSaveOnDeck')) $('btnSaveOnDeck').onclick = doSaveOnDeck;
  if ($('btnRandomWake')) $('btnRandomWake').onclick = doRandomWake;
  if ($('energyStatusBadge')) $('energyStatusBadge').onclick = openEnergyModal;
  if ($('energyCloseBtn')) $('energyCloseBtn').onclick = closeEnergyModal;
  if ($('energyOverlay')) $('energyOverlay').onclick = e => { if (e.target === $('energyOverlay')) closeEnergyModal(); };

  const nameInput = $('name');
  if (nameInput) {
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        doSaveOnDeck();
      }
    });
  }
  document.querySelectorAll('.dur-chips-wrap .chip').forEach(c => {
    c.onclick = () => {
      $('dur').value = c.dataset.min;
      document.querySelectorAll('.dur-chips-wrap .chip').forEach(x => x.classList.toggle('on', x === c));
      linkFromDur();
    };
  });
  $('dur').addEventListener('input', () => {
    document.querySelectorAll('.dur-chips-wrap .chip').forEach(x => x.classList.remove('on'));
    linkFromDur();
  });
  $('when').addEventListener('input', linkFromWhen);
  $('when').addEventListener('change', linkFromWhen);

  // 重评面板
  document.querySelectorAll('.ra-act').forEach(b => { b.onclick = () => setRaKind(b.dataset.kind); });
  document.querySelectorAll('#raContinuePanel .chip').forEach(c => {
    c.onclick = () => {
      document.querySelectorAll('#raContinuePanel .chip').forEach(x => x.classList.toggle('on', x === c));
      raContinueMs = Number(c.dataset.add) * 60000;
      $('raContinueCustom').value = '';
      updateConfirmBtnText();
    };
  });
  $('raContinueCustom').addEventListener('input', () => {
    document.querySelectorAll('#raContinuePanel .chip').forEach(x => x.classList.remove('on'));
    updateConfirmBtnText();
  });
  $('raLater').onchange = () => { if ($('raLater').checked) $('raCompleted').checked = false; };
  $('raCompleted').onchange = () => { if ($('raCompleted').checked) $('raLater').checked = false; };
  $('raConfirmBtn').onclick = confirmReassess;
  $('raLaterBtn').onclick = closeReassess;
  $('raCloseBtn').onclick = closeReassess;
  $('raOverlay').onclick = e => { if (e.target === $('raOverlay')) closeReassess(); };

  // 全屏
  $('fsCloseBtn').onclick = closeFullscreen;
  $('fsModeSingleBtn').onclick = () => { fsMode = 'single'; renderFullscreen(); };
  $('fsModeGridBtn').onclick = () => { fsMode = 'grid'; renderFullscreen(); };
  $('fsDoneBtn').onclick = () => {
    const rounds = openRounds();
    const r = rounds[Math.min(fsIndex, rounds.length - 1)];
    if (!r) return;
    const now = Date.now();
    const isExpired = now >= r.session.deadlineAt;
    closeFullscreen();
    openReassess({ sessionId: r.session.sessionId, early: !isExpired });
  };
  if ($('fsSwitchBtn')) {
    $('fsSwitchBtn').onclick = () => {
      const rounds = openRounds();
      const r = rounds[Math.min(fsIndex, rounds.length - 1)];
      if (!r) return;
      reminders.cancel(r.session.sessionId);
      unlockAudio();
      const out = guard(() => decide(state, { sessionId: r.session.sessionId, kind: 'switch' }));
      if (!out) return;
      commit(out.state, { flush: true });
      closeFullscreen();
      const nameInput = $('name');
      const hypoInput = $('hypothesis');
      if (nameInput) nameInput.value = r.task.name || '';
      if (hypoInput) hypoInput.value = '';
      $('dur').value = '30';
      document.querySelectorAll('.dur-chips-wrap .chip').forEach(c => c.classList.toggle('on', c.dataset.min === '30'));
      linkFromDur();
      const creator = $('creatorCard');
      if (creator) {
        creator.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => { if (hypoInput) hypoInput.focus(); }, 150);
      }
      showToast(t('toast.switchedMethod', { name: r.task.name || t('entry.immediate.placeholderName') }));
    };
  }
  if ($('fsContinueBtn')) {
    $('fsContinueBtn').onclick = () => {
      const rounds = openRounds();
      const r = rounds[Math.min(fsIndex, rounds.length - 1)];
      if (!r) return;
      reminders.cancel(r.session.sessionId);
      unlockAudio();
      const out = guard(() => decide(state, { sessionId: r.session.sessionId, kind: 'continue', continueMs: 15 * 60000 }));
      if (!out) return;
      commit(out.state, { flush: true });
      renderFullscreen();
      showToast(t('toast.extended15'));
    };
  }
  $('fsAbandonBtn').onclick = () => {
    const rounds = openRounds();
    const r = rounds[Math.min(fsIndex, rounds.length - 1)];
    if (!r) return;
    showConfirmDialog({
      title: '确认取消这一轮？',
      desc: t('now.cancelRound.confirm'),
      confirmText: '确认取消',
      danger: true,
      onConfirm: () => {
        reminders.cancel(r.session.sessionId);
        const out = guard(() => cancelSession(state, { sessionId: r.session.sessionId }));
        if (out) {
          commit(out.state);
          const remain = openRounds();
          if (remain.length > 0) {
            fsIndex = Math.max(0, Math.min(remain.length - 1, fsIndex));
            renderFullscreen();
          } else {
            closeFullscreen();
          }
          showToast(t('toast.cancelled'));
        }
      }
    });
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && fsActive) {
      closeFullscreen();
    }
  });
  const fsPip = $('fsPipBtn');
  if ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) {
    fsPip.style.display = 'inline-flex';
    fsPip.onclick = () => {
      const rounds = openRounds();
      const r = rounds[Math.min(fsIndex, rounds.length - 1)];
      if (r) togglePip(r.session.sessionId);
    };
  }

  // 复盘简报
  $('btnBriefingCopy').onclick = copyBriefing;
  $('btnBriefingExportImg').onclick = exportBriefingImage;
  $('btnBriefingClose').onclick = () => { $('briefingOverlay').style.display = 'none'; };
  $('briefingOverlay').onclick = e => { if (e.target === $('briefingOverlay')) $('briefingOverlay').style.display = 'none'; };

  // 设置
  $('settingsBtn').onclick = () => openSettings();
  $('setCloseBtn').onclick = () => { $('settingsOverlay').style.display = 'none'; };
  $('settingsOverlay').onclick = e => { if (e.target === $('settingsOverlay')) $('settingsOverlay').style.display = 'none'; };
  ['setMaxAlerts', 'setInterval', 'setMuted', 'setAnalytics'].forEach(id => { $(id).onchange = applySettings; });
  $('setExportBtn').onclick = () => downloadExport(state, 'export');
  $('setClearBtn').onclick = () => {
    if (!confirm(t('review.clear.confirm'))) return;
    reminders.cancelAll();
    state = createState({});
    store.saveLocalState(LS, state, getUser());
    store.removeKey(LS, store.V1_KEY);
    store.removeKey(LS, store.V1_HKEY);
    dirty = true;
    schedulePush(true);
    render();
    $('settingsOverlay').style.display = 'none';
  };
  $('setRecoveryBtn').onclick = showRecoveryCode;

  // 账户
  $('tabL').onclick = () => {
    regMode = false;
    $('tabL').classList.add('on'); $('tabR').classList.remove('on');
    $('aGo').textContent = t('auth.submit.login'); $('aErr').textContent = '';
    const recToggle = $('recoveryToggle');
    if (recToggle) recToggle.style.display = '';
  };
  $('tabR').onclick = () => {
    regMode = true;
    $('tabR').classList.add('on'); $('tabL').classList.remove('on');
    $('aGo').textContent = t('auth.submit.register'); $('aErr').textContent = '';
    const recToggle = $('recoveryToggle');
    if (recToggle) recToggle.style.display = 'none';
    const recForm = $('recoveryForm');
    if (recForm) recForm.style.display = 'none';
  };
  $('authForm').onsubmit = e => { e.preventDefault(); doAuth(); };
  // 同步状态就是账户入口：未登录去登录，已登录进设置。
  $('syncStatusBadge').onclick = () => {
    if (!getToken()) openAuthModal();
    else openSettings('setAccountGroup');
  };
  if ($('btnOpenAuthModal')) $('btnOpenAuthModal').onclick = openAuthModal;
  if ($('authModalClose')) $('authModalClose').onclick = closeAuthModal;
  if ($('authModalOverlay')) $('authModalOverlay').onclick = e => {
    if (e.target === $('authModalOverlay')) closeAuthModal();
  };
  bindLangDropdown('landLangWrap', 'landLangMenuBtn', 'landLangMenu');
  bindLangDropdown('appLangWrap', 'appLangMenuBtn', 'appLangMenu');
  if ($('langBtn')) $('langBtn').onclick = toggleLocale;
  if ($('landLangBtn')) $('landLangBtn').onclick = toggleLocale;
  if ($('footerLangLink')) $('footerLangLink').onclick = toggleLocale;

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.lang-dropdown-wrap')) {
      closeAllLangMenus();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllLangMenus();
    }
  });

  // 顿悟时刻浮层事件
  if ($('btnMilestoneDismiss')) $('btnMilestoneDismiss').onclick = closeMilestoneToast;

  if ($('btnHeroGuest')) $('btnHeroGuest').onclick = () => { LS.setItem(store.ENTERED_KEY, '1'); try { history.pushState(null, '', '/?app=1'); } catch(e){} showApp(); };
  if ($('btnHeroGuestBottom')) $('btnHeroGuestBottom').onclick = () => { LS.setItem(store.ENTERED_KEY, '1'); try { history.pushState(null, '', '/?app=1'); } catch(e){} showApp(); };
  if ($('btnEnterAppFromMockup')) $('btnEnterAppFromMockup').onclick = () => { LS.setItem(store.ENTERED_KEY, '1'); try { history.pushState(null, '', '/?app=1'); } catch(e){} showApp(); };

  $('landGuest').onclick = () => { LS.setItem(store.ENTERED_KEY, '1'); try { history.pushState(null, '', '/?app=1'); } catch(e){} showApp(); };
  if ($('appBrandLink')) {
    $('appBrandLink').onclick = (e) => {
      e.preventDefault();
      try { history.pushState(null, '', '/?land=1'); } catch(err){}
      showLand(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }
  if ($('landBrandLogo')) {
    $('landBrandLogo').onclick = (e) => {
      e.preventDefault();
      try { history.pushState(null, '', '/'); } catch(err){}
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }
  $('landCta').onclick = () => { openAuthModal(); };
  $('landBack').onclick = () => { LS.setItem(store.ENTERED_KEY, '1'); showApp(); };
  $('recoveryToggle').onclick = () => {
    const f = $('recoveryForm');
    const open = f.style.display === 'none';
    f.style.display = open ? 'contents' : 'none';
    if (open) $('rcUser').focus();
  };
  $('recoveryForm').onsubmit = e => { e.preventDefault(); doRecover(); };
  $('rcCopyBtn').onclick = () => {
    navigator.clipboard.writeText($('rcValue').textContent)
      .then(() => showToast(t('toast.copied')))
      .catch(() => showToast(t('toast.copyFailed')));
  };
  $('rcDoneBtn').onclick = () => { $('recoveryOverlay').style.display = 'none'; };

  document.querySelectorAll('#guestOverlay .choice-card').forEach(b => {
    b.onclick = () => applyGuestChoice(b.dataset.choice);
  });

  // 语言：应用内只有「设置 · 语言」这一个开关；落地页那个文字链在 renderLangLink() 里绑。
  $('setLanguage').onchange = () => setLocale($('setLanguage').value);


  // Pro 能力一：导入个人音频
  $('setSoundFile').setAttribute('accept', sounds.ACCEPT);
  $('setSoundFile').onchange = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';                 // 选同一个文件两次也要能触发
    if (file) importSound(file);
  };
  ['setPreAlert', 'setSound'].forEach(id => { $(id).onchange = applySettings; });

  // Pro 能力二：个人重评规则
  $('setTemplatesBtn').onclick = openTemplateOverlay;
  $('tplCloseBtn').onclick = () => { $('templateOverlay').style.display = 'none'; };
  $('templateOverlay').onclick = e => { if (e.target === $('templateOverlay')) $('templateOverlay').style.display = 'none'; };
  $('tplSaveBtn').onclick = submitTemplate;
  $('tplResetBtn').onclick = resetTemplateEditor;

  // 高级复盘
  $('setAdvBtn').onclick = openAdvanced;
  $('advCloseBtn').onclick = () => { $('advOverlay').style.display = 'none'; };
  $('advOverlay').onclick = e => { if (e.target === $('advOverlay')) $('advOverlay').style.display = 'none'; };

  // 主题
  const themeOrder = ['auto', 'light', 'dark'];
  const applyTheme = th => {
    document.documentElement.dataset.theme = th;
    try { LS.setItem('sl.theme', th); } catch (e) { /* 隐私模式下存不了主题，不影响使用 */ }
    const isDark = th === 'dark' || (th === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const updateBtn = b => {
      if (!b) return;
      const sun = b.querySelector('.theme-sun-svg');
      const moon = b.querySelector('.theme-moon-svg');
      if (sun && moon) {
        sun.style.display = isDark ? 'none' : 'block';
        moon.style.display = isDark ? 'block' : 'none';
      }
    };
    [$('themeBtn'), $('themeBtnFs')].forEach(updateBtn);
    const landBtn = $('themeBtnLand');
    if (landBtn) {
      landBtn.setAttribute('title', isDark ? '切换浅色主题' : '切换暗色主题');
      landBtn.setAttribute('aria-label', landBtn.getAttribute('title'));
    }
  };
  const cycle = () => applyTheme(themeOrder[(themeOrder.indexOf(document.documentElement.dataset.theme || 'auto') + 1) % 3]);
  const cycleLand = () => {
    const isLight = document.documentElement.dataset.theme === 'light';
    applyTheme(isLight ? 'dark' : 'light');
  };
  if ($('themeBtn')) $('themeBtn').onclick = cycle;
  if ($('themeBtnLand')) $('themeBtnLand').onclick = cycleLand;
  if ($('themeBtnFs')) $('themeBtnFs').onclick = cycle;
  applyTheme(LS.getItem('sl.theme') || document.documentElement.dataset.theme || 'auto');

  // 落地页锚点平滑滚动与哈希防护
  document.querySelectorAll('#land a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const hash = a.getAttribute('href');
      if (hash && hash.length > 1) {
        const el = document.querySelector(hash);
        if (el) {
          e.preventDefault();
          history.pushState(null, '', hash);
          scrollWithNavOffset(el);
        }
      }
    });
  });
  window.addEventListener('hashchange', () => {
    const hash = (location.hash || '').toLowerCase();
    if (hash === '#features' || hash === '#philosophy') {
      showLand(true);
      const el = document.querySelector(hash);
      if (el) scrollWithNavOffset(el);
    }
  });

  // 落地页导航高亮联动 (Scrollspy)
  const featSec = $('features');
  const philSec = $('philosophy');
  const navFeat = $('navFeatLink');
  const navPhil = $('navPhilLink');
  if (featSec && philSec && navFeat && navPhil) {
    const onScroll = () => {
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;
      const featTop = featSec.offsetTop - 140;
      const featBottom = featTop + featSec.offsetHeight;
      const philTop = philSec.offsetTop - 140;
      const philBottom = philTop + philSec.offsetHeight;

      if (scrollY >= featTop && scrollY < featBottom) {
        navFeat.classList.add('active');
        navPhil.classList.remove('active');
      } else if (scrollY >= philTop && scrollY < philBottom) {
        navPhil.classList.add('active');
        navFeat.classList.remove('active');
      } else {
        navFeat.classList.remove('active');
        navPhil.classList.remove('active');
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // 键盘
  document.addEventListener('keydown', e => {
    if ($('raOverlay').style.display === 'flex') {
      if (e.key === 'Escape') { e.preventDefault(); closeReassess(); }
      else if (e.key === 'Enter' && raKind) { e.preventDefault(); confirmReassess(); }
      return;
    }
    for (const id of ['templateOverlay', 'advOverlay', 'settingsOverlay', 'briefingOverlay', 'recoveryOverlay', 'energyOverlay']) {
      if ($(id) && $(id).style.display === 'flex' && e.key === 'Escape') { e.preventDefault(); $(id).style.display = 'none'; return; }
    }
    if (fsActive) {
      if (e.key === 'Escape') { e.preventDefault(); closeFullscreen(); return; }
      const rounds = openRounds();
      if (e.key === 'ArrowLeft') { fsIndex = (fsIndex - 1 + rounds.length) % rounds.length; renderFullscreen(); }
      else if (e.key === 'ArrowRight') { fsIndex = (fsIndex + 1) % rounds.length; renderFullscreen(); }
      else if (e.key.toLowerCase() === 'g' && rounds.length > 1) { fsMode = fsMode === 'grid' ? 'single' : 'grid'; renderFullscreen(); }
    }
  });

  // 首次交互解锁音频后重排铃（此前 ac 为空，beepAt 排不上）。
  // 自定义音频也必须在这里再解码一次：primeSounds() 在启动时就跑过，但那时 AudioContext
  // 还没解锁（ac 为空），decodeClip 只能返回 null——不补这一下，导入的铃声会**静默**退回基础铃。
  const unlockOnce = () => {
    unlockAudio();
    primeSounds();                       // 里面自己会重排
    rescheduleReminders();
    document.removeEventListener('pointerdown', unlockOnce);
    document.removeEventListener('keydown', unlockOnce);
  };
  document.addEventListener('pointerdown', unlockOnce);
  document.addEventListener('keydown', unlockOnce);

  // 合并提交：页面隐藏、离开、切后台时立即 flush，别把改动留在防抖窗口里
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { flushPush(); events.flush(); }
    else pullData();
  });
  window.addEventListener('pagehide', () => { flushPush(); events.flush(); });
}

/* ==========================================================================
   启动
   ========================================================================== */

function boot() {
  const loaded = store.loadLocalState(LS, { user: getUser() });
  state = loaded.state;
  if (loaded.migrated) setTimeout(() => showToast(t('toast.migrated')), 600);

  bind();
  renderAll();
  decideInitialView();
  linkFromDur();
  reminders.syncWith(openRounds().map(r => r.session), effectiveSettings());
  renderBanners();

  if (getToken()) pullData();
  setInterval(() => pullData(), 60000);

  setInterval(tick, 1000);
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),250)'])));
    w.onmessage = () => tick();
    w.onerror = () => w.terminate();
  } catch (e) { /* Blob Worker 不可用时退回上面的 setInterval */ }

  // 落地页的示例倒计时
  let demoSec = 1500;
  setInterval(() => {
    if ($('land').style.display === 'none') return;
    demoSec = demoSec > 0 ? demoSec - 1 : 1500;
    const el = $('demoLeft');
    if (el) el.textContent = fmtClock(demoSec);
    const bar = $('demoBar');
    if (bar) bar.style.width = ((1 - demoSec / 1500) * 100).toFixed(1) + '%';
  }, 1000);
}

// 模块脚本天然 defer，DOM 已就绪；保险起见仍判断一次。
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// 供浏览器走查使用（e2e 里要能读到当前 state 与直接改 deadline）。
window.__sl = {
  get state() { return state; },
  get settings() { return settings; },
  get cloudRev() { return cloudRev; },
  set cloudRev(v) { cloudRev = v; },
  // 走查时要能确认自定义音频**真的解码进了音频时钟**，而不是悄悄退回了基础铃
  get decodedSounds() { return [...soundCache.keys()]; },
  get soundsList() { return soundsList; },
  commit, render, openReassess, flushPush, events, reminders,
  openRounds, store, sync, t
};

export { };
