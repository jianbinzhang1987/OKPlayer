# FongMi Desktop 跨平台客户端

本目录实现一个可在 macOS 运行、兼容 FongMi/TVBox 播放源配置的点播客户端。

当前业务闭环：

```text
配置加载
  → 播放源能力识别与 Adapter 创建
  → 首页 / 分类 / 搜索
  → 视频详情与线路剧集
  → Direct / JSON API 播放地址解析
  → 失败时使用隔离浏览器嗅探媒体请求
  → ArtPlayer / 内置播放器优先播放，非 Web 兼容格式提示换源或外部播放器兜底
  → 播放进度、历史、收藏、配置和设置持久化
```

## 当前已实现

- Electron 43.2.0 + Vue 3 桌面界面，采用 macOS 风格侧边栏、内容首页、独立详情、收藏/历史、播放源中心和全窗口内置播放器；默认使用舒适阅读字号，并支持紧凑、标准、大、特大四档持久化字体设置；
- 本地与远程 JSON 配置加载、相对 URL 解析；
- `type=0` XML、`type=1` HTTP JSON 播放源；
- `type=3` JavaScript Spider；
- `type=3` Drpy 声明式规则与受控动态 `js:` MVP；
- 当前 FongMi `type=4` 及兼容 `type=6/8` T4 服务播放源；
- 统一 `SourceCapability`、`SourceAdapter` 与 `SourceAdapterFactory`；
- HTTP、JavaScript、Drpy、T4、Unsupported 五类 Adapter 统一调度；
- 统一错误模型、日志和超时处理；
- T4 远程/localhost、远程 ext、URL-safe Base64、长参数 POST、Header、健康检查和失败隔离；
- Drpy 声明式 Worker、CookieJar、HTML/JSON 规则、POST、筛选模板、字段继承、base64/hash、localStorage；
- Drpy 动态 `js:` Worker，支持预处理、推荐、分类、搜索、详情、对象二级动态 TABS/LISTS 和 lazy，以及同步 request/fetch/post、选择器宿主 RPC、fetch_params Header 继承和结果归一化；
- 动态规则默认阻断 localhost/内网/链路本地地址和 DNS 重绑定到内网，限制操作时长、网络请求次数、响应大小，并禁用任意 eval/Function/Wasm 动态生成；规则中的 `eval` 仅映射为安全宽松数据字面量解析；
- 固定上游提交的 5 个公开 Drpy 规则语法审计；8 个动态操作未发现已知宿主 API 缺口，2 个无网络 lazy 实际 Worker 执行通过；
- 公开 Drpy 在线回归：相声随身听首页、详情 50 个音频与 lazy 直链成功；03影院和可可影视当前分别受异常 DNS 与非标准 HTTP 850 限制；
- BrowserSniffer 独立 Session、隐藏窗口、权限拒绝、弹窗阻断、播放控件自动触发、子框架执行、重定向监听、广告排除和媒体候选排序；
- HLS、DASH、MP4 内容前缀二次验证，可过滤返回 HTML 的伪媒体地址；
- 常规解析失败后自动进入网页嗅探，支持取消、超时以及 Cookie/Header 回传；
- `fongmi-media://` 受控媒体协议，播放请求头仅保留在主进程，支持 HLS 清单及分片地址重写；
- MP4、WebM、音频优先使用原生 `<video>`，HLS 在 Electron 无原生支持时按需启用安装包内的固定版本 HLS.js 1.6.16 + MSE；ArtPlayer 以独立懒加载代码块打入 ASAR，不依赖 CDN；全窗口播放器支持上一集/下一集、右侧选集抽屉、播放中控制层自动隐藏、双击全屏、键盘控制、倍速、进度保存和断点续播；
- 真实夸克 4K MP4/HLS 优先在应用内 ArtPlayer 播放；非 Web 兼容格式不再单独实现高兼容播放器窗口，提示换线路、换来源或外部播放器兜底；
- 单源与多源搜索、取消旧搜索，并在界面展示各来源结果数量和失败状态；
- 首页、分类、详情、线路和剧集解析；
- Direct、URL Prefix、JSON API 播放解析；
- User-Agent、Referer、Cookie 等请求头传递；
- 外部播放器兜底入口仅在内置播放和自动恢复失败后显示，受保护 Header 不暴露给 Renderer；
- SQLite 配置、历史、收藏和设置；支持配置切换、重命名、删除，以及历史单条删除和清空；
- Electron 43.2.0 x64 与 arm64 `.app/.dmg` 测试打包，正式应用图标、660×400 DMG 安装界面、DMG 校验和、挂载内容和打包应用窗口验收均通过；
- 275 项自动化测试；核心修复 Electron E2E 13/13、CatVod 生命周期 E2E 14/14、数据库损坏恢复 E2E 5/5；并完成 Playwright 首页、详情、真实 HLS/夸克 4K 内置播放、播放源、历史、搜索、设置、最小窗口尺寸及打包应用启动验收；
- 应用层 TypeScript 类型检查；
- Mux HLS、DASH-IF MPD、Video.js MP4 三类公网媒体审计；
- BrowserSniffer 本地烟雾和公网解析页回归脚本采用结果文件强校验，避免仅凭 Electron 退出码误判。

