// 止损计时 — 认证、数据同步 v2、账户找回（Cloudflare Pages Functions, KV）
// 键位：user:{用户名} 凭据；token:{token} 会话(30天TTL)；tokens:{用户名} 会话反向索引；
//       data:{用户名} 全量数据（v1 或 v2）；recovery:{用户名} 找回码哈希；
//       email:{用户名} 绑定邮箱；emailhash:{sha256(邮箱)} 邮箱反查用户名。
// 数据契约：校验与投影在 ./_schema.js，通用工具在 ./_lib.js。
import {
  json, hashPw, newSalt, newToken, revokeAllTokens, userOf, readJson,
  rateLimit, tooBig, limited, randomCode, normalizeCode, sha256hex,
  normalizeEmail, isEmail, emailKey
} from './_lib.js';
import { sanitizeV1, sanitizeV2, projectV1, v1AsV2Seed, canonicalJson, LIMITS } from './_schema.js';

// 请求体上限 1 MiB：tasks 500 + sessions 3000 + decisions 3000 的满载整包约几百 KiB。
// KV 单值硬上限是 25 MiB，所以瓶颈是我们自己定的这条，不是 KV；调大它之前先想清楚 KV 写配额（免费档 1k 写/天）。
const BODY_MAX = 1024 * 1024;

const USER_RE = /^[a-z0-9_一-龥-]{2,20}$/;
const normUser = v => String(v || '').trim().toLowerCase();

async function createUser(env, u, p) {
  const salt = newSalt();
  await env.KV.put('user:' + u, JSON.stringify({ salt, hash: await hashPw(p, salt), createdAt: Date.now() }));
}

