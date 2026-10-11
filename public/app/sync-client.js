// public/app/sync-client.js
// 同步响应的分类与冲突处理——纯逻辑，不发请求（请求在 index.html 里，这里只做可测的判定）。
// 契约见 functions/api/[[route]].js：v2 GET 带 X-Schema-Version: 2；PUT 带 If-Match: rev；
// 409 conflict / 409 client_outdated / 413 capacity_full。

import { mergeStates, detectConflict, isV2, createState } from '../core/index.js';

export const SCHEMA_HEADER = 'X-Schema-Version';
export const SCHEMA_VALUE = '2';

/** PUT 请求要带的头。rev 缺省按 0（首次写入）。 */
export function putHeaders(token, rev) {
  const r = Number.isFinite(rev) ? rev : 0;
  return {
    'Content-Type': 'application/json',
    [SCHEMA_HEADER]: SCHEMA_VALUE,
    'If-Match': String(r),
    Authorization: 'Bearer ' + token
  };
}

export function getHeaders(token) {
  return { [SCHEMA_HEADER]: SCHEMA_VALUE, Authorization: 'Bearer ' + token };
}

/**
 * 把 PUT 的 (status, body) 归到一个明确的 kind，UI 据此分流。
 * 任何没归到的都落到 'error'，不静默当成功。
 */
export function classifyPut(status, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (status >= 200 && status < 300) {
    return { kind: 'ok', rev: Number.isFinite(b.rev) ? b.rev : null, updatedAt: Number(b.updatedAt) || 0 };
  }
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 409 && b.error === 'conflict') {
    return { kind: 'conflict', serverRev: Number(b.rev) || 0, server: isV2(b.data) ? b.data : null };
  }
  if (status === 409 && b.error === 'client_outdated') {
    // 新客户端始终带 schemaVersion:2，正常不会撞上；留兜底提示，不把它当普通错误咽下去。
    return { kind: 'client_outdated', serverRev: Number(b.rev) || 0 };
  }
  if (status === 413) {
    const capacity = b.error === 'capacity_full';
    return { kind: capacity ? 'capacity_full' : 'too_large', detail: b.detail || null, message: b.error || '' };
  }
  if (status === 429) return { kind: 'rate_limited' };
  return { kind: 'error', status, message: b.error || ('HTTP ' + status) };
}

/** GET 的响应：确认拿到的是 v2；不是就当空基线（不去猜服务端的意思）。 */
export function classifyGet(status, body, headers) {
  if (status === 401) return { kind: 'unauthorized' };
  if (status < 200 || status >= 300) return { kind: 'error', status };
  const dataSchema = headers && typeof headers.get === 'function' ? headers.get('X-Data-Schema') : null;
  if (isV2(body)) return { kind: 'ok', state: body, rev: Number(body.rev) || 0, dataSchema };
  return { kind: 'not_v2', state: null, rev: 0, dataSchema };
}

/** 冲突副本：本机整包 + 云端整包 + 时间，存到 sl.v2.conflict，UI 三选一之前不许丢。 */
export function buildConflictRecord(local, server, at) {
  return {
    at: Number.isFinite(at) ? at : Date.now(),
    localRev: Number(local && local.rev) || 0,
    serverRev: Number(server && server.rev) || 0,
    local: local || null,
    server: server || null
  };
}

export const CONFLICT_CHOICES = ['cloud', 'local', 'merge'];

/**
 * 冲突三选一。返回 {state, nextRev, needsPush}：
 *  'cloud'  用云端，本机不再推（本机副本仍留在冲突记录里供导出）；
 *  'local'  用本机，但基线换成云端 rev，再推一次才能落云；
 *  'merge'  合并两边（不丢任何一边独有的记录），再推。
 */
export function resolveConflict(choice, record, ctx) {
  if (!CONFLICT_CHOICES.includes(choice)) {
    const err = new Error('未知的冲突处理选择：' + choice);
    err.code = 'invalid_choice';
    throw err;
  }
  const local = isV2(record && record.local) ? record.local : createState({}, ctx);
  const server = isV2(record && record.server) ? record.server : createState({}, ctx);
  const serverRev = Number(record && record.serverRev) || Number(server.rev) || 0;

  if (choice === 'cloud') return { choice, state: server, nextRev: serverRev, needsPush: false, discardedLocal: local };
  if (choice === 'local') return { choice, state: { ...local, rev: serverRev }, nextRev: serverRev, needsPush: true, discardedLocal: null };
  const merged = mergeStates(local, server, ctx);
  return { choice, state: { ...merged, rev: serverRev }, nextRev: serverRev, needsPush: true, discardedLocal: null };
}

/** 拉取之后要不要提示冲突：本机有未推送改动且云端已经往前走了。 */
export function shouldWarnOnPull(localRev, serverRev, localDirty) {
  const c = detectConflict(localRev, serverRev);
  if (!localDirty) return { warn: false, reason: c.reason };
  return { warn: c.conflict, reason: c.reason };
}
