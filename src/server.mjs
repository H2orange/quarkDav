// HTTP server: serves the admin-protected QR login console + JSON API, and
// mounts the WebDAV handler at /dav.
//
// Threat model: this app is reachable from the public internet, so knowing the
// URL must NOT be enough. Everything except the static shell is gated behind an
// admin password, and the WebDAV mount uses a random per-install secret rather
// than a guessable default.
//
// Hosted-reverse-proxy notes learned the hard way:
//   * the proxy strips the Authorization header -> WebDAV auth lives in the URL
//     path (/dav/<secret>/...), and admin sessions travel in a custom header.
//   * requests may land on different worker processes -> the admin session is
//     HMAC-signed (stateless) and Quark state is reloaded from disk per request.
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { QuarkTV } from './quarkTv.mjs';
import { handleDav } from './webdav.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'token.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const ADMIN_SECRET_FILE = path.join(DATA_DIR, 'admin_secret.txt');
const WEBDAV_PASS_FILE = path.join(DATA_DIR, 'webdav_pass.txt');
const PORT = process.env.PORT || 8080;
const WEBDAV_USER = process.env.WEBDAV_USER || 'admin';
const WEBDAV_PASS = process.env.WEBDAV_PASS || 'admin';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const MIN_PASSWORD_LEN = 8;

const writePrivate = (file, data) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, data, { mode: 0o600 });
};

// ---------------------------------------------------------------- admin auth
// Password: PBKDF2-SHA256 + per-install random salt.
// Session : "<expiryMs>.<hmac>" — stateless, verifiable by any worker.
function loadSecret() {
  try {
    const s = fs.readFileSync(ADMIN_SECRET_FILE, 'utf8').trim();
    if (s) return s;
  } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  writePrivate(ADMIN_SECRET_FILE, s);
  return s;
}
const ADMIN_SECRET = loadSecret();

function loadAdmin() {
  try { return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); } catch { return null; }
}

function hashPassword(pw, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const dk = crypto.pbkdf2Sync(pw, salt, 120_000, 32, 'sha256');
  return { salt: salt.toString('hex'), hash: dk.toString('hex') };
}

function verifyPassword(pw, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  const { hash } = hashPassword(pw, rec.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issueAdminToken() {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(String(exp)).digest('hex');
  return exp + '.' + sig;
}

function verifyAdminToken(t) {
  if (!t || typeof t !== 'string') return false;
  const [expStr, sig] = t.split('.');
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const want = crypto.createHmac('sha256', ADMIN_SECRET).update(expStr).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readAdminToken(req) {
  const h = req.headers['x-admin-token'];
  if (h) return String(h);
  const cookie = req.headers['cookie'] || '';
  const hit = cookie.split(';').map((s) => s.trim())
    .find((s) => s.startsWith('myDavAdmin='));
  return hit ? decodeURIComponent(hit.slice('myDavAdmin='.length)) : '';
}

function checkAdmin(req, res) {
  if (verifyAdminToken(readAdminToken(req))) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '需要管理员登录', needAdmin: true }));
  return false;
}

// ------------------------------------------------------------ webdav secret
// Secret embedded in the mount path (/dav/<secret>/...). It may be typed by
// the owner so it stays memorable, so validation matters: no slashes (it is a
// path segment), no whitespace, and enough length not to be brute-forced.
const MIN_WEBDAV_SECRET_LEN = 6;
const MAX_WEBDAV_SECRET_LEN = 64;
// Owner's call: no secret values are blocked. Note that 'quarkpass' was the
// old hard-coded default in this project's source, so it is publicly known —
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

function loadWebdavSecret() {
  if (process.env.WEBDAV_TOKEN) return process.env.WEBDAV_TOKEN.trim();
  try {
    const t = fs.readFileSync(WEBDAV_PASS_FILE, 'utf8').trim();
    if (t && !validateWebdavSecret(t)) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString('hex');
  writePrivate(WEBDAV_PASS_FILE, t);
  return t;
}
let WEBDAV_TOKEN = loadWebdavSecret();
const setWebdavSecret = (t) => {
  WEBDAV_TOKEN = t;
  writePrivate(WEBDAV_PASS_FILE, t);
};

// -------------------------------------------------------------- quark state
function loadState() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writePrivate(TOKEN_FILE, JSON.stringify(s, null, 2));
}
function reloadState() {
  const s = loadState();
  if (s.deviceID) quark.deviceID = s.deviceID;
  if (s.accessToken) quark.accessToken = s.accessToken;
  if (s.refreshToken) quark.refreshToken = s.refreshToken;
  if (s.queryToken) quark.queryToken = s.queryToken;
}

const quark = new QuarkTV(loadState());
const persist = () => saveState(quark.toState());

// Resolve a DAV-style path to Quark files (used by the post-login browser).
async function listPath(davPath) {
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

function readJsonBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
    });
  });
}

