// State persistence, abstracted so the same app can run on a filesystem (Node)
// or on Cloudflare KV (Workers).
//
// Keys used everywhere:
//   state       -> Quark login state (deviceID / accessToken / refreshToken / queryToken)
//   admin       -> { salt, hash } for the admin password
//   adminSecret -> per-deployment random secret signing admin session tokens
//   davSecret   -> the WebDAV mount secret embedded in /dav/<secret>
//
// Cloudflare note: KV reads are capped (100k/day on the Free plan) and writes
// are capped even harder (1k/day), so the KV store keeps a short-lived
// in-isolate cache. Writes are rare (login / token refresh / secret rotation),
// so the write cap is not a practical concern; the read cache keeps ordinary
// WebDAV browsing well inside quota.
// Some early deployments wrote these under slightly different names, so each
// key has candidates: reading takes the first that exists, writing goes to the
// first. This keeps an already-mounted instance working after an upgrade
// instead of silently rotating its WebDAV secret.
const FILES = {
  state: ['token.json'],
  admin: ['admin.json'],
  adminSecret: ['admin_secret.txt'],
  davSecret: ['webdav_pass.txt', 'webdav_token.txt'],
};

export function createFsStore(dir, fs) {
  const isJson = (key) => key === 'state' || key === 'admin';
  const candidatesOf = (key) => FILES[key].map((f) => `${dir}/${f}`.replace('//', '/'));

  return {
    async get(key) {
      for (const file of candidatesOf(key)) {
        try {
          const s = fs.readFileSync(file, 'utf8');
          if (s.trim()) return isJson(key) ? JSON.parse(s) : s.trim();
        } catch {}
      }
      return null;
    },
    async set(key, value) {
      const file = candidatesOf(key)[0];
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      fs.writeFileSync(file, raw, { mode: 0o600 });
    },
  };
}

export function createKvStore(kv, { cacheMs = 15000 } = {}) {
  const cache = new Map(); // key -> { ts, value }
  return {
    async get(key) {
      const hit = cache.get(key);
      const now = Date.now();
      if (hit && now - hit.ts < cacheMs) return hit.value;
      let value = null;
      try {
        const raw = await kv.get(key);
        if (raw != null) {
          value = key === 'state' || key === 'admin' ? JSON.parse(raw) : raw;
        }
      } catch {
        value = null;
      }
      cache.set(key, { ts: now, value });
      return value;
    },
    async set(key, value) {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      cache.set(key, { ts: Date.now(), value });
      await kv.put(key, raw);
    },
  };
}