## 当前待完成

统一待办和优先级以 [`docs/待完成事项与优先级.md`](docs/待完成事项与优先级.md) 为准。当前优先处理：

- 最新 x64 目录测试包已经重新生成；arm64 安装包和 Apple Silicon 实机仍待重新构建与验证；夸克、UC、百度、115、天翼和移动网盘真实扫码与破坏性凭据清除需在专用测试账号环境验收；
- 在真实六网盘环境验收登录、清除凭据、登录失效状态和播放恢复；
- 在普通 macOS GUI、Apple Silicon 和干净机器完成内置播放器、BrowserSniffer 与 CatVod 实机回归；
- 使用真实代理媒体验证 Range、拖动、动态端口和服务重启后的续播；
- 完成版本损坏、网络抖动、登录任务中断和数据库异常的故障注入；
- 网盘三级目录、分页、目录搜索、字幕和弹幕高级设置已通过本地真实 Fixture 与 Electron E2E；仍需真实第三方网盘大目录、真实 Provider 字幕弹幕样本，以及正式签名、公证、桌面应用自动更新和 Windows/Linux 实机闭环；
- 直播、EPG、时移、DLNA、短剧和漫画作为后续独立能力，不混入当前点播闭环。

## 明确不做或近期暂缓

- 不再开发 Python Spider/Sidecar 或新的 Spider 运行时；
- Android Dex/JAR Spider、Android Bridge 和批量替代实现暂不实施；
- 近期不扩大 Drpy、XYQ、XBPQ、CatOpen、Alist、T4 等规则兼容样本，不为单个失效站点持续补充专用加密、验证码或浏览器宿主能力；
- 现有已实现运行时继续保留，仅修复影响核心用户和安全性的明确缺陷。

## 发布校验与正式签名

测试发布物与正式发布采用两套校验门槛：

```bash
# 检查 Developer ID 与公证凭据；当前无证书环境会失败
npm run release:preflight

# 仅允许生成本地测试包
ALLOW_UNSIGNED=1 npm run release:preflight

# 构建 x64 与 arm64 DMG
npm run package:dmg:all

# 校验双架构、DMG 挂载结构、图标、Electron、HLS 本地代码块和 SHA-256
npm run release:verify

# 正式发布：必须具备证书、公证凭据并通过 Gatekeeper
npm run release:formal
```

`release:verify` 会生成：

- `release/SHA256SUMS.txt`；
- `artifacts/release-audit/release-report.json`；
- `artifacts/package-audit/report.json` 与打包应用截图。

正式公证支持以下任一凭据组合：

- `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`；
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；
- `APPLE_KEYCHAIN`、`APPLE_KEYCHAIN_PROFILE`。

构建配置已启用 Hardened Runtime，并提供 `build/entitlements.mac.plist` 与 `build/entitlements.mac.inherit.plist`。当前无签名测试包可用于本机验证，但 Gatekeeper 会拒绝其作为正式互联网分发包。

## 支持的播放源运行时

| runtime | 配置类型 | 当前状态 |
|---|---|---|
| `http` | type=0/1 | 可用 |
| `javascript` | type=3 且 API 为普通 Spider `.js` | 可用 |
| `drpy` | type=3，API 为 Drpy 引擎且 ext 为规则脚本 | 声明式与受控动态 `js:` MVP 可用 |
| `t4` | type=4/6/8 且 API 为 HTTP/HTTPS | 可用 |
| `appysv2` | type=3 `csp_AppYsV2` 或 type=11，API 地址位于 `ext` | 可用 |
| `xyq` | type=3 `csp_XYQ/csp_XYQHiker` 或 type=10 | 高频规则 MVP 可用，支持远程/内联规则、HTML/JSON、GET/POST 搜索、详情和剧集 |
| `xbpq` | type=3 `csp_XBPQ` 或 type=9 | 高频规则 MVP 可用，支持对象/远程规则、截取修饰、搜索、详情、线路和剧集 |
| `catopen` | type=14，API 为 CatOpen JS；或 `csp_CatOpen` + ext 脚本 URL | 独立 Node 子进程 MVP 可用，提供受控宿主 API 和代理能力 |
| `alist` | `csp_Alist` 或 type=13 | Alist v2/v3 MVP 可用，支持目录、搜索、目录密码、可选登录和文件直链 |
| `android-dex` | 其余具体 `csp_*`、Dex/JAR | 识别并明确降级 |
| `unknown` | 其他未识别类型 | 识别并禁用 |

