// 构建产物，勿手改。源码在 packages/core/，用 `npm run build:core` 重新生成。
// packages/core/review.js
// 基础复盘：按天／按事项列出决定，累计投入弱化显示，今日复盘 Markdown 导出。
// 不估算不存在的反事实收益，不把停止率／连续打卡／累计时长当成绩。

import { sessionElapsedMs, findTask, findSession, SCENES } from './model.js';
import { t, resolveLocale } from './copy.js';

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/* ---------------- 自然日边界 ---------------- */
// 自然日采用用户所在时区；默认用运行环境本地时区，可注入 dayBoundsOf 做确定性测试。
export function localDayBounds(at, tzOffsetMinutes) {
  if (Number.isFinite(tzOffsetMinutes)) {
    const shifted = at + tzOffsetMinutes * 60000;
    const startShifted = Math.floor(shifted / 86400000) * 86400000;
    return { start: startShifted - tzOffsetMinutes * 60000, end: startShifted + 86400000 - tzOffsetMinutes * 60000 };
  }
  const d = new Date(at);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  return { start, end: start + 86400000 };
}

export function dayKeyOf(at, tzOffsetMinutes) {
  const { start } = localDayBounds(at, tzOffsetMinutes);
  const d = Number.isFinite(tzOffsetMinutes) ? new Date(start + tzOffsetMinutes * 60000) : new Date(start);
  const y = Number.isFinite(tzOffsetMinutes) ? d.getUTCFullYear() : d.getFullYear();
  const m = (Number.isFinite(tzOffsetMinutes) ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = Number.isFinite(tzOffsetMinutes) ? d.getUTCDate() : d.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* ---------------- 单条决定的复盘视图 ---------------- */

export function decisionView(state, decision) {
  const task = findTask(state, decision.taskId);
  const session = decision.sessionId ? findSession(state, decision.sessionId) : null;
  const elapsedMs = sessionElapsedMs(session);
  return {
    decisionId: decision.decisionId,
    taskId: decision.taskId,
    taskName: task ? task.name : '',
    sessionId: decision.sessionId || null,
    entryMode: decision.entryMode,
    at: decision.at,
    kind: decision.kind,
    later: decision.later === true,
    completed: decision.completed === true,
    continueMs: decision.continueMs,
    note: decision.note || '',
    expectation: decision.expectation || '',
    followUp: decision.followUp || null,
    feeling: decision.followUp && decision.followUp.feeling ? decision.followUp.feeling : '',
    // 实测经过时间：没有真实 startedAt 就是 null，绝不用 plannedMs 顶替。
    elapsedMs,
    // 计划时长与实测分开；legacyPlanned 标记让旧口径一眼可辨。
    plannedMs: session && Number.isFinite(session.plannedMs) ? session.plannedMs : null,
    legacyPlanned: !!(session && session.legacyPlanned === true),
    endReason: session ? session.endReason || null : null,
    // 用户估计的此前投入：有 Session 时挂在 Session 上，即时决定（没有 Session）挂在决定自己身上。
    // 两者都是用户自述，与实测 elapsedMs 分开呈现，不相加。
    userEstimatedPriorMs: decision.userEstimatedPriorMs
      ? decision.userEstimatedPriorMs.value
      : (session && session.userEstimatedPriorMs ? session.userEstimatedPriorMs.value : null),
    scene: task && task.scene ? task.scene : null,
    templateId: task && task.templateId ? task.templateId : null
  };
}

export function listDecisions(state, opts) {
  const o = opts || {};
  let rows = state.decisions.slice();
  if (Number.isFinite(o.from)) rows = rows.filter(d => d.at >= o.from);
  if (Number.isFinite(o.to)) rows = rows.filter(d => d.at < o.to);
  if (o.taskId) rows = rows.filter(d => d.taskId === o.taskId);
  rows.sort((a, b) => a.at - b.at);
  return rows.map(d => decisionView(state, d));
}

/* ---------------- 按天 / 按事项 ---------------- */

export function groupByDay(state, opts) {
  const o = opts || {};
  const map = new Map();
  for (const view of listDecisions(state, o)) {
    const key = dayKeyOf(view.at, o.tzOffsetMinutes);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(view);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, decisions]) => ({ day, decisions }));
}

