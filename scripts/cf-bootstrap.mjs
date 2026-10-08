// Cloudflare bootstrap helpers — run inside CI so the human only has to supply
// two GitHub Secrets (an API token and an account id).
//
// Sub-commands (all read CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from env):
//
//   kv-id       Resolve-or-create the KV namespace titled $KV_TITLE (default
//               "MYDAV_KV") and print ONLY its id on stdout.
//   patch       Rewrite wrangler.toml: fill in the KV id, optionally append a
//               [[routes]] block for a custom domain, and optionally override
//               the WebDAV basic-auth credentials from $WEBDAV_USER/$WEBDAV_PASS.
//   put-state   Push the Quark login state ($QUARK_STATE_JSON) into KV key
//               `state`. Skipped when the key already exists (the Worker
//               refreshes that token at runtime — clobbering it would break an
//               already-working login) unless $FORCE_SEED=true.
//   info        Print the resulting *.workers.dev URL on stdout.
//
// Anything human-facing goes to stderr so `KV_ID=$(node cf-bootstrap.mjs kv-id)`
// stays clean.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'wrangler.toml');
const API = 'https://api.cloudflare.com/client/v4';

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};
const log = (msg) => console.error(msg);

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : String(v);
}

function credentials() {
  const token = env('CLOUDFLARE_API_TOKEN');
  const account = env('CLOUDFLARE_ACCOUNT_ID');
  if (!token) fail('缺少环境变量 CLOUDFLARE_API_TOKEN');
  if (!account) fail('缺少环境变量 CLOUDFLARE_ACCOUNT_ID');
  return { token, account };
}

