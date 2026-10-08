// Minimal read-only WebDAV (OPTIONS / PROPFIND / GET / HEAD) built on Web
// standard Request/Response, so it runs identically on Node 22 and Cloudflare
// Workers.
//
// IMPORTANT: this module must not touch anything Node-specific — Worker bundles
// would fail at deploy time.
//
// Two serving modes (DIC_MODE in the old Node build, "mode" here):
//   redirect: 302 straight to Quark's CDN. The client pulls the bytes itself,
//             so we pay only for API calls. This is the ONLY sensible mode on
//             Cloudflare: proxying a 2-hour movie would hold one edge request
//             open for the whole playback.
//   proxy:    stream through us (200/206). Needed only for clients that refuse
//             to follow redirects; on Workers it risks being cut off mid-play.
const cache = new Map(); // fid -> { ts, files[] }
const CACHE_TTL = 30_000;
const CACHE_MAX = 200; // Worker isolate memory is capped at 128MB — keep it bounded.

function cacheGet(fid) {
  const e = cache.get(fid);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.files;
  return null;
}
function cacheSet(fid, files) {
  if (cache.size >= CACHE_MAX) {
    let n = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++n >= CACHE_MAX / 2) break;
    }
  }
  cache.set(fid, { ts: Date.now(), files });
}

// A per-request quota for outbound Quark API calls. Cloudflare's Free plan
// caps a request at 50 subrequests, so a naive Depth: infinity walk over a big
// drive (one list call per folder) would be killed mid-response. We spend the
// budget deliberately and stop walking once it runs out.
function makeBudget(max) {
  let remaining = Number.isFinite(max) && max > 0 ? max : Infinity;
  return {
    get left() { return remaining; },
    async list(quark, fid) {
      if (remaining <= 0) return [];
      remaining -= 1;
      const hit = cacheGet(fid);
      if (hit) return hit;
      const files = await quark.list(fid);
      cacheSet(fid, files);
      return files;
    },
  };
}

// Walk path segments from root (fid "0") to resolve a DAV path to a Quark file.
async function resolvePath(quark, path, budget) {
  const segs = path.split('/').filter(Boolean);
  let cur = { fid: '0', isdir: 1, filename: '', size: 0, updated_at: 0, created_at: 0 };
  for (const seg of segs) {
    const files = await budget.list(quark, cur.fid);
    const found = files.find((f) => f.filename === seg);
    if (!found) throw Object.assign(new Error('not found'), { status: 404 });
    cur = found;
  }
  return cur;
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])
  );
}
const rfc1123 = (ms) => new Date(Number(ms) || Date.now()).toUTCString();
const isoDate = (ms) => new Date(Number(ms) || Date.now()).toISOString();

// Media scanners decide "is this playable?" from getcontenttype, so we must
// always emit it — without it they report "no usable data".
const MIME = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mov: 'video/quicktime', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  webm: 'video/webm', m4v: 'video/x-m4v', ts: 'video/mp2t', mpg: 'video/mpeg',
  mpeg: 'video/mpeg', rmvb: 'application/vnd.rn-realmedia-vbr', rm: 'application/vnd.rn-realmedia-vbr',
  iso: 'application/x-iso9660-image',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', aac: 'audio/aac',
  m4a: 'audio/mp4', ogg: 'audio/ogg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
  srt: 'text/srt', ass: 'text/x-ssa', ssa: 'text/x-ssa', vtt: 'text/vtt',
  txt: 'text/plain', pdf: 'application/pdf', zip: 'application/zip',
  rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
};
const mimeOf = (name = '') => {
  const ext = String(name).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
};

// Build one <D:response>. NOTE: every element MUST carry the D: prefix —
// xmlns:D="DAV:" only binds the prefix, so unprefixed elements land in the
// empty namespace and namespace-aware clients (网易爆米花) parse zero
// resources, reporting "未发现可用数据".
function propstat(item, href) {
  const isDir = item.isdir === 1;
  const resourcetype = isDir
    ? '<D:resourcetype><D:collection/></D:resourcetype>'
    : '<D:resourcetype/>';
  const size = isDir ? 0 : (item.size || 0);
  const ctype = isDir ? '' : `<D:getcontenttype>${mimeOf(item.filename)}</D:getcontenttype>`;
  // href is already percent-encoded by hrefFor(); encoding again here would
  // double-escape it (%25E6...) and break clients on non-ASCII mount secrets.
  return `    <D:response>
      <D:href>${xmlEscape(href)}</D:href>
      <D:propstat>
        <D:prop>
          ${resourcetype}
          <D:getcontentlength>${size}</D:getcontentlength>
          ${ctype}
          <D:getetag>"${item.fid || '0'}-${size}"</D:getetag>
          <D:getlastmodified>${rfc1123(item.updated_at)}</D:getlastmodified>
          <D:creationdate>${isoDate(item.created_at)}</D:creationdate>
          <D:displayname>${xmlEscape(item.filename || '')}</D:displayname>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`;
}

