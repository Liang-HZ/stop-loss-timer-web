// 构建产物，勿手改。源码在 packages/core/，用 `npm run build:core` 重新生成。
// packages/core/capacity.js
// 容量边界：达到 90% 提示导出，达到上限拒绝写入并给出导出入口，不静默截断。
// 容量边界：超限抛 CapacityError，绝不静默截断。

// templates 是用户手写的重评规则，几十条就已经很多；给 100 的余量，满了同样是「提示 + 拒绝写入」，
// 不静默丢。它和 tasks/sessions/decisions 走同一套容量机制，没有第二套判断。
export const LIMITS = Object.freeze({ tasks: 500, sessions: 3000, decisions: 3000, templates: 100 });
export const WARN_RATIO = 0.9;

export class CapacityError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CapacityError';
    this.code = 'capacity_full';
    this.detail = detail || {};
    // 满了要给出口：调用方据此展示导出入口，而不是丢数据。
    this.exportSuggested = true;
  }
}

export function countState(state) {
  return {
    tasks: state && Array.isArray(state.tasks) ? state.tasks.length : 0,
    sessions: state && Array.isArray(state.sessions) ? state.sessions.length : 0,
    decisions: state && Array.isArray(state.decisions) ? state.decisions.length : 0,
    templates: state && Array.isArray(state.templates) ? state.templates.length : 0
  };
}

// 返回 {level:'ok'|'warn'|'full', counts, limits, usage, warn:[], full:[]}
export function checkCapacity(state, limits = LIMITS) {
  const counts = countState(state);
  const usage = {};
  const warn = [];
  const full = [];
  for (const key of Object.keys(limits)) {
    const ratio = limits[key] > 0 ? counts[key] / limits[key] : 0;
    usage[key] = ratio;
    if (counts[key] >= limits[key]) full.push(key);
    else if (ratio >= WARN_RATIO) warn.push(key);
  }
  const level = full.length ? 'full' : (warn.length ? 'warn' : 'ok');
  return { level, ok: level === 'ok', counts, limits, usage, warn, full };
}

// 写入前调用：容量不足直接抛 CapacityError（code:'capacity_full'），绝不截断。
export function assertCanAdd(state, add, limits = LIMITS) {
  const counts = countState(state);
  const need = add || {};
  const blocked = [];
  for (const key of Object.keys(limits)) {
    const delta = Number(need[key]) || 0;
    if (delta <= 0) continue;
    if (counts[key] + delta > limits[key]) {
      blocked.push({ kind: key, count: counts[key], limit: limits[key], requested: delta });
    }
  }
  if (blocked.length) {
    const names = blocked.map(b => `${b.kind} ${b.count}/${b.limit}`).join(', ');
    throw new CapacityError(`容量已满，无法写入（${names}）。请先导出并清理。`, { blocked, counts, limits });
  }
  return checkCapacity(state, limits);
}
