// public/app/sounds.js
// 自定义提醒音（Pro）的本机存储。**只存在这台设备上**：IndexedDB，不上传、不分享、不进同步整包。
// 导入音频限制为个人使用，不建设公开上传、分享或音频内容市场；
// 第 6 节产品分析不变量：音频不上传到任何分析系统。
//
// 校验部分是纯函数（可单测）；IndexedDB 部分全部包了 try/catch —— 隐私模式、配额用尽、
// 老浏览器都可能整个 API 不可用，那时降级回基础铃声，不能把产品搞成打不开。

export const DB_NAME = 'sl.sounds';          // IndexedDB 库名
export const DB_VERSION = 1;
export const STORE = 'clips';                // object store：{id, name, type, size, blob, addedAt}
export const MAX_BYTES = 2 * 1024 * 1024;    // 单个音频 ≤ 2 MB
export const ACCEPT = 'audio/*,.mp3,.wav,.ogg,.m4a';

/**
 * 导入前的校验。返回 {ok:true} 或 {ok:false, reason:'too_big'|'bad_type'|'empty'}。
 * 纯函数：只看 name/type/size 三个字段，测试里传普通对象即可。
 */
export function validateClip(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) return { ok: false, reason: 'empty' };
  if (file.size > MAX_BYTES) return { ok: false, reason: 'too_big' };
  const type = String(file.type || '');
  const name = String(file.name || '').toLowerCase();
  const extOk = /\.(mp3|wav|ogg|m4a|aac|flac)$/.test(name);
  // 有些系统给出的 type 是空串（尤其是从压缩包里拖出来的），此时退到扩展名判断，不一刀切拒绝。
  if (!type.startsWith('audio/') && !extOk) return { ok: false, reason: 'bad_type' };
  return { ok: true };
}

export const isSupported = () => typeof indexedDB !== 'undefined' && indexedDB !== null;

function openDb() {
  return new Promise((resolve, reject) => {
    if (!isSupported()) { reject(new Error('indexeddb_unavailable')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb_open_failed'));
    req.onblocked = () => reject(new Error('indexeddb_blocked'));
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error || new Error('indexeddb_tx_failed'));
    t.onabort = () => reject(t.error || new Error('indexeddb_tx_aborted'));
  });
}

const newClipId = () => 'clip_' + (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

/** 存一段音频。返回元数据（不含 blob），失败抛错由调用方转成提示文案。 */
export async function putClip(file) {
  const v = validateClip(file);
  if (!v.ok) { const e = new Error(v.reason); e.code = v.reason; throw e; }
  const db = await openDb();
  const rec = {
    id: newClipId(),
    name: String(file.name || 'audio').slice(0, 80),
    type: String(file.type || ''),
    size: file.size,
    addedAt: Date.now(),
    blob: file
  };
  await tx(db, 'readwrite', store => store.put(rec));
  db.close();
  return { id: rec.id, name: rec.name, type: rec.type, size: rec.size, addedAt: rec.addedAt };
}

/** 列出全部音频的元数据（不读 blob 内容，列表页不必把几 MB 全拉进内存）。 */
export async function listClips() {
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rows
    .map(r => ({ id: r.id, name: r.name, type: r.type, size: r.size, addedAt: r.addedAt }))
    .sort((a, b) => a.addedAt - b.addedAt);
}

export async function getClip(id) {
  if (!id) return null;
  const db = await openDb();
  const row = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return row;
}

export async function deleteClip(id) {
  const db = await openDb();
  await tx(db, 'readwrite', store => store.delete(id));
  db.close();
  return true;
}

/**
 * 把一段音频解码成 AudioBuffer，供 beepAt() 预排到音频时钟上——
 * 到点提醒必须走同一条「预排到 AudioContext 时钟」的路，否则后台标签被节流就会漂
 * （README「别破坏的机制」）。解码失败返回 null，调用方退回基础铃声。
 */
export async function decodeClip(ac, id, cache) {
  if (!ac || !id) return null;
  if (cache && cache.has(id)) return cache.get(id);
  try {
    const row = await getClip(id);
    if (!row || !row.blob) return null;
    const buf = await row.blob.arrayBuffer();
    const decoded = await ac.decodeAudioData(buf);
    if (cache) cache.set(id, decoded);
    return decoded;
  } catch (e) {
    return null;   // 解不开的文件不该让提醒整个哑掉
  }
}

export const formatSize = bytes => {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
};
