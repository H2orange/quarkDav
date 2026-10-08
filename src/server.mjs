// Node entry point (WorkBuddy hosting / local / any VPS).
//
// It is deliberately a thin shell: convert the Node IncomingMessage into a Web
// Request, hand it to the shared app core, then write the returned Response
// back. All business logic lives in src/app.mjs so the Cloudflare Worker stays
// byte-for-byte in step with this deployment.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { createApp } from './app.mjs';
import { createFsStore } from './store.mjs';
import { LOGIN_HTML } from './consoleHtml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = process.env.PORT || 8080;

const store = createFsStore(DATA_DIR, fs);

// Same generated string the Worker serves, so both deployments are identical.
const readAsset = async () =>
  new Response(LOGIN_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

const app = createApp({
  store,
  readAsset,
  opts: {
    mode: process.env.DAV_MODE || 'redirect',
    pbkdf2Iterations: process.env.PBKDF2_ITERATIONS || 120000,
    webdavUser: process.env.WEBDAV_USER || 'admin',
    webdavPass: process.env.WEBDAV_PASS || 'admin',
    webdavToken: process.env.WEBDAV_TOKEN,
    sessionHours: process.env.SESSION_HOURS || 12,
    // No subrequest cap here — Node has no such limit.
    maxSubrequests: Infinity,
  },
});

function toWebRequest(req) {
  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function writeResponse(req, nodeRes, response) {
  const headers = Object.fromEntries(response.headers);
  nodeRes.writeHead(response.status, headers);
  if (!response.body) return nodeRes.end();
  try {
    Readable.fromWeb(response.body).on('error', () => {
      try { nodeRes.destroy(); } catch {}
    }).pipe(nodeRes);
  } catch {
    nodeRes.end();
  }
}

const server = http.createServer(async (req, nodeRes) => {
  try {
    const response = await app(toWebRequest(req));
    await writeResponse(req, nodeRes, response);
  } catch (e) {
    nodeRes.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    nodeRes.end(String(e?.message || e));
  }
});

server.listen(PORT, () => {
  console.log(`myDav listening on http://0.0.0.0:${PORT}`);
});
