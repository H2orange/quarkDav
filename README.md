# myDav

把**夸克网盘**挂载成标准 **WebDAV** 服务，让 Infuse / VidHub / nPlayer / 网易爆米花 等播放器直接访问网盘里的影视资源。

基于夸克 **TV 端 API**（QuarkTV，走 OAuth 扫码登录），纯 Node.js 实现，零第三方依赖。

两种部署方式：[WorkBuddy 托管](#方式一workbuddy-托管推荐)（Node 服务，**国内推荐**）或 [Cloudflare Workers](#方式二cloudflare-workers)（异地备用）。两者共用同一份核心逻辑。

> 移植自 [Alist](https://github.com/AlistGo/alist) 的 `quark_uc_tv` 驱动，签名算法、端点、请求头与其保持一致。

## 特性

- **夸克 App 扫码登录**，token 自动续期，无需填 cookie
- **标准 WebDAV**：`OPTIONS` / `PROPFIND` / `GET` / `HEAD`，支持 `Range` 拖拽
- **两种播放模式**
  - `redirect`（默认）：文件 GET 返回 `302` 直连夸克 CDN，**服务器零视频流量**
  - `proxy`：由服务器中转视频流（`200/206`），兼容不跟随跳转的客户端（如网易爆米花扫描器）
- **管理员口令保护**：PBKDF2-SHA256 + 签名会话，所有接口默认拒绝匿名访问
- **挂载密钥**：内嵌在 URL 路径中（绕开反向代理剥离 `Authorization` 的问题），支持手动设置 / 随机生成 / 一键轮换
- **网页文件浏览器**：登录后可直接在网页浏览网盘目录、试播视频
- 零 npm 依赖（只用 Node 内置模块）

## 快速开始

```bash
npm start
# 打开 http://localhost:8080
```

1. 首次访问设置**管理员密码**（≥8 位）
2. 点「获取登录二维码」，用**夸克 App** 扫码并确认
3. 页面会显示挂载地址，形如 `http://localhost:8080/dav/<密钥>`

## 在播放器中挂载

| 字段 | 值 |
|---|---|
| 地址 / URL | `https://<你的域名>/dav/<挂载密钥>` |
| 端口 | 443（https 默认） |
| 账号 | `admin`（任意填，由路径密钥鉴权） |
| 密码 | `admin`（任意填） |

管理台有「一键复制挂载信息」按钮，点一下即可复制上面这些字段。

> **为什么密钥在路径里？** 托管平台的反向代理会剥离 `Authorization` 请求头，标准 Basic 认证无法穿透。因此改用 URL 路径段做鉴权（路径不会被剥离）。自托管且无反代剥离时，Basic 认证（`admin` / `WEBDAV_PASS`）同样可用作回退。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `DAV_MODE` | `redirect` | `redirect` = 302 直连夸克 CDN（省流量）；`proxy` = 服务器中转（兼容性强） |
| `WEBDAV_TOKEN` | 自动生成 | 挂载密钥，覆盖磁盘上的配置 |
| `WEBDAV_USER` | `admin` | Basic 认证用户名（回退用） |
| `WEBDAV_PASS` | `admin` | Basic 认证密码（回退用） |
| `SESSION_HOURS` | `12` | 管理台会话有效期（小时） |

## 部署

两种方式共用一份核心逻辑 `src/app.mjs`，只是入口不同：

| | **WorkBuddy 托管**（Node） | **Cloudflare Workers** |
|---|---|---|
| 入口 | `src/server.mjs` | `src/worker.mjs` |
| 状态存放 | `data/` 下的文件 | Workers KV |
| 视频路径 | `redirect` 302 直连 CDN（也可切 `proxy` 中转） | 固定 302 |
| 国内播放 | 流畅 | **实测明显卡顿** |
| 适合 | 日常主力 | 异地 / 境外备用 |

> **选哪个：** 国内直接用 WorkBuddy 托管。CF 版链路要绕境外边缘节点（且自定义域名必须橙色云代理），
> 播放卡顿很明显 —— 当备份地址或人在境外时更合适。

### 方式一：WorkBuddy 托管（推荐）

在 WorkBuddy 里打开本项目，说一句「部署」即可 —— 平台会执行 `npm start`（`node src/server.mjs`），
并生成一个 `https://<应用名>.app.workbuddy.host` 的地址。以后更新代码再说一次「部署」就会原地更新同一个应用。

服务端不需要任何改动：代码已监听 `process.env.PORT` 并绑定 `0.0.0.0`。

部署后：打开地址 → 设置管理员密码 → 扫码登录夸克 → 「一键复制挂载信息」→ 填进播放器。

> `data/token.json`（夸克登录态）会随部署包一起上传，所以**重新部署后不用重新扫码**。
> 它被 `.gitignore` 排除，不会进 GitHub。

### 方式二：Cloudflare Workers

用 GitHub Actions 部署，**KV 命名空间由 workflow 自动创建**，你只需准备 Cloudflare 侧的两个值。

**① 拿两个值**

- **API Token** — <https://dash.cloudflare.com/profile/api-tokens> → Create Custom Token：
  Workers 脚本**编辑** + Workers KV 存储**读取/编辑** +（绑域名时）Workers 路由**编辑**。
  别用官方模板，它缺 KV 权限。
- **Account ID** — 控制台右侧栏，32 位十六进制。

**② 填进 GitHub**（Settings → Secrets and variables → Actions）

| 类型 | Name | 说明 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | 上面的 Token（**必填**）|
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 上面的 Account ID（**必填**）|
| Variable | `CF_CUSTOM_DOMAIN` | 如 `dav.example.com`，自动绑域名并签发证书 |
| Secret | `WEBDAV_USER` / `WEBDAV_PASS` | 建议改掉默认的 `admin/admin`（仓库是公开的）|
| Secret | `QUARK_STATE_JSON` | 导入现有登录态，省一次扫码 |

> `CF_CUSTOM_DOMAIN` 必须是 **Variable** 才能持久化 —— CI 每次重新生成 `wrangler.toml`，
> 只填一次性 dispatch 输入会被下次部署抹掉。

**③ 触发**：Actions → **Deploy to Cloudflare Workers** → Run workflow，Job Summary 里给出访问地址。

不想用 Actions 也可以本机跑（需要一次浏览器 OAuth）：

```bash
npx wrangler login
npx wrangler kv namespace create MYDAV_KV   # id 填进 wrangler.toml
npm ci && npm run build:html && npx wrangler deploy
```

**两个版本不互通，注意这三条**

- **管理员密码不能搬**：PBKDF2 轮数不同（Node 120k / CF 20k），哈希不一样，复制过去只会报密码错误 —— 在 CF 页上重设一个。
- **挂载密钥可以沿用**：它只是随机字符串，填同一个串，播放器换域名即可，不用重新挂载媒体库。
- **`QUARK_STATE_JSON` 要取自运行中的实例「导出备份」**，别用本机 `data/token.json`，那是过期快照。

资源限制：Workers Free 每请求只有 10ms CPU、50 次子请求，所以 CF 版固定 302 且 PROPFIND 有子请求预算。
完整说明见 [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)。

## 项目结构

同一套业务逻辑配两个入口，Node 与 Workers **共用 `src/app.mjs`**，修 bug 只需改一处：

```
src/
  app.mjs           业务核心（路由 / 鉴权 / WebDAV）—— 运行时无关，输入输出均为标准 Request/Response
  quarkTv.mjs       夸克 TV 端客户端：扫码登录、列目录、取播放直链（含签名算法）
  webdav.mjs        只读 WebDAV 协议实现：OPTIONS / PROPFIND / GET / HEAD
  store.mjs         状态存储抽象：文件系统（Node）或 Workers KV
  cryptoX.mjs       MD5 / SHA-256 / PBKDF2 / HMAC —— 只依赖 Web Crypto
  consoleHtml.mjs   由 public/login.html 编译而来（npm run build:html）
  server.mjs        Node 入口（薄壳，86 行）
  worker.mjs        Cloudflare Workers 入口（薄壳，45 行）
scripts/
  cf-bootstrap.mjs  CI 辅助：解析/创建 KV 命名空间、回填 wrangler.toml、灌登录态
  build-html.mjs    把 public/login.html 编译成 JS 字符串模块
public/
  login.html        管理台前端：管理员登录、扫码、文件浏览、挂载信息
```

> **两个薄壳都不含业务逻辑**：`server.mjs` 只做 `IncomingMessage` ↔ `Request` 的转换，
> `worker.mjs` 只做 `export default { fetch }` 的适配。因此 Node 版与 CF 版的行为始终一致。

## 运行时数据（不入库）

服务会在 `data/` 下写入以下敏感文件，已被 `.gitignore` 排除：

| 文件 | 内容 |
|---|---|
| `data/token.json` | 夸克 `accessToken` / `refreshToken` / `deviceID` |
| `data/admin.json` | 管理员口令（PBKDF2 哈希 + 盐） |
| `data/admin_secret.txt` | 会话签名密钥 |
| `data/webdav_pass.txt` | 当前挂载密钥 |

## 已知限制

- **只读**：仅支持列目录与播放。QuarkTV 接口本身不支持上传 / 新建 / 删除。
- **`proxy` 模式消耗服务器带宽**：视频流经服务器中转，看一部 1.5GB 的电影就消耗约 1.5GB 入 + 1.5GB 出。用 `redirect` 模式可避免。
- **Windows 资源管理器挂载不适用**：系统自带「映射网络驱动器」不跟随 `302`，请用 Infuse / VidHub / nPlayer 等播放器。
- 夸克私有接口有**频率限制**，大量调用可能触发风控。

## 免责声明

本项目仅供个人学习与研究使用，使用的夸克接口均为其客户端公开调用的私有接口。请遵守相关服务条款，不要用于商业用途或大规模分发。因使用本项目产生的任何后果由使用者自行承担。

## License

MIT
