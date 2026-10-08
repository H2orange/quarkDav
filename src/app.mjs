// Runtime-neutral application core.
//
// Everything here speaks Web standard Request/Response and takes its storage
// through the injected `store`, so the same file serves both the Node host
// (src/server.mjs) and the Cloudflare Worker (src/worker.mjs).
//
// Threat model (unchanged from the original Node build): this app is reachable
// from the public internet, so knowing the URL must NOT be enough. Everything
// except the static shell is gated behind an admin password, and the WebDAV
// mount uses a random per-deployment secret rather than a guessable default.
import { QuarkTV } from './quarkTv.mjs';
import { handleDav } from './webdav.mjs';
import { randomHex, pbkdf2Hash, hmacSign, hmacEq, safeEqual } from './cryptoX.mjs';

const MIN_PASSWORD_LEN = 8;

const json = (code, obj) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });

export function createApp({ store, readAsset, opts = {} } = {}) {
  const MODE = opts.mode || 'redirect';
  const PBKDF2_ITER = Number(opts.pbkdf2Iterations) || 120000;
  const WEBDAV_USER = opts.webdavUser || 'admin';
  const WEBDAV_PASS = opts.webdavPass || 'admin';
  const SESSION_HOURS = Number(opts.sessionHours) || 12;
  const MAX_SUBREQUESTS = Number(opts.maxSubrequests) || Infinity;

  // ------------------------------------------------------------ admin auth
  let cachedSecret = null;
  async function getSecret() {
    if (cachedSecret) return cachedSecret;
    let s = await store.get('adminSecret');
    if (!s) {
      s = randomHex(32);
      await store.set('adminSecret', s);
    }
    cachedSecret = s;
    return s;
  }

  async function issueAdminToken() {
    const exp = Date.now() + SESSION_HOURS * 3600_000;
    const sig = await hmacSign(await getSecret(), String(exp));
    return exp + '.' + sig;
  }
  async function verifyAdminToken(t) {
    if (!t || typeof t !== 'string') return false;
    const [expStr, sig] = t.split('.');
    if (!expStr || !sig) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    return hmacEq(await getSecret(), expStr, sig);
  }
  function readAdminToken(request) {
    const h = request.headers.get('x-admin-token');
    if (h) return String(h);
    const cookie = request.headers.get('cookie') || '';
    const hit = cookie.split(';').map((s) => s.trim())
      .find((s) => s.startsWith('myDavAdmin='));
    return hit ? decodeURIComponent(hit.slice('myDavAdmin='.length)) : '';
  }
  async function requireAdmin(request) {
    if (await verifyAdminToken(readAdminToken(request))) return null;
    return json(401, { error: '需要管理员登录', needAdmin: true });
  }

  // ---------------------------------------------------------- webdav secret
  const MIN_WEBDAV_SECRET_LEN = 6;
  const MAX_WEBDAV_SECRET_LEN = 64;
  // Owner's call: no secret values are blocked. 'quarkpass' was the old
  // hard-coded default in this project's source, so it is publicly known —
  // anyone who has seen the code can use it. Kept empty intentionally.
  const LEGACY_SECRETS = new Set();

  function validateWebdavSecret(s) {
    if (typeof s !== 'string') return '密钥格式无效';
    const t = s.trim();
    if (t.length < MIN_WEBDAV_SECRET_LEN) return `密钥至少 ${MIN_WEBDAV_SECRET_LEN} 位`;
    if (t.length > MAX_WEBDAV_SECRET_LEN) return `密钥最多 ${MAX_WEBDAV_SECRET_LEN} 位`;
    if (/[/\\?#\s]/.test(t)) return '密钥不能包含空格、斜杠或 ? # 字符';
    if (t === '.' || t === '..') return '密钥无效';
    if (LEGACY_SECRETS.has(t)) return '该密钥已被停用，请换一个';
    return '';
  }

  let cachedWebdavSecret = null;
  async function getWebdavSecret() {
    if (cachedWebdavSecret) return cachedWebdavSecret;
    if (opts.webdavToken) return (cachedWebdavSecret = opts.webdavToken.trim());
    let t = await store.get('davSecret');
    if (!t || validateWebdavSecret(t)) {
      t = randomHex(16);
      await store.set('davSecret', t);
    }
    cachedWebdavSecret = t;
    return t;
  }
  async function setWebdavSecret(t) {
    cachedWebdavSecret = t;
    await store.set('davSecret', t);
  }

  // ------------------------------------------------------------ quark state
  async function makeQuark() {
    try { return new QuarkTV((await store.get('state')) || {}); } catch { return new QuarkTV(); }
  }
  // One Quark instance per request (Workers has nothing equivalent to Node's
  // long-lived module singleton). If a call refreshed the access token we write
  // it back — otherwise every single request would pay for a refresh.
  async function withQuark(fn) {
    const q = await makeQuark();
    const before = q.accessToken;
    try {
      return await fn(q);
    } finally {
      if (q.accessToken !== before) {
        try { await store.set('state', q.toState()); } catch {}
      }
    }
  }

  // Resolve a DAV-style path to Quark files (used by the post-login browser).
  async function listPath(quark, davPath) {
    const segs = davPath.split('/').filter(Boolean);
    let cur = { fid: '0', isdir: 1, filename: '', size: 0 };
    for (const seg of segs) {
      const files = await quark.list(cur.fid);
      const found = files.find((f) => f.filename === seg);
      if (!found) throw new Error('路径不存在: ' + seg);
      cur = found;
    }
    if (cur.isdir !== 1) {
      return [{ name: cur.filename, isdir: false, size: cur.size, updated: cur.updated_at }];
    }
    const files = await quark.list(cur.fid);
    return files.map((f) => ({
      name: f.filename, isdir: f.isdir === 1, size: f.size, updated: f.updated_at,
    }));
  }

  function davAuthResponse(request) {
    const auth = request.headers.get('authorization');
    if (!auth) {
      return new Response('Auth required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="myDav"' },
      });
    }
    const [scheme, b64] = auth.split(' ');
    if (scheme !== 'Basic') return new Response('Unauthorized', { status: 401 });
    // Workers has no Buffer; atob is available in both runtimes.
    const [u, p] = atob(b64).split(':');
    if (u !== WEBDAV_USER || p !== WEBDAV_PASS) {
      return new Response('forbidden', { status: 403 });
    }
    return null;
  }

  async function readJsonBody(request) {
    try {
      const t = await request.text();
      return t ? JSON.parse(t) : {};
    } catch {
      return {};
    }
  }

  // ------------------------------------------------------------------ router
  return async function handleRequest(request) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      // Static shell only — it contains no secrets; everything sensitive is
      // fetched through authenticated API calls.
      if (p === '/' && request.method === 'GET' && readAsset) {
        return await readAsset(request);
      }

      // --- admin bootstrap (no auth yet): only before a password exists
      if (p === '/api/admin/state' && request.method === 'GET') {
        return json(200, { initialized: !!(await store.get('admin')) });
      }
      if (p === '/api/admin/setup' && request.method === 'POST') {
        if (await store.get('admin')) return json(403, { error: '管理员密码已设置' });
        const { password } = await readJsonBody(request);
        if (!password || password.length < MIN_PASSWORD_LEN) {
          return json(400, { error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
        }
        const rec = await pbkdf2Hash(password, null, PBKDF2_ITER);
        await store.set('admin', rec);
        return json(200, { ok: true, token: await issueAdminToken() });
      }
      if (p === '/api/admin/login' && request.method === 'POST') {
        const rec = await store.get('admin');
        if (!rec) return json(400, { error: '尚未设置管理员密码' });
        const { password } = await readJsonBody(request);
        const want = await pbkdf2Hash(String(password || ''), rec.salt, PBKDF2_ITER);
        const ok = safeEqual(want.hash, rec.hash);
        if (!ok) return json(401, { error: '密码错误' });
        return json(200, { ok: true, token: await issueAdminToken() });
      }

      // --- everything below requires an admin session
      if (p.startsWith('/api/')) {
        const denied = await requireAdmin(request);
        if (denied) return denied;
      }

      if (p === '/api/admin/logout' && request.method === 'POST') {
        return json(200, { ok: true });
      }

      if (p === '/api/webdav/rotate' && request.method === 'POST') {
        const current = await getWebdavSecret();
        const body = await readJsonBody(request);
        const wanted = typeof body.secret === 'string' ? body.secret.trim() : '';
        if (wanted) {
          const err = validateWebdavSecret(wanted);
          if (err) return json(400, { error: err });
        }
        const next = wanted || randomHex(16);
        if (next === current) {
          return json(200, { ok: true, unchanged: true, mountBase: '/dav/' + current });
        }
        await setWebdavSecret(next);
        return json(200, { ok: true, mountBase: '/dav/' + next });
      }

      if (p === '/api/status') {
        const token = await getWebdavSecret();
        return json(200, await withQuark(async (q) => ({
          loggedIn: !!q.accessToken,
          deviceID: q.deviceID,
          webdavToken: token,
          mountBase: '/dav/' + token,
        })));
      }

      if (p === '/api/login/start' && request.method === 'POST') {
        return await withQuark(async (q) => {
          const { qr, queryToken } = await q.getLoginCode();
          await store.set('state', q.toState());
          return json(200, { qr: 'data:image/png;base64,' + qr, queryToken });
        });
      }

      if (p === '/api/login/status' && request.method === 'POST') {
        const body = await readJsonBody(request);
        return await withQuark(async (q) => {
          if (body.queryToken) q.queryToken = body.queryToken;
          if (q.accessToken) return json(200, { loggedIn: true });
          try {
            const code = await q.getCode();
            await q.loginWithCode(code);
            await store.set('state', q.toState());
            return json(200, { loggedIn: true });
          } catch (e) {
            return json(200, { loggedIn: false, error: String(e?.message || e) });
          }
        });
      }

      if (p === '/api/files' && request.method === 'GET') {
        const davPath = url.searchParams.get('path') || '/';
        return await withQuark(async (q) => {
          if (!q.accessToken) return json(401, { error: '尚未登录' });
          try {
            return json(200, { path: davPath, items: await listPath(q, davPath) });
          } catch (e) {
            return json(500, { error: String(e?.message || e) });
          }
        });
      }

      if (p === '/api/logout' && request.method === 'POST') {
        return await withQuark(async (q) => {
          q.accessToken = '';
          q.refreshToken = '';
          q.queryToken = '';
          await store.set('state', q.toState());
          return json(200, { ok: true });
        });
      }

      if (p === '/api/backup' && request.method === 'GET') {
        return await withQuark(async (q) => {
          if (!q.accessToken) return json(401, { error: '尚未登录' });
          return json(200, q.toState());
        });
      }
      if (p === '/api/restore' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (!body || !body.accessToken) return json(400, { error: '无效的备份' });
        return await withQuark(async (q) => {
          q.accessToken = body.accessToken;
          q.refreshToken = body.refreshToken || '';
          q.deviceID = body.deviceID || '';
          q.queryToken = body.queryToken || '';
          await store.set('state', q.toState());
          return json(200, { ok: true, loggedIn: true });
        });
      }

      // ------------------------------------------------------------- WebDAV
      if (p.startsWith('/dav')) {
        const token = await getWebdavSecret();
        // Auth via a secret path segment (some proxies strip Authorization).
        // The secret may contain non-ASCII, so compare against the DECODED path
        // — url.pathname stays percent-encoded.
        let decoded = p;
        try { decoded = decodeURIComponent(p); } catch {}
        const segs = decoded.slice(4).split('/'); // ['', maybeSecret, ...]
        const authed = segs[1] === token;

        if (!authed) {
          const denied = davAuthResponse(request);
          if (denied) return denied;
        }
        return await withQuark((q) =>
          handleDav(request, q, {
            // Keep the secret inside the base: handleDav uses it as the href
            // prefix, so stripping it would drop the secret from child hrefs
            // and every follow-up request would be rejected.
            base: authed ? '/dav/' + encodeURI(token) : '/dav',
            mode: MODE,
            maxSubrequests: MAX_SUBREQUESTS,
          })
        );
      }

      return new Response('not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    } catch (e) {
      return new Response(String(e?.message || e), {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  };
}
