// Runtime-neutral crypto helpers.
//
// Why it exists: Node has node:crypto, Cloudflare Workers does not (its
// nodejs_compat polyfill is incomplete and its Web Crypto has no MD5). Rather
// than fork the business logic per runtime, we use only primitives available in
// BOTH: Web Crypto (Node >=19 and Workers both expose globalThis.crypto.subtle)
// plus a tiny dependency-free MD5 (Web Crypto has no MD5 at all).
//
// Everything here therefore runs unchanged on Node and on Workers. Nothing is
// imported from 'node:*'.
const enc = new TextEncoder();

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomHex(byteLen = 16) {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

// ------------------------------------------------------------------- MD5 ----
// Needed by the Quark TV signature (req_id = md5(deviceID + timestamp)).
// Standard implementation; verified against Node's crypto with a test script.
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
);
const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

export function md5Hex(str) {
  const src = enc.encode(String(str));
  const len = src.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(src);
  buf[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    const m = new Int32Array(16);
    for (let j = 0; j < 16; j++) m[j] = dv.getInt32(off + j * 4, true);
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = F + A + MD5_K[i] + m[g];
      A = D; D = C; C = B;
      B = (B + rotl(F >>> 0, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  return [a0, b0, c0, d0]
    .map((w) => bytesToHex(new Uint8Array(new Uint32Array([w]).buffer)))
    .join('');
}

// -------------------------------------------------------------- SHA-256 ----
export async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(String(str)));
  return bytesToHex(new Uint8Array(d));
}

// --------------------------------------------------------------- PBKDF2 ----
// ADMIN session-free login runs this ONCE per login request. Cloudflare Free
// allows only 10ms CPU per request, so the Workers deployment uses far fewer
// iterations than Node — see PBKDF2_ITERATIONS in each entry point.
export async function pbkdf2Hash(pw, saltHex, iterations) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: Number(iterations) || 120000 },
    key,
    256
  );
  return { salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(bits)) };
}

// Constant-length compare without leaking where the first difference is.
export function safeEqual(aHex, bHex) {
  const a = String(aHex || '');
  const b = String(bHex || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ----------------------------------------------------------------- HMAC ----
// The key is the raw secret STRING encoded as UTF-8 — identical semantics to
// Node's createHmac('sha256', secret).update(msg).
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSign(secret, msg) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(msg)));
  return bytesToHex(new Uint8Array(sig));
}

export async function hmacEq(secret, msg, sigHex) {
  const want = await hmacSign(secret, msg);
  return safeEqual(want, String(sigHex || ''));
}
