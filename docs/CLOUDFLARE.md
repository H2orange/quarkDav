# 部署到 Cloudflare Workers

同一份业务代码，两个运行时。Node 入口（`src/server.mjs`）跑在 WorkBuddy / VPS，
Workers 入口（`src/worker.mjs`）跑在 Cloudflare 全球边缘。两者共用 `src/app.mjs`，
所以修 bug 只需改一处。

```
src/
  app.mjs        业务逻辑（路由 / 鉴权 / WebDAV 挂载）—— 运行时无关
  webdav.mjs     WebDAV 协议实现 —— 只依赖 Web 标准 Request/Response
  quarkTv.mjs    夸克 TV 接口客户端 —— 只依赖 fetch
  cryptoX.mjs    MD5 / SHA-256 / PBKDF2 / HMAC —— 只依赖 Web Crypto
  store.mjs      状态存储抽象：文件系统 或 Workers KV
  consoleHtml.mjs  由 public/login.html 编译而来（npm run build:html）
  server.mjs     Node 入口（薄壳）
  worker.mjs     Workers 入口（薄壳）
```

## 为 Free 计划做的三个妥协

| Cloudflare 限制 | Workers Free | Workers Paid | 本项目对应配置 |
|---|---|---|---|
| 每请求 CPU | 10 ms | 30 秒 | PBKDF2 轮数降到 20k（`PBKDF2_ITERATIONS`） |
| 每请求子请求 | 50 次 | 10,000 次 | PROPFIND 预算 24 次（`MAX_SUBREQUESTS`） |
| 请求数 | 10 万/天 | 1000 万/月 | 个人使用绰绰有余 |
| KV 写入 | 1000/天 | 100 万/月 | 只在登录 / 换密钥时写 |
| 内存 | 128 MB | 128 MB | 目录缓存上限 200 条 |

因此 Cloudflare 版固定 **302 直连模式**：代理模式下一条播放请求要占用边缘连接几十分钟，
容易被中断；302 让客户端自己去夸克 CDN 取流，服务端只付 API 调用。

## 部署方式 A：GitHub Actions（推荐）

仓库已自带 `.github/workflows/deploy-cloudflare.yml`。**KV 命名空间由 workflow 自动创建
（按标题 `MYDAV_KV` 查找，找不到就新建）**，所以你要做的只有填两个密钥。

### 0. 准备两个密钥值

**① Cloudflare API Token** —— https://dash.cloudflare.com/profile/api-tokens
→ Create Custom Token，按下面勾选（用模板会漏权限）：

| 范围 | 资源 | 权限 | 用途 |
|---|---|---|---|
| 账户 | 账户 API 令牌之外的全部账户资源 | Workers KV 存储：**读取** + **编辑** | workflow 查找/创建 KV 命名空间并灌入登录态 |
| 账户 | 同上 | Workers 脚本：**编辑** | 上传 Worker |
| 区域 | 你的域名所在区域（或全部区域） | Workers 路由：**编辑** | 只有要绑自定义域名时才需要 |

Token 只在创建时显示一次，复制后立刻离开页面就找不回来了。

**② Account ID** —— Cloudflare 控制台右侧栏直接显示，一串 32 位十六进制字符。

### 1. 填进 GitHub

Settings → Secrets and variables → Actions：

| 类型 | Name | Secret / Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | 上面的 Token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 上面的 Account ID |
| Secret | `QUARK_STATE_JSON` | *可选*，见下方说明 |
| Secret | `WEBDAV_USER` / `WEBDAV_PASS` | *可选*，见下方说明 |
| Variable | `CF_CUSTOM_DOMAIN` | *可选*，例如 `dav.example.com` |

三个可选项：

- **`QUARK_STATE_JSON`** —— 不填也能用（部署后扫码登录）。填了可以省一次扫码：
  把本机 `data/token.json` 的内容整段粘进去，或在 WorkBuddy 版页面上点「导出备份」取 JSON。
- **`CF_CUSTOM_DOMAIN`** —— 填了之后**每次部署都会自动绑这个域名**（DNS 记录和证书由 Cloudflare
  自动创建，不用手动操作）。必须存在仓库 **Variable** 里：每次 CI 都从仓库重新生成
  `wrangler.toml`，只有变量里的域名才不会被下一次部署抹掉 —— 手动运行时填的入口只对那一次生效。
- **`WEBDAV_USER` / `WEBDAV_PASS`** —— 不填的话会用 `wrangler.toml` 里的 `admin/admin` 默认值。
  **仓库是公开的，强烈建议改掉。**

### 2. 触发部署

Actions 标签页 → Deploy to Cloudflare Workers → Run workflow。运行结束在 Job Summary 里会给出访问地址。

之后**推到 `main` 且改动涉及 `src/`、`public/login.html`、`wrangler.toml` 等**会自动重新部署。

### 3. 首次使用

1. 打开 `https://你的域名/`，设置管理员密码（CF 版是独立的 KV，不继承 WorkBuddy 版的密码）。
2. 扫码登录夸克；页面上的「导入备份」也能直接粘贴旧版的 JSON。
3. 「一键复制挂载信息」，把地址填进播放器。

> 与 WorkBuddy 版的区别：两者**数据不互通**——CF 版读写独立的 Cloudflare KV，
> 需要各自设置管理员密码、各自扫码一次。

## 部署方式 B：本机 wrangler CLI

> 以下步骤在你本机执行：wrangler 需要一次浏览器 OAuth 授权，无法通过代理完成。

1. **登录 Cloudflare 账号**

   ```bash
   npx wrangler login
   ```

2. **创建 KV 命名空间**

   ```bash
   npx wrangler kv namespace create MYDAV_KV
   ```

   把输出的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]`（`id` 和 `preview_id` 填同一个）。

3. **部署**

   ```bash
   npm ci
   npm run build:html     # 改动过 public/login.html 就要重跑
   npx wrangler deploy
   ```

4. **手动写登录态（可选，省一次扫码）**

   ```bash
   npx wrangler kv key put --binding=MYDAV_KV state < data/token.json
   ```

   > 键名是 `state`，不是 `STATE`——`src/store.mjs` 里就是这么定义的。

5. **绑定自定义域名**
   Cloudflare 控制台 → Workers & Pages → mydav → Settings → Domains & Routes → Add。
   DNS 记录由 Cloudflare 自动创建，证书也会自动签发。

   > 域名必须是**橙色云（Proxied）**。灰色 DNS Only 不会触发 Worker。

## 改代码后

用 Actions 部署的话不需要做任何事 —— 推到 `main` 会自动跑。

本机方式：

```bash
npm run build:html        # 只有改了 public/login.html 才需要
npx wrangler deploy       # CF 版
```

业务逻辑（`app.mjs` / `webdav.mjs` / `quarkTv.mjs`）改动只需一次 `wrangler deploy`。

## 已知边界

- **国内直连不计入 SLA**：Workers 自定义域名必须走 CF 橙色云代理，CF 在中国大陆没有节点，
  晚高峰延迟与丢包取决于运营商。建议：家里的软路由/旁路由把该域名走代理，
  电视盒子等无法代理的设备继续使用 WorkBuddy 托管版。
- **只读**：TV 端 API 不支持写入，`PUT` / `MOVE` / `DELETE` 一律 405，与 Node 版一致。
- **不要启用 proxy 模式**：见上文 CPU 与流式连接的说明。