设置页会展示每个站点的 `runtime`、`supported`、`capabilities` 和 `reason`；T4 站点可直接执行健康检查。

## 环境要求

- macOS；
- Node.js 22.12.0 或更高版本；
- mpv 或系统外部播放器可选，仅作为非 Web 兼容格式的最后兜底路径。

## 开发命令

```bash
cd /Users/adolf/Desktop/code/TV/mac
npm ci
npm run verify:electron
npm run typecheck
npm test
npm run build
npm run audit:drpy
npm run audit:drpy:dynamic
npm run audit:drpy:live
npm run audit:t4:live
npm run audit:media:public
npm run audit:config -- <配置URL或本地配置文件>
npm run smoke:embedded
npm run smoke:embedded:electron43
npm run smoke:sniffer
npm run regress:sniffer:public
npm run assets:build
npm run package:dmg
npm run package:dmg:arm64
npm run release:verify
npm run dev
```

## 命令行验证

```bash
npm run cli -- sites <配置URL或本地配置文件>
npm run cli -- search <配置> <siteKey> <关键词> [页码]
npm run cli -- detail <配置> <siteKey> <vodId>
npm run cli -- resolve <配置> <siteKey> <vodId> [线路序号] [剧集序号]
```

线路和剧集序号从 `0` 开始。

配置兼容审计支持文本、JSON、替代 Provider 注册表和批量排名：

```bash
npm run audit:config -- <配置URL或本地配置文件>
npm run audit:config -- <配置> --registry provider-replacements.json
npm run audit:config -- <配置> --json --output runtime-distribution.json

npm run audit:config:batch -- <配置1> <配置2> --top 30
npm run audit:config:batch -- --list config-list.txt --registry provider-replacements.json
npm run audit:config:batch -- --list config-list.txt --json --output compatibility-report.json
```

单配置报告会列出运行时分布、兼容率、已应用替代 Provider、Android-only 站点和其他不可用原因。批量报告会进一步按 `csp_*` 出现次数和覆盖配置数量形成迁移优先级排名；当输入是影视仓顶层 `urls` 时，会递归展开下级配置并独立记录失败线路。配置解析支持 BOM、注释、尾逗号和常见 JSON5 写法。注册表也可在应用“设置 → 替代 Provider 注册表”中导入；来源会持久化，应用启动时自动恢复，加载或清除后会立即重建当前播放源。注册表格式及验收要求见 `docs/PROVIDER_REPLACEMENTS.md`，在线配置首轮实测见 `docs/ONLINE_SOURCE_AUDIT_2026-07-26.md`。

## 核心目录

```text
mac/
├── src/
│   ├── core/
│   │   ├── source-adapter.ts
│   │   ├── source-adapter-factory.ts
│   │   ├── source-capability.ts
│   │   ├── provider-manager.ts
│   │   ├── provider-replacement-registry.ts
│   │   ├── compatibility-audit.ts
│   │   ├── compatibility-batch-audit.ts
│   │   ├── network-address.ts
│   │   ├── http-source.ts
│   │   ├── appysv2-adapter.ts
│   │   ├── js-spider-runtime.ts
│   │   ├── drpy-runtime.ts
│   │   ├── drpy-operation-runtime.ts
│   │   ├── drpy-adapter.ts
│   │   ├── t4-adapter.ts
│   │   ├── media-sniffer.ts
│   │   ├── media-probe.ts
│   │   └── app-service.ts
│   └── desktop/
│       └── browser-sniffer-service.ts
├── tests/
├── docs/research/09-roadmap.md
├── docs/PROVIDER_REPLACEMENTS.md
├── docs/ONLINE_SOURCE_AUDIT_2026-07-26.md
├── docs/RELEASE.md
├── REQUIREMENTS.md
├── TECHNICAL_DESIGN.md
└── IMPLEMENTATION_STATUS.md
```

## 下一步

后续执行顺序以 [`docs/待完成事项与优先级.md`](docs/待完成事项与优先级.md) 为准：

1. 重新打包包含六种网盘能力的 x64/arm64 版本并完成真实扫码、清除凭据和登录后续播验收；
2. 完成普通 macOS GUI、Apple Silicon 和干净机器回归；
3. 使用真实代理媒体验证 Range、拖动、动态端口和服务重启恢复；
4. 完成 CatVod 版本损坏、网络抖动、登录任务中断和数据库异常的故障注入；
5. 再进入网盘文件树真实样本、字幕弹幕高级体验、正式签名公证和 Windows/Linux 实机闭环。

Spider、Android Spider 和规则兼容样本扩充不再作为近期任务。
