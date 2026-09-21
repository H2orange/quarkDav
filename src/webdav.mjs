// Minimal read-only WebDAV server (OPTIONS / PROPFIND / GET / HEAD).
// File GET/HEAD: in "proxy" mode (default) we fetch Quark's CDN url and stream
// the bytes back to the client (200/206) so media scanners (网易爆米花/Filmly/
// 飞牛) that probe file content can detect playable media. "redirect" mode
// returns a 302 straight to the CDN (saves our bandwidth, but scanners that
// don't follow redirects will report "no data").
import { Readable } from 'stream';

// "redirect" (default): 302 straight to Quark's CDN — the client pulls the
// bytes itself, so our server pays only for API calls, not video bandwidth.
// "proxy": stream through our server (200/206). Costs inbound+outbound
// bandwidth (~file size per view) but works with clients that refuse to
// follow redirects. Override with the DAV_MODE env var.
const DAV_MODE = process.env.DAV_MODE || 'redirect';
const cache = new Map(); // fid -> { ts, files[] }
const CACHE_TTL = 30_000;

function cacheGet(fid) {
  const e = cache.get(fid);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.files;
  return null;
}
function cacheSet(fid, files) {
  cache.set(fid, { ts: Date.now(), files });
}

// Walk path segments from root (fid "0") to resolve a DAV path to a Quark file.
async function resolvePath(quark, path) {
  const segs = path.split('/').filter(Boolean);
  let cur = { fid: '0', isdir: 1, filename: '', size: 0, updated_at: 0, created_at: 0 };
  for (const seg of segs) {
    let files = cacheGet(cur.fid);
    if (!files) {
      files = await quark.list(cur.fid);
      cacheSet(cur.fid, files);
    }
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
  mpeg: 'video/mpeg', rmvb: 'application/vnd.rn-realmedia-vbr', rm: 'application/vnd.rn-realmedia',
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
async function collectDeep(quark, parentFid, parentPath, depth, out, limit) {
  if (depth < 0 || out.length >= limit) return;
  let files = cacheGet(parentFid);
  if (!files) {
    files = await quark.list(parentFid);
    cacheSet(parentFid, files);
  }
  for (const f of files) {
    if (out.length >= limit) return;
    const cp = parentPath === '/' ? '/' + f.filename : parentPath + '/' + f.filename;
    out.push([f, cp]);
    if (f.isdir === 1) {
      await collectDeep(quark, f.fid, cp, depth - 1, out, limit);
    }
  }
}

export async function handleDav(req, res, quark, { base = '/dav' }) {
  const url = new URL(req.url, 'http://localhost');
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

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        DAV: '1,2',
        Allow: 'OPTIONS, GET, HEAD, PROPFIND',
        'MS-Author-Via': 'DAV',
        'Content-Length': '0',
      });
      return res.end();
    }

    if (req.method === 'PROPFIND') {
      const item = await resolvePath(quark, p);
      const entries = [[item, p]];
      if (item.isdir === 1) {
        const depthHeader = String(req.headers['depth'] ?? '1').toLowerCase();
        if (depthHeader === 'infinity') {
          // Scanner asked for everything at once — recurse (capped so we
          // don't stall on huge drives).
          await collectDeep(quark, item.fid, p, 3, entries, 1200);
        } else if (depthHeader !== '0') {
          let files = cacheGet(item.fid);
          if (!files) {
            files = await quark.list(item.fid);
            cacheSet(item.fid, files);
          }
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
      res.writeHead(207, {
        'Content-Type': 'application/xml; charset=utf-8',
        DAV: '1,2',
      });
      return res.end(xml);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const item = await resolvePath(quark, p);
      if (item.isdir === 1) {
        res.writeHead(405, { 'Content-Length': '0' });
        return res.end();
      }
      const link = await quark.getLink(item.fid);
      if (!link) throw Object.assign(new Error('no link'), { status: 404 });

      if (DAV_MODE === 'redirect') {
        res.writeHead(302, { Location: link, 'Content-Length': '0' });
        return res.end();
      }

      // Proxy mode: fetch Quark's CDN and stream back, honoring Range for seeking.
      const upHeaders = {};
      const range = req.headers['range'];
      if (range) upHeaders['Range'] = range;
      let upstream;
      try {
        upstream = await fetch(link, { method: 'GET', headers: upHeaders, redirect: 'follow' });
      } catch (e) {
        throw Object.assign(new Error('upstream fetch failed: ' + e.message), { status: 502 });
      }
      const out = {};
      const ct = upstream.headers.get('content-type');
      if (ct) out['Content-Type'] = ct;
      const cl = upstream.headers.get('content-length');
      if (cl) out['Content-Length'] = cl;
      const cr = upstream.headers.get('content-range');
      if (cr) out['Content-Range'] = cr;
      out['Accept-Ranges'] = upstream.headers.get('accept-ranges') || 'bytes';
      const etag = upstream.headers.get('etag');
      if (etag) out['ETag'] = etag;
      const lm = upstream.headers.get('last-modified');
      if (lm) out['Last-Modified'] = lm;
      res.writeHead(upstream.status, out);

      // HEAD: headers only, drop the body to save bandwidth.
      if (req.method === 'HEAD' || !upstream.body) {
        try { upstream.body?.cancel?.(); } catch {}
        return res.end();
      }
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', () => { try { res.destroy(); } catch {} });
      req.on('close', () => { try { nodeStream.destroy(); } catch {} });
      nodeStream.pipe(res);
      return;
    }

    res.writeHead(405, { 'Content-Length': '0' });
    res.end();
  } catch (e) {
    const st = e.status || 500;
    res.writeHead(st, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(e.message || 'error');
  }
}
