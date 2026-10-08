// Cloudflare Workers entry point.
//
// The whole Cloudflare story is contained in this file + wrangler.toml:
//   * storage moves from ./data to a KV namespace bound as MYDAV_KV
//   * public/login.html is compiled into src/consoleHtml.mjs, so neither
//     runtime needs the filesystem
//   * PBKDF2 iterations drop to 20k (Free plan allows ~10ms CPU per request)
//   * each PROPFIND gets a hard subrequest budget (Free plan caps at 50)
import { createApp } from './app.mjs';
import { createKvStore } from './store.mjs';
import { LOGIN_HTML } from './consoleHtml.mjs';

// Compiled in at build time (see `npm run build:html`) rather than served from
// the [assets] binding: Workers bundles must not touch the filesystem, and this
// keeps the two deployments byte-identical.
const readAsset = async () =>
  new Response(LOGIN_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

export default {
  async fetch(request, env) {
    const store = createKvStore(env.MYDAV_KV);

    const app = createApp({
      store,
      readAsset,
      opts: {
        // 302 to the CDN: proxying video through an edge request risks being
        // cut off mid-playback, and costs real egress.
        mode: env.DAV_MODE || 'redirect',
        pbkdf2Iterations: Number(env.PBKDF2_ITERATIONS) || 20000,
        webdavUser: env.WEBDAV_USER || 'admin',
        webdavPass: env.WEBDAV_PASS || 'admin',
        webdavToken: env.WEBDAV_TOKEN,
        sessionHours: Number(env.SESSION_HOURS) || 12,
        // Leave headroom below the 50-subrequest cap: a path walk itself costs
        // one list call per level, so browsing must not eat the whole budget.
        maxSubrequests: Number(env.MAX_SUBREQUESTS) || 24,
      },
    });

    return app(request);
  },
};