export function groupByTask(state, opts) {
  const map = new Map();
  for (const view of listDecisions(state, opts)) {
    if (!map.has(view.taskId)) map.set(view.taskId, { taskId: view.taskId, taskName: view.taskName, decisions: [] });
    map.get(view.taskId).decisions.push(view);
  }
  return [...map.values()];
}

/**
 * 某事项的累计投入——刻意弱化：
 * elapsedMs（实测）与 plannedMs（计划）分开，旧口径单列 legacyPlannedMs，
 * 不加总成一个「总投入」数字，也不推算「省下了多少」。
 */
export function taskTotals(state, taskId) {
  const sessions = state.sessions.filter(s => s.taskId === taskId);
  let elapsedMs = 0;
  let measuredSessions = 0;
  let plannedMs = 0;
  let legacyPlannedMs = 0;
  let legacySessions = 0;
  let cancelled = 0;
  let userEstimatedPriorMs = 0;
  for (const s of sessions) {
    if (s.endReason === 'cancelled') { cancelled++; continue; }
    const e = sessionElapsedMs(s);
    if (e !== null) { elapsedMs += e; measuredSessions++; }
    if (Number.isFinite(s.plannedMs)) {
      if (s.legacyPlanned === true) { legacyPlannedMs += s.plannedMs; legacySessions++; }
      else plannedMs += s.plannedMs;
    }
    if (s.userEstimatedPriorMs) userEstimatedPriorMs += num(s.userEstimatedPriorMs.value);
  }
  return {
    taskId,
    sessions: sessions.length,
    cancelledSessions: cancelled,
    measuredSessions,
    elapsedMs,
    plannedMs,
    legacyPlannedMs,
    legacySessions,
    hasLegacy: legacySessions > 0,
    userEstimatedPriorMs,
    decisions: state.decisions.filter(d => d.taskId === taskId).length
  };
}

/* ---------------- 今日复盘 ---------------- */

export function todayReview(state, opts) {
  const o = opts || {};
  const at = Number.isFinite(o.at) ? o.at : Date.now();
  const { start, end } = localDayBounds(at, o.tzOffsetMinutes);
  const decisions = listDecisions(state, { from: start, to: end });
  const byTask = new Map();
  for (const d of decisions) {
    if (!byTask.has(d.taskId)) {
      const totals = taskTotals(state, d.taskId);
      const task = findTask(state, d.taskId);
      byTask.set(d.taskId, {
        taskId: d.taskId,
        name: d.taskName,
        status: task ? task.status : 'ended',
        hypothesis: task && task.hypothesis ? task.hypothesis : '',
        decisions: [],
        elapsedMs: 0,
        legacyPlannedMs: 0,
        totals
      });
    }
    const row = byTask.get(d.taskId);
    row.decisions.push(d);
    if (d.elapsedMs !== null) row.elapsedMs += d.elapsedMs;
    if (d.legacyPlanned && d.plannedMs) row.legacyPlannedMs += d.plannedMs;
  }
  const counts = { stop: 0, switch: 0, continue: 0, later: 0, completed: 0 };
  for (const d of decisions) {
    counts[d.kind]++;
    if (d.later) counts.later++;
    if (d.completed) counts.completed++;
  }
  return {
    day: dayKeyOf(at, o.tzOffsetMinutes),
    dayStart: start,
    dayEnd: end,
    decisionCount: decisions.length,
    counts,
    decisions,
    items: [...byTask.values()]
  };
}