function checkDavAuth(req, res) {
  const auth = req.headers['authorization'];
  if (!auth) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="myDav"' });
    res.end('Auth required');
    return false;
  }
  const [scheme, b64] = auth.split(' ');
  if (scheme !== 'Basic') { res.writeHead(401); res.end(); return false; }
  const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
  if (u !== WEBDAV_USER || p !== WEBDAV_PASS) {
    res.writeHead(403); res.end('forbidden'); return false;
  }
  return true;
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // Static shell only — it contains no secrets; everything sensitive is
    // fetched through authenticated API calls.
    if (p === '/' && req.method === 'GET') {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'login.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ---- admin bootstrap (no auth yet): available only before a password exists
    if (p === '/api/admin/state' && req.method === 'GET') {
      return json(res, 200, { initialized: !!loadAdmin() });
    }
    if (p === '/api/admin/setup' && req.method === 'POST') {
      if (loadAdmin()) return json(res, 403, { error: '管理员密码已设置' });
      const { password } = await readJsonBody(req);
      if (!password || password.length < MIN_PASSWORD_LEN) {
        return json(res, 400, { error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
      }
      writePrivate(ADMIN_FILE, JSON.stringify(hashPassword(password), null, 2));
      return json(res, 200, { ok: true, token: issueAdminToken() });
    }
    if (p === '/api/admin/login' && req.method === 'POST') {
      const rec = loadAdmin();
      if (!rec) return json(res, 400, { error: '尚未设置管理员密码' });
      const { password } = await readJsonBody(req);
      if (!verifyPassword(String(password || ''), rec)) {
        return json(res, 401, { error: '密码错误' });
      }
      return json(res, 200, { ok: true, token: issueAdminToken() });
    }

    // ---- everything below requires an admin session
    if (p.startsWith('/api/') && !checkAdmin(req, res)) return;

    if (p === '/api/admin/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true });
    }
    // Set the WebDAV mount secret: either a value you type in (memorable) or,
    // with no value, a fresh random one. Invalidates the previous mount URL.
    if (p === '/api/webdav/rotate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const wanted = typeof body.secret === 'string' ? body.secret.trim() : '';
      if (wanted) {
        const err = validateWebdavSecret(wanted);
        if (err) return json(res, 400, { error: err });
      }
      const next = wanted || crypto.randomBytes(16).toString('hex');
      if (next === WEBDAV_TOKEN) {
        return json(res, 200, { ok: true, unchanged: true, mountBase: '/dav/' + WEBDAV_TOKEN });
      }
      setWebdavSecret(next);
      return json(res, 200, { ok: true, mountBase: '/dav/' + WEBDAV_TOKEN });
    }

    if (p === '/api/status') {
      reloadState();
      return json(res, 200, {
        loggedIn: !!quark.accessToken,
        deviceID: quark.deviceID,
        webdavToken: WEBDAV_TOKEN,
        mountBase: '/dav/' + WEBDAV_TOKEN,
      });
    }

    if (p === '/api/login/start' && req.method === 'POST') {
      const { qr, queryToken } = await quark.getLoginCode();
      persist();
      return json(res, 200, { qr: 'data:image/png;base64,' + qr, queryToken });
    }

    if (p === '/api/login/status' && req.method === 'POST') {
      const body = await readJsonBody(req);
      reloadState();
      if (body.queryToken) quark.queryToken = body.queryToken;
      if (quark.accessToken) return json(res, 200, { loggedIn: true });
      try {
        const code = await quark.getCode();
        await quark.loginWithCode(code);
        persist();
        return json(res, 200, { loggedIn: true });
      } catch (e) {
        return json(res, 200, { loggedIn: false, error: String(e?.message || e) });
      }
    }

    if (p === '/api/files' && req.method === 'GET') {
      reloadState();
      if (!quark.accessToken) return json(res, 401, { error: '尚未登录' });
      const davPath = url.searchParams.get('path') || '/';
      try {
        const items = await listPath(davPath);
        return json(res, 200, { path: davPath, items });
      } catch (e) {
        return json(res, 500, { error: String(e?.message || e) });
      }
    }

    if (p === '/api/logout' && req.method === 'POST') {
      quark.accessToken = '';
      quark.refreshToken = '';
      quark.queryToken = '';
      persist();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/backup' && req.method === 'GET') {
      reloadState();
      if (!quark.accessToken) return json(res, 401, { error: '尚未登录' });
      return json(res, 200, quark.toState());
    }
    if (p === '/api/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !body.accessToken) return json(res, 400, { error: '无效的备份' });
      quark.accessToken = body.accessToken;
      quark.refreshToken = body.refreshToken || '';
      quark.deviceID = body.deviceID || '';
      quark.queryToken = body.queryToken || '';
      persist();
      return json(res, 200, { ok: true, loggedIn: true });
    }

    // ------------------------------------------------------------- WebDAV
    if (p.startsWith('/dav')) {
      // Auth via a secret path segment (the proxy strips Authorization).
      // The secret may contain non-ASCII (owners can type a Chinese phrase), so
      // compare against the DECODED path — raw url.pathname stays percent-encoded.
      let decoded = p;
      try { decoded = decodeURIComponent(p); } catch {}
      const segs = decoded.slice(4).split('/'); // ['', maybeSecret, ...]
      const authed = segs[1] === WEBDAV_TOKEN;

      // Keep the secret inside req.url: handleDav uses the matched base as the
      // href prefix, so stripping it here would make child hrefs come back
      // without the secret and every follow-up request would be rejected.
      // encodeURI (not encodeURIComponent) keeps the slashes between segments.
      if (authed) reloadState();
      if (!authed && !checkDavAuth(req, res)) return;
      return await handleDav(req, res, quark, {
        base: authed ? '/dav/' + encodeURI(WEBDAV_TOKEN) : '/dav',
      });
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e?.message || e));
  }
});

server.listen(PORT, () => {
  console.log(`myDav listening on http://0.0.0.0:${PORT}`);
});