export async function onRequest({ request, env, params }) {
  const route = (params.route || []).join('/');
  const method = request.method;

  if (route === 'register' && method === 'POST') {
    if (tooBig(request, 4096)) return json({ error: '请求体过大' }, 413);
    if (!rateLimit(request, 'reg', 5, 3600e3)) return limited();// 5 次/小时/IP
    const b = await request.json().catch(() => ({}));
    const u = normUser(b.username);
    const p = String(b.password || '');
    if (!USER_RE.test(u)) return json({ error: '用户名 2-20 位：中文、字母、数字、_ 或 -' }, 400);
    if (p.length < 6 || p.length > 64) return json({ error: '密码 6-64 位' }, 400);
    if (await env.KV.get('user:' + u)) return json({ error: '用户名已被注册' }, 409);
    await createUser(env, u, p);
    return json({ token: await newToken(env, u) });
  }

  if (route === 'login' && method === 'POST') {
    if (tooBig(request, 4096)) return json({ error: '请求体过大' }, 413);
    if (!rateLimit(request, 'login', 10, 300e3)) return limited();// 10 次/5分钟/IP，兼防密码爆破
    const b = await request.json().catch(() => ({}));
    const u = normUser(b.username);
    const p = String(b.password || '');
    if (p.length < 6 || p.length > 64) return json({ error: '密码不对' }, 401);
    const rec = await env.KV.get('user:' + u);
    if (!rec) return json({ error: '用户不存在' }, 401);
    const r = JSON.parse(rec);
    if (await hashPw(p, r.salt) !== r.hash) return json({ error: '密码不对' }, 401);
    return json({ token: await newToken(env, u) });
  }

  // ---- 账户找回 ------------------------------------------------------------
  // 纯 KV 没有邮箱体系，先用「登录态生成一次性找回码、用户自己抄走」补上可验证的恢复路径
  // 没有邮箱体系的服务端里，这是「忘了密码」唯一可验证的恢复路径。

  // 生成找回码：登录态才能生成，明文只在这次响应里出现一次，服务端只留 PBKDF2 哈希；覆盖旧码。
  if (route === 'recovery/code' && method === 'POST') {
    if (!rateLimit(request, 'reccode', 10, 3600e3)) return limited();// 10 次/小时/IP
    const user = await userOf(env, request);
    if (!user) return json({ error: '未登录或登录已过期' }, 401);
    const code = randomCode(12);
    const salt = newSalt();
    await env.KV.put('recovery:' + user, JSON.stringify({ salt, hash: await hashPw(code, salt), createdAt: Date.now() }));
    return json({ code, note: '这串码只显示这一次，请抄下来另存。用它可以在忘记密码时重置密码。' });
  }

  // 邮箱绑定（预留）：写入绑定关系与反查索引；真正发验证信需要可发信域名。
  if (route === 'recovery/email' && method === 'POST') {
    if (tooBig(request, 4096)) return json({ error: '请求体过大' }, 413);
    if (!rateLimit(request, 'recmail', 10, 3600e3)) return limited();
    const user = await userOf(env, request);
    if (!user) return json({ error: '未登录或登录已过期' }, 401);
    const b = await request.json().catch(() => ({}));
    const email = normalizeEmail(b.email);
    if (!isEmail(email)) return json({ error: '邮箱格式不对' }, 400);

    const verifyToken = randomCode(16);
    const vSalt = newSalt();
    await env.KV.put('email:' + user, JSON.stringify({
      email, verified: false, at: Date.now(),
      verify: { salt: vSalt, hash: await hashPw(verifyToken, vSalt) } // 明文验证码只出现在信里
    }));
    // 反查索引：防止同一邮箱被重复绑定到不同账户。
    await env.KV.put(await emailKey(email), user);

    // 发信为什么还没接（Cloudflare Pages 的能力边界，别按老印象改）：
    //   1. `[[send_email]]` 绑定 **Pages Functions 根本不支持**——官方 Pages 绑定清单里没有 email 一项，
    //      它「works exclusively within Cloudflare Workers」。所以这里不可能直接拿到一个 send_email 绑定。
    //   2. 发信要求域名托管在 Cloudflare DNS 并 onboard 到 Email Service；`*.pages.dev` 是 Cloudflare 自己的
    //      zone，onboard 不了，发件地址会得到 E_SENDER_NOT_VERIFIED。
    //   3. 免费档只能发给账户里**已验证的目的地址**（也就是只能发给自己）；发给任意收件人要 Workers Paid。
    // 可行路线是 Service binding：Pages Function → env.SEND_EMAIL.fetch(...) → 一个持有 send_email 绑定的
    // 独立 Worker 去发。Service binding 是 Pages Functions 支持的绑定之一。所以下面按 **fetch** 调用，
    // 不是 `new EmailMessage(...)`（那是 legacy 的 Workers 内写法，在 Pages 这一侧用不上）。
    if (env.SEND_EMAIL && typeof env.SEND_EMAIL.fetch === 'function') {
      try {
        const res = await env.SEND_EMAIL.fetch('https://mailer.internal/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: email,
            from: env.MAIL_FROM || null,          // 由发信 Worker 决定默认发件地址
            subject: '止损计时 · 邮箱验证',
            text: '验证码：' + verifyToken + '\n\n如果这不是你本人操作，忽略即可。'
          })
        });
        if (!res.ok) return json({ pending: true, reason: 'email_send_failed', status: res.status });
        return json({ pending: true, sent: true });
      } catch (e) {
        return json({ pending: true, reason: 'email_send_failed', detail: String(e && e.message || e).slice(0, 200) });
      }
    }
    return json({ pending: true, reason: 'email_sending_not_configured' });
  }

  // 凭找回码重置密码：成功后吊销该用户全部会话（旧 token 立刻失效），并作废这枚找回码。
  if (route === 'recover' && method === 'POST') {
    if (tooBig(request, 4096)) return json({ error: '请求体过大' }, 413);
    if (!rateLimit(request, 'recover', 5, 3600e3)) return limited();// 5 次/小时/IP，严格：这是绕过密码的入口
    const b = await request.json().catch(() => ({}));
    const u = normUser(b.username);
    const code = normalizeCode(b.code);
    const p = String(b.password || '');
    if (p.length < 6 || p.length > 64) return json({ error: '新密码 6-64 位' }, 400);
    // 用户不存在 / 没设过找回码 / 码不对，一律同一句话同一状态码：别把「这个用户名存在」泄漏出去。
    const bad = () => json({ error: '用户名或找回码不对' }, 401);
    if (!USER_RE.test(u) || code.length !== 12) return bad();
    if (!(await env.KV.get('user:' + u))) return bad();
    const rec = await readJson(env, 'recovery:' + u, null);
    if (!rec) return bad();
    if (await hashPw(code, rec.salt) !== rec.hash) return bad();

    await createUser(env, u, p);
    await env.KV.delete('recovery:' + u);   // 一次性：用掉即作废，重置后需重新生成
    await revokeAllTokens(env, u);          // 找回码可能是被人捡到的，重置后把所有旧会话踢掉
    return json({ token: await newToken(env, u), recoveryCodeUsed: true });
  }

  // ---- 数据同步 ------------------------------------------------------------
  if (route === 'data') {
    if (method === 'GET') {
      if (!rateLimit(request, 'get', 120, 60e3)) return limited();// 120 次/分钟/IP
      const user = await userOf(env, request);
      if (!user) return json({ error: '未登录或登录已过期' }, 401);
      const stored = await readJson(env, 'data:' + user, null);
      const wantsV2 = request.headers.get('X-Schema-Version') === '2';

      if (!stored) {
        return wantsV2
          ? json({ schemaVersion: 2, rev: 0, tasks: [], sessions: [], decisions: [], updatedAt: 0 }, 200, { 'X-Data-Schema': '0' })
          : json({ updatedAt: 0, items: [], history: [] }, 200, { 'X-Data-Schema': '0' });
      }
      if (stored.schemaVersion === 2) {
        // 旧客户端拿到的是投影；X-Data-Schema: 2 告诉它「云端已经是新格式了，你该升级」。
        return wantsV2
          ? json(stored, 200, { 'X-Data-Schema': '2' })
          : json(projectV1(stored), 200, { 'X-Data-Schema': '2' });
      }
      // 存的是 v1
      return wantsV2
        ? json(v1AsV2Seed(stored), 200, { 'X-Data-Schema': '1' })
        : json(stored, 200, { 'X-Data-Schema': '1' });
    }

    if (method === 'PUT') {
      if (tooBig(request, BODY_MAX)) return json({ error: '请求体过大' }, 413);
      if (!rateLimit(request, 'put', 30, 60e3)) return limited();// 30 次/分钟/IP，护住 KV 写配额
      const user = await userOf(env, request);
      if (!user) return json({ error: '未登录或登录已过期' }, 401);
      const raw = await request.text();
      if (raw.length > BODY_MAX) return json({ error: '请求体过大' }, 413); // Content-Length 可能缺失（chunked），再兜一次
      let b = null;
      try { b = JSON.parse(raw); } catch { b = null; }
      if (!b || typeof b !== 'object') return json({ error: 'bad body' }, 400);

      const stored = await readJson(env, 'data:' + user, null);
      const storedIsV2 = !!stored && stored.schemaVersion === 2;
      const storedRev = storedIsV2 ? (Number(stored.rev) || 0) : 0;

      // 旧客户端（v1 整包）遇上已经是 v2 的云端：拒绝，不覆盖。整包后写覆盖会把新字段全抹掉。
      if (b.schemaVersion !== 2) {
        if (storedIsV2) return json({ error: 'client_outdated', rev: storedRev }, 409);
        const rec = sanitizeV1(b);
        await env.KV.put('data:' + user, JSON.stringify(rec));
        return json({ ok: true, updatedAt: rec.updatedAt });
      }

      // v2：乐观并发。If-Match 缺失或为空按 0（新建）处理。
      const ifMatch = (request.headers.get('If-Match') || '').replace(/^W\/|"/g, '').trim();
      const claimed = ifMatch === '' ? 0 : Number(ifMatch);
      if (!Number.isInteger(claimed) || claimed < 0) return json({ error: 'bad_if_match' }, 400);
      if (claimed !== storedRev) {
        // 把云端整包一起还回去，客户端才能给用户「保留云端／保留本机／导出本机」三选一。
        return json({ error: 'conflict', rev: storedRev, data: stored || null }, 409);
      }

      const clean = sanitizeV2(b);
      if (!clean.ok) return json(clean.body, clean.status);

      const rec = { ...clean.value, rev: storedRev + 1, updatedAt: Number(b.updatedAt) || Date.now() };
      // v1 存量首次被 v2 覆盖时，若客户端没带 legacy，就把原始 v1 整包留档（原始快照不可丢）。
      if (!rec.legacy && stored && !storedIsV2) {
        rec.legacy = { version: 1, capturedAt: Date.now(), items: stored.items || [], history: stored.history || [] };
      }

      // 内容没变就不写 KV。免费档 KV 只有 1000 次写/天，整包 PUT 下约 200 个
      // 活跃同步用户就打满；客户端 debounce 只能压掉连续输入，压不掉「点开又关上、什么也没改」
      // 这类等价提交，那一层必须由服务端短路。rev 不变，客户端的 If-Match 仍然对得上，不会引发假冲突。
      rec.hash = await sha256hex(canonicalJson(rec));
      if (storedIsV2 && stored.hash === rec.hash) {
        return json({ ok: true, rev: storedRev, unchanged: true, updatedAt: stored.updatedAt, limits: LIMITS });
      }

      await env.KV.put('data:' + user, JSON.stringify(rec));
      return json({ ok: true, rev: rec.rev, updatedAt: rec.updatedAt, limits: LIMITS });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  return json({ error: 'not found' }, 404);
}
