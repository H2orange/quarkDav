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

## 部署步骤

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
   npm install
   npm run build:html     # 改动过 public/login.html 就要重跑
   npx wrangler deploy
   ```

4. **绑定自定义域名**
   Cloudflare 控制台 → Workers & Pages → mydav → Settings → Domains & Routes → Add。
   DNS 记录由 Cloudflare 自动创建，证书也会自动签发。

   > 域名必须是**橙色云（Proxied）**。灰色 DNS Only 不会触发 Worker。

## 首次使用

1. 打开 `https://你的域名/`，设置管理员密码。
2. 扫码登录夸克 → 「导入备份」按钮也可直接粘贴 WorkBuddy 版导出的 JSON，省一次扫码：

   ```bash
   # 在 CF 版页面用「导入备份」粘贴；或用命令行写入 KV
   npx wrangler kv key put --binding=MYDAV_KV STATE < data/token.json
   ```

3. 「一键复制挂载信息」，把地址填进播放器。

## 改代码后

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