const fmtDuration = (ms, locale) => {
  const min = Math.max(0, Math.round(num(ms) / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (locale === 'en') {
    if (h && m) return `${h}h ${m}min`;
    if (h) return `${h}h`;
    return `${m}min`;
  }
  if (h && m) return `${h} 小时 ${m} 分钟`;
  if (h) return `${h} 小时`;
  return `${m} 分钟`;
};

export function formatDuration(ms, locale) { return fmtDuration(ms, resolveLocale(locale) === 'en' ? 'en' : 'zh'); }

const KIND_LABEL_KEY = { stop: 'decision.stop', switch: 'decision.switch', continue: 'decision.continue' };

/**
 * 今日复盘 Markdown 导出：沿用旧导出的信息（日期、事项、决定、笔记、假设、用时），
 * 但把实测用时与旧版计划用时分开标注，且不估算「保住了多少时间」。
 */
export function todayReviewMarkdown(state, opts) {
  const o = opts || {};
  const locale = resolveLocale(o.locale);
  const data = o.review || todayReview(state, o);
  const L = key => t(key, locale);
  const lines = [];
  lines.push(`# ${L('review.title')} · ${data.day}`);
  lines.push('');
  lines.push(`> ${L('app.promise')}`);
  lines.push('');
  lines.push(`### ${L('review.decisions')}`);
  lines.push(locale === 'en'
    ? `- Decisions today: ${data.decisionCount} (stop ${data.counts.stop} / switch ${data.counts.switch} / continue ${data.counts.continue})`
    : `- 今日决定：${data.decisionCount} 次（就到这里 ${data.counts.stop} · 换个办法 ${data.counts.switch} · 再投入一会儿 ${data.counts.continue}）`);
  lines.push('');

  if (!data.items.length) {
    lines.push(`- *${L('review.empty')}*`);
  } else {
    data.items.forEach((item, idx) => {
      const name = item.name || t('entry.immediate.placeholderName', locale);
      lines.push(`${idx + 1}. **${name}** — ${L('status.' + item.status)}`);
      if (item.elapsedMs > 0) lines.push(`   - ${L('time.elapsed')}: ${formatDuration(item.elapsedMs, locale)}`);
      if (item.legacyPlannedMs > 0) lines.push(`   - ${L('time.legacyPlanned')}: ${formatDuration(item.legacyPlannedMs, locale)}（${L('time.legacyPlanned.hint')}）`);
      if (item.hypothesis) lines.push(`   - ${L('field.hypothesis')} ${item.hypothesis}`);
      item.decisions.forEach(d => {
        const label = L(KIND_LABEL_KEY[d.kind]);
        const extra = [];
        if (d.later) extra.push(L('decision.later'));
        if (d.completed) extra.push(L('decision.completed'));
        if (d.entryMode === 'immediate') extra.push(L('entry.immediate'));
        if (d.kind === 'continue' && d.continueMs) extra.push(`+${formatDuration(d.continueMs, locale)}`);
        lines.push(`   - ${new Date(d.at).toISOString()} · ${label}${extra.length ? `（${extra.join(' · ')}）` : ''}`);
        if (d.note) lines.push(`     - ${L('field.note')}: ${d.note}`);
        if (d.expectation) lines.push(`     - ${L('field.expectation')} ${d.expectation}`);
        if (d.followUp) {
          const agree = d.followUp.stillAgree === true ? L('review.followUp.agree')
            : d.followUp.stillAgree === false ? L('review.followUp.disagree') : '';
          const feeling = d.followUp.feeling ? ` ${d.followUp.feeling}` : '';
          lines.push(`     - ${L('review.followUp')}: ${agree}${feeling}`.trimEnd());
        }
      });
    });
  }

  lines.push('');
  lines.push('---');
  lines.push(`*${L('review.footer')}*`);
  return lines.join('\n');
}

/* ---------------- 高级复盘（Pro）：按场景与时段看分布 ---------------- */
// 只做分组计数与本人自评的汇总。**不排名、不评分、不判定哪种选择更理性**
// （原则：不判定哪个人的选择更理性，AI/产品不替用户评价选择）。
// 「反复纠结」的定义是可数的事实：同一事项上 continue 决定的次数，不是对用户的评语。

const emptyCounts = () => ({ stop: 0, switch: 0, continue: 0 });

function tallyInto(row, view) {
  row.decisions++;
  row.counts[view.kind]++;
  if (view.later) row.later++;
  if (view.completed) row.completed++;
  if (view.entryMode === 'immediate') row.immediate++;
  if (view.elapsedMs !== null) row.elapsedMs += view.elapsedMs;
  if (view.userEstimatedPriorMs !== null) row.userEstimatedPriorMs += num(view.userEstimatedPriorMs);
  if (view.followUp) {
    if (view.followUp.stillAgree === true) row.followUp.agree++;
    else if (view.followUp.stillAgree === false) row.followUp.disagree++;
    else row.followUp.unanswered++;
  } else {
    row.followUp.none++;
  }
}

const emptyRow = key => ({
  key,
  decisions: 0,
  counts: emptyCounts(),
  later: 0,
  completed: 0,
  immediate: 0,
  elapsedMs: 0,
  userEstimatedPriorMs: 0,
  followUp: { agree: 0, disagree: 0, unanswered: 0, none: 0 }
});

/**
 * @param {object} state
 * @param {object} [opts] { from, to, tzOffsetMinutes, hourBuckets }
 * @returns {{from, to, decisionCount, scenes, hours, repeats, sceneKeys}}
 *  scenes: 每个场景一行（没有记录的场景不出现，不造零行撑门面）
 *  hours:  固定 24 行（时段分布要看得出空档，所以零行保留）
 *  repeats: 同一事项上 continue 次数 ≥2 的事项，按次数降序——事实陈列，不加评语
 */
export function advancedReview(state, opts) {
  const o = opts || {};
  const views = listDecisions(state, { from: o.from, to: o.to });
  const tz = o.tzOffsetMinutes;

  const sceneMap = new Map();
  const hours = Array.from({ length: 24 }, (_, h) => emptyRow(h));
  const taskMap = new Map();

  for (const v of views) {
    const scene = v.scene || 'other';
    if (!sceneMap.has(scene)) sceneMap.set(scene, emptyRow(scene));
    tallyInto(sceneMap.get(scene), v);

    const d = Number.isFinite(tz) ? new Date(v.at + tz * 60000) : new Date(v.at);
    const hour = Number.isFinite(tz) ? d.getUTCHours() : d.getHours();
    tallyInto(hours[hour], v);

    if (!taskMap.has(v.taskId)) {
      taskMap.set(v.taskId, {
        taskId: v.taskId,
        name: v.taskName,
        scene: v.scene || null,
        continueCount: 0,
        decisions: 0,
        elapsedMs: 0,
        lastAt: v.at
      });
    }
    const row = taskMap.get(v.taskId);
    row.decisions++;
    if (v.kind === 'continue') row.continueCount++;
    if (v.elapsedMs !== null) row.elapsedMs += v.elapsedMs;
    if (v.at > row.lastAt) row.lastAt = v.at;
  }

  const scenes = [...sceneMap.values()].sort((a, b) => {
    if (b.decisions !== a.decisions) return b.decisions - a.decisions;
    return SCENES.indexOf(a.key) - SCENES.indexOf(b.key);
  });
  const repeats = [...taskMap.values()]
    .filter(r => r.continueCount >= 2)
    .sort((a, b) => (b.continueCount - a.continueCount) || (b.lastAt - a.lastAt));

  return {
    from: Number.isFinite(o.from) ? o.from : null,
    to: Number.isFinite(o.to) ? o.to : null,
    decisionCount: views.length,
    scenes,
    sceneKeys: SCENES.slice(),
    hours,
    repeats
  };
}
