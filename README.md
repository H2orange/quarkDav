# myDav

把**夸克网盘**挂载成标准 **WebDAV** 服务，让 Infuse / VidHub / nPlayer / 网易爆米花 等播放器直接访问网盘里的影视资源。

基于夸克 **TV 端 API**（QuarkTV，走 OAuth 扫码登录），纯 Node.js 实现，零第三方依赖。

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

## 项目结构

```
src/
  quarkTv.mjs    夸克 TV 端客户端：扫码登录、列目录、取播放直链（含签名算法）
  webdav.mjs     只读 WebDAV 协议实现：OPTIONS / PROPFIND / GET / HEAD
  server.mjs     HTTP 服务：管理台接口、鉴权、静态页、路由
public/
  login.html     管理台前端：管理员登录、扫码、文件浏览、挂载信息
```

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