async function cf(method, pathname, { body, raw, contentType } = {}) {
  const { token, account } = credentials();
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers['Content-Type'] = contentType || 'text/plain';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API}/accounts/${account}${pathname}`, {
    method,
    headers,
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { success: res.ok, result: text };
  }

  const reasons = (json && json.errors ? json.errors : [])
    .map((e) => `${e.code} ${e.message}`)
    .join('; ');

  if (!res.ok) {
    fail(`Cloudflare API ${method} ${pathname} -> HTTP ${res.status} ${reasons || text.slice(0, 300)}`);
  }
  if (json && json.success === false) {
    fail(`Cloudflare API ${method} ${pathname} -> ${reasons || '未知错误'}`);
  }
  return json;
}

// ------------------------------------------------------------------- kv-id
async function resolveNamespaceId(title) {
  for (let page = 1; ; page += 1) {
    const j = await cf('GET', `/storage/kv/namespaces?page=${page}&per_page=1000`);
    const hit = (j.result || []).find((n) => n.title === title);
    if (hit) return { id: hit.id, created: false };
    const info = j.result_info || {};
    if (page >= (info.total_pages || 1)) break;
  }
  const created = await cf('POST', '/storage/kv/namespaces', { body: { title } });
  return { id: created.result.id, created: true };
}

async function cmdKvId() {
  const title = env('KV_TITLE', 'MYDAV_KV');
  const { id, created } = await resolveNamespaceId(title);
  log(created ? `已创建 KV 命名空间 ${title} -> ${id}` : `复用已有 KV 命名空间 ${title} -> ${id}`);
  process.stdout.write(`${id}\n`);
}

// ------------------------------------------------------------------ patch
// Replace the id / preview_id inside the [[kv_namespaces]] block only — a naive
// global regex would happily rewrite unrelated `id =` keys added later.
function setKvId(src, kvId) {
  const marker = '[[kv_namespaces]]';
  // Anchor to the START OF A LINE. A plain indexOf() would match the mention of
  // this same token inside the header comment and write the id into prose.
  const at = src.search(/^\[\[kv_namespaces\]\]/m);
  if (at === -1) {
    return `${src.trimEnd()}\n\n${marker}\nbinding = "MYDAV_KV"\nid = "${kvId}"\npreview_id = "${kvId}"\n`;
  }
  const head = src.slice(0, at);
  const rest = src.slice(at + marker.length);
  const next = rest.indexOf('\n[');
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  const tail = next === -1 ? '' : rest.slice(next + 1);

  let block = body;
  const setKey = (text, key, value) =>
    new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, 'm').test(text)
      ? text.replace(new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, 'm'), `$1"${value}"`)
      : `${text.trimEnd()}\n${key} = "${value}"\n`;
  block = setKey(block, 'id', kvId);
  block = setKey(block, 'preview_id', kvId);

  return head + marker + block + tail;
}

function setVar(src, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, 'm');
  return re.test(src) ? src.replace(re, `$1"${value}"`) : `${src.trimEnd()}\n${key} = "${value}"\n`;
}

function setRoute(src, domain) {
  // A [[routes]] entry with custom_domain = true takes a bare HOSTNAME — no
  // "/*" suffix, which is only valid for zone routes. wrangler rejects the
  // wildcard form outright, so build the two patterns differently.
  if (src.includes(`pattern = "${domain}"`)) return src;
  return `${src.trimEnd()}\n\n[[routes]]\npattern = "${domain}"\ncustom_domain = true\n`;
}

function cmdPatch() {
  const kvId = env('KV_ID');
  if (!kvId) fail('缺少环境变量 KV_ID（应由上一步 kv-id 的产出传入）');

  let src = fs.readFileSync(CONFIG_PATH, 'utf8');
  src = setKvId(src, kvId);

  const domain = env('CUSTOM_DOMAIN').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (domain) {
    src = setRoute(src, domain);
    log(`已绑定自定义域名 ${domain}`);
  }

  const user = env('WEBDAV_USER');
  const pass = env('WEBDAV_PASS');
  if (user) src = setVar(src, 'WEBDAV_USER', user);
  if (pass) src = setVar(src, 'WEBDAV_PASS', pass);
  if (user || pass) log('已覆盖 WebDAV Basic 认证凭据（不再使用默认的 admin/admin）');

  fs.writeFileSync(CONFIG_PATH, src);
  log('wrangler.toml 已在本次 CI 运行中改写（不会提交回仓库）');
}

// -------------------------------------------------------------- put-state
async function cmdPutState() {
  const kvId = env('KV_ID');
  if (!kvId) fail('缺少环境变量 KV_ID');
  const raw = env('QUARK_STATE_JSON');
  if (!raw) {
    log('未配置 Secret QUARK_STATE_JSON，跳过导入。');
    log('  不导入也能正常工作 —— 部署后在页面扫码登录即可；');
    log('  配置它可以省掉这一步（从本机 data/token.json 或线上版「导出备份」里取值）。');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('QUARK_STATE_JSON 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object') fail('QUARK_STATE_JSON 必须是一个 JSON 对象');

  const force = env('FORCE_SEED') === 'true';
  if (!force) {
    const { token, account } = credentials();
    const probe = await fetch(
      `${API}/accounts/${account}/storage/kv/namespaces/${kvId}/values/state`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (probe.ok) {
      const existing = (await probe.text()).trim();
      if (existing) {
        log('KV 中已存在登录态，跳过导入（Worker 会在运行时刷新它，覆盖反而可能失效）。');
        log('如果你想强制覆盖，勾选工作流里的「强制覆盖现有登录态」。');
        return;
      }
    }
  }

  await cf('PUT', `/storage/kv/namespaces/${kvId}/values/state`, {
    raw: JSON.stringify(parsed),
    contentType: 'application/json',
  });
  log('已把夸克登录态写入 KV 键 state');
}

// ------------------------------------------------------------------ info
function workerName() {
  const src = fs.readFileSync(CONFIG_PATH, 'utf8');
  const m = src.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : 'mydav';
}

async function cmdInfo() {
  const j = await cf('GET', '/workers/subdomain');
  const sub = j.result && j.result.subdomain;
  if (!sub) fail('读不到 workers.dev 子域，请确认 API Token 具备 Workers Scripts 读取权限');
  process.stdout.write(`https://${workerName()}.${sub}.workers.dev\n`);
}

// ------------------------------------------------------------------ main
const cmd = process.argv[2];
const table = {
  'kv-id': cmdKvId,
  patch: cmdPatch,
  'put-state': cmdPutState,
  info: cmdInfo,
};

const fn = table[cmd];
if (!fn) {
  fail(`未知子命令 "${cmd}"。可用：${Object.keys(table).join(' | ')}`);
}
// Wrapped in Promise.resolve because some commands are synchronous.
Promise.resolve(fn()).catch((e) => fail(e && e.message ? e.message : String(e)));
