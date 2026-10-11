// 构建产物，勿手改。源码在 packages/core/，用 `npm run build:core` 重新生成。
// packages/core/sync.js
// 本地／云端合并与冲突检测辅助。纯函数，不发请求。
// 同步契约：访客存储不得被云端静默覆盖。

import { SCHEMA_VERSION, createState } from './model.js';

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * 按 id 去重合并两个数组，同 id 保留 updatedAt 较新的一条。
 * updatedAt 缺失时退到 fallbackKeys（如 Decision.at、Session.endedAt），仍并列时保留 b（远端／后来者）。
 */
export function mergeById(a, b, opts) {
  const o = opts || {};
  const idKey = o.idKey || 'id';
  const fallbackKeys = o.fallbackKeys || ['updatedAt'];
  const stamp = x => {
    for (const k of fallbackKeys) if (Number.isFinite(x && x[k])) return x[k];
    return null;
  };
  const out = [];
  const index = new Map();
  const push = (x, preferIncoming) => {
    if (!x || typeof x !== 'object') return;
    const id = x[idKey];
    if (typeof id !== 'string' || !id) return;
    if (!index.has(id)) {
      index.set(id, out.length);
      out.push(x);
      return;
    }
    const pos = index.get(id);
    const cur = out[pos];
    const sc = stamp(cur);
    const sx = stamp(x);
    if (sx === null && sc === null) { if (preferIncoming) out[pos] = x; return; }
    if (sc === null) { out[pos] = x; return; }
    if (sx === null) return;
    if (sx > sc || (sx === sc && preferIncoming)) out[pos] = x;
  };
  (Array.isArray(a) ? a : []).forEach(x => push(x, false));
  (Array.isArray(b) ? b : []).forEach(x => push(x, true));
  return out;
}

const MERGE_SPEC = [
  ['tasks', 'taskId', ['updatedAt', 'createdAt']],
  ['sessions', 'sessionId', ['endedAt', 'startedAt', 'deadlineAt']],
  ['decisions', 'decisionId', ['at']],
  ['templates', 'templateId', ['updatedAt', 'createdAt']]
];

/** 合并两个 v2 state：id 去重，逐集合取较新者。不丢任何一边独有的记录。 */
export function mergeStates(local, server, ctx) {
  const l = local && local.schemaVersion === SCHEMA_VERSION ? local : createState({}, ctx);
  const s = server && server.schemaVersion === SCHEMA_VERSION ? server : createState({}, ctx);
  const merged = createState({
    updatedAt: Math.max(num(l.updatedAt), num(s.updatedAt)),
    rev: Math.max(num(l.rev), num(s.rev)),
    legacy: l.legacy || s.legacy,
    sourceVersion: l.sourceVersion || s.sourceVersion
  }, ctx);
  for (const [key, idKey, fallbackKeys] of MERGE_SPEC) {
    const rows = mergeById(l[key], s[key], { idKey, fallbackKeys });
    // templates 可选：两边都没有就别凭空造一个空数组出来（内容指纹会变，白花一次 KV 写）。
    if (key === 'templates' && !rows.length) continue;
    merged[key] = rows;
  }
  return merged;
}

/**
 * 冲突检测：客户端保存的 baseRev 与服务端当前 rev 不一致 → 冲突。
 * 返回 {conflict, reason, localRev, serverRev}。reason:
 *  'in_sync' 一致；'server_ahead' 服务端更新（别人／另一端写过）；
 *  'local_ahead' 本地 rev 更大（本地有未推送的改动，属正常待推送，不算冲突）；
 *  'unknown_base' 本地没有基线（第一次同步或迁移后），按冲突处理并让用户选择。
 */
export function detectConflict(localRev, serverRev) {
  const l = Number.isFinite(localRev) ? localRev : null;
  const s = Number.isFinite(serverRev) ? serverRev : null;
  if (l === null) return { conflict: s !== null && s > 0, reason: 'unknown_base', localRev: l, serverRev: s };
  if (s === null) return { conflict: false, reason: 'in_sync', localRev: l, serverRev: s };
  if (l === s) return { conflict: false, reason: 'in_sync', localRev: l, serverRev: s };
  if (s > l) return { conflict: true, reason: 'server_ahead', localRev: l, serverRev: s };
  return { conflict: false, reason: 'local_ahead', localRev: l, serverRev: s };
}

export const GUEST_LOGIN_CHOICES = ['merge', 'cloud', 'local'];

/**
 * 访客登录时的三选一。纯函数：只算结果，不写存储。
 * 'merge' 合并到账户；'cloud' 仅用云端（本机副本原样带回，调用方负责导出／留档，不静默丢弃）；
 * 'local' 仅用本机（云端不动，等待下次推送覆盖）。
 */
export function resolveGuestLogin(choice, input, ctx) {
  const o = input || {};
  const local = o.local || createState({}, ctx);
  const cloud = o.cloud || createState({}, ctx);
  if (!GUEST_LOGIN_CHOICES.includes(choice)) {
    const err = new Error(`未知的登录合并选择：${choice}`);
    err.code = 'invalid_choice';
    throw err;
  }
  if (choice === 'merge') {
    return { choice, state: mergeStates(local, cloud, ctx), discarded: null, keepLocalBackup: false };
  }
  if (choice === 'cloud') {
    // 云端拉取不得静默覆盖访客数据：把被放弃的本机副本一并交回，UI 必须提供导出。
    return { choice, state: cloud, discarded: local, keepLocalBackup: true };
  }
  return { choice, state: local, discarded: null, keepLocalBackup: false };
}

/** 退出账号：清除该账户的本机快照，不动云端，也不把它留给访客。 */
export function signOutLocalState(ctx) {
  return createState({}, ctx);
}