// Recursively collect descendants (for Depth: infinity).
async function collectDeep(quark, parentFid, parentPath, depth, out, limit, budget) {
  if (depth < 0 || out.length >= limit || budget.left <= 0) return;
  const files = await budget.list(quark, parentFid);
  for (const f of files) {
    if (out.length >= limit || budget.left <= 0) return;
    const cp = parentPath === '/' ? '/' + f.filename : parentPath + '/' + f.filename;
    out.push([f, cp]);
    if (f.isdir === 1) {
      await collectDeep(quark, f.fid, cp, depth - 1, out, limit, budget);
    }
  }
}

const text = (status, msg, headers = {}) =>
  new Response(msg, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  });

export async function handleDav(request, quark, {
  base = '/dav',
  mode = 'redirect',
  maxSubrequests = Infinity,
} = {}) {
  const url = new URL(request.url);
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    p = url.pathname; // malformed percent-escape (e.g. a literal % in a name)
  }
  // Keep the mount prefix (/dav/<secret>) so emitted hrefs stay under the
  // client's mount point — otherwise it requests a path our handler never sees.
  // Compare in the same (decoded) space the server used to validate, and
  // percent-encode the prefix when emitting hrefs (the secret may be non-ASCII).
  let prefix = '';
  const decodedBase = (() => {
    try { return decodeURIComponent(base); } catch { return base; }
  })();
  if (p.startsWith(decodedBase)) {
    prefix = encodeURI(decodedBase);
    p = p.slice(decodedBase.length);
  }
  if (p === '') p = '/';
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  // Directories get a trailing slash in href (WebDAV convention).
  const hrefFor = (item, rel) => {
    const full = prefix + (rel === '/' ? '/' : encodeURI(rel));
    const tail = item.isdir === 1 && !full.endsWith('/') ? '/' : '';
    return full + tail;
  };

  const budget = makeBudget(maxSubrequests);

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          DAV: '1,2',
          Allow: 'OPTIONS, GET, HEAD, PROPFIND',
          'MS-Author-Via': 'DAV',
          'Content-Length': '0',
        },
      });
    }

    if (request.method === 'PROPFIND') {
      const item = await resolvePath(quark, p, budget);
      const entries = [[item, p]];
      if (item.isdir === 1) {
        const depthHeader = String(request.headers.get('depth') ?? '1').toLowerCase();
        if (depthHeader === 'infinity') {
          // Scanner asked for everything at once — recurse, but bounded by both
          // a node cap and the subrequest budget (50 on Cloudflare Free).
          await collectDeep(quark, item.fid, p, 3, entries, 1200, budget);
        } else if (depthHeader !== '0') {
          const files = await budget.list(quark, item.fid);
          for (const f of files) {
            const childPath = p === '/' ? '/' + f.filename : p + '/' + f.filename;
            entries.push([f, childPath]);
          }
        }
      }
      const xml =
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<D:multistatus xmlns:D="DAV:">\n' +
        entries.map(([it, rel]) => propstat(it, hrefFor(it, rel))).join('\n') +
        '\n</D:multistatus>';
      return new Response(xml, {
        status: 207,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1,2' },
      });
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const item = await resolvePath(quark, p, budget);
      if (item.isdir === 1) return text(405, 'Directory', { 'Content-Length': '0' });
      const link = await quark.getLink(item.fid);
      if (!link) throw Object.assign(new Error('no link'), { status: 404 });

      if (mode !== 'proxy') {
        return new Response(null, { status: 302, headers: { Location: link } });
      }

      // Proxy mode: fetch Quark's CDN and stream back, honoring Range for seeking.
      const up = {};
      const range = request.headers.get('range');
      if (range) up.Range = range;
      let upstream;
      try {
        upstream = await fetch(link, { method: 'GET', headers: up, redirect: 'follow' });
      } catch (e) {
        throw Object.assign(new Error('upstream fetch failed: ' + e.message), { status: 502 });
      }
      const out = new Headers();
      for (const h of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) out.set(h, v);
      }
      out.set('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');

      if (request.method === 'HEAD' || !upstream.body) {
        if (upstream.body) { try { await upstream.body.cancel(); } catch {} }
        return new Response(null, { status: upstream.status, headers: out });
      }
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    return text(405, 'Method not allowed', { 'Content-Length': '0' });
  } catch (e) {
    return text(e.status || 500, e.message || 'error');
  }
}
