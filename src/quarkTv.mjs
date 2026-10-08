// QuarkTV driver — ported 1:1 from Alist's drivers/quark_uc_tv (Quark netdisk variant).
// Uses the TV-end API which is the only path that currently returns playable video streams.
// MD5/SHA-256 come from our runtime-neutral module: Workers has no MD5 in Web
// Crypto, and relying on node:crypto would lock us out of Cloudflare. See
// src/cryptoX.mjs.
import { md5Hex, sha256Hex, randomHex } from './cryptoX.mjs';

// --- Constants copied from Alist quark_uc_tv/meta.go (Quark variant) ---
const CONF = {
  api: 'https://open-api-drive.quark.cn',
  clientID: 'd3194e61504e493eb6222857bccfed94',
  signKey: 'kw2dvtd7p4t3pjl2d9ed9yc8yej8kw2d',
  appVer: '1.5.6',
  channel: 'CP',
  codeApi: 'http://api.extscreen.com/quarkdrive',
};

const DEVICE = {
  deviceBrand: 'Xiaomi',
  platform: 'tv',
  deviceName: 'M2004J7AC',
  deviceModel: 'M2004J7AC',
  buildDevice: 'M2004J7AC',
  buildProduct: 'M2004J7AC',
  deviceGpu: 'Adreno (TM) 550',
  activityRect: '{}',
  userAgent:
    'Mozilla/5.0 (Linux; U; Android 13; zh-cn; M2004J7AC Build/UKQ1.231108.001) AppleWebKit/533.1 (KHTML, like Gecko) Mobile Safari/533.1',
};

export class QuarkTV {
  constructor(state = {}) {
    // A stable random device id: no MD5 needed here, and any 32-hex id works.
    this.deviceID = state.deviceID || randomHex(16);
    this.accessToken = state.accessToken || '';
    this.refreshToken = state.refreshToken || '';
    this.queryToken = state.queryToken || '';
  }

  toState() {
    return {
      deviceID: this.deviceID,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      queryToken: this.queryToken,
    };
  }

  // method + "&" + pathname + "&" + timestamp + "&" + signKey  -> sha256 hex
  async _sign(method, pathname) {
    const ts = String(Date.now());
    const reqID = md5Hex(this.deviceID + ts);
    const token = await sha256Hex(`${method}&${pathname}&${ts}&${CONF.signKey}`);
    return { ts, reqID, token };
  }

  _commonQuery(extra = {}) {
    return {
      req_id: '',
      access_token: this.accessToken,
      app_ver: CONF.appVer,
      device_id: this.deviceID,
      device_brand: DEVICE.deviceBrand,
      platform: DEVICE.platform,
      device_name: DEVICE.deviceName,
      device_model: DEVICE.deviceModel,
      build_device: DEVICE.buildDevice,
      build_product: DEVICE.buildProduct,
      device_gpu: DEVICE.deviceGpu,
      activity_rect: DEVICE.activityRect,
      channel: CONF.channel,
      ...extra,
    };
  }

  async _request(method, pathname, params = {}, isRetry = false) {
    const { ts, reqID, token } = await this._sign(method, pathname);
    const url = new URL(CONF.api + pathname);
    const q = this._commonQuery(params);
    q.req_id = reqID;
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);

    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': DEVICE.userAgent,
        'x-pan-tm': ts,
        'x-pan-token': token,
        'x-pan-client-id': CONF.clientID,
      },
    });
    const json = await res.json();

    // Quark's success envelope is {status:0, errno:0}. Missing errno means 0.
    const errno = json.errno ?? 0;
    // token expired -> refresh once and retry
    if (json.status === -1 && errno === 10001) {
      if (isRetry) throw new Error('token expired and refresh failed');
      await this._refreshByToken();
      return this._request(method, pathname, params, true);
    }
    if (json.status >= 400 || errno !== 0) {
      throw new Error(json.error_info || `quark error status=${json.status} errno=${errno}`);
    }
    return json;
  }

  async _tokenBody(extra) {
    const { reqID } = await this._sign('POST', '/token');
    return {
      req_id: reqID,
      app_ver: CONF.appVer,
      device_id: this.deviceID,
      device_brand: DEVICE.deviceBrand,
      platform: DEVICE.platform,
      device_name: DEVICE.deviceName,
      device_model: DEVICE.deviceModel,
      build_device: DEVICE.buildDevice,
      build_product: DEVICE.buildProduct,
      device_gpu: DEVICE.deviceGpu,
      activity_rect: DEVICE.activityRect,
      channel: CONF.channel,
      ...extra,
    };
  }

  async _exchangeToken(rawBody) {
    // extscreen requires the full device-field body; callers pass only the
    // auth payload ({code} / {refresh_token}) — merge the common fields here.
    const body = await this._tokenBody(rawBody);
    const res = await fetch(CONF.codeApi + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': DEVICE.userAgent },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.code !== 200) throw new Error(json.message || 'token exchange failed');
    // extscreen returns HTTP 200 with the quark envelope inside data:
    // {status:-1, errno:11004, error_info:"授权码Code无效", ...}
    const d = json.data || {};
    if (d.status === -1 || d.errno) throw new Error(d.error_info || `token exchange errno=${d.errno}`);
    if (!d.refresh_token) throw new Error('refresh token empty');
    this.accessToken = d.access_token;
    this.refreshToken = d.refresh_token;
  }

  async _refreshByToken() {
    if (!this.refreshToken) throw new Error('no refresh token');
    await this._exchangeToken({ refresh_token: this.refreshToken });
  }

  // --- OAuth QR login (Quark App scans) ---
  async getLoginCode() {
    const json = await this._request('GET', '/oauth/authorize', {
      auth_type: 'code',
      client_id: CONF.clientID,
      scope: 'netdisk',
      qrcode: '1',
      qr_width: '460',
      qr_height: '460',
    });
    this.queryToken = json.query_token || '';
    return { qr: json.qr_data, queryToken: this.queryToken };
  }

  async getCode() {
    const json = await this._request('GET', '/oauth/code', {
      client_id: CONF.clientID,
      scope: 'netdisk',
      query_token: this.queryToken,
    });
    return json.code;
  }

  async loginWithCode(code) {
    await this._exchangeToken({ code });
  }

  async isLogin() {
    await this._request('GET', '/user', { method: 'user_info' });
    return true;
  }

  // --- File operations (List + Download only; TV API has no write) ---
  async list(parentFid = '0') {
    const out = [];
    let page = 0;
    const pageSize = 100;
    for (;;) {
      const json = await this._request('GET', '/file', {
        method: 'list',
        parent_fid: parentFid,
        order_by: '3',
        desc: '1',
        category: '',
        source: '',
        ex_source: '',
        list_all: '0',
        page_size: String(pageSize),
        page_index: String(page),
      });
      const files = json.data?.files || [];
      out.push(...files);
      const total = json.data?.total_count || 0;
      if (page * pageSize >= total || files.length === 0) break;
      page++;
    }
    return out;
  }

  async getLink(fid) {
    const json = await this._request('GET', '/file', {
      method: 'download',
      group_by: 'source',
      fid,
      resolution: 'low,normal,high,super,2k,4k',
      support: 'dolby_vision',
    });
    return json.data?.download_url;
  }
}
