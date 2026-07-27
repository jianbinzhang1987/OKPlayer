# 实施进度

更新时间：2026-07-26

## 当前里程碑

阶段十四：完成跨全部已保存配置源的全局搜索、复合来源定位和多来源结果选择。

## 任务状态

| 编号 | 任务 | 状态 | 说明 |
|---|---|---|---|
| T01 | 工程初始化 | 已完成首版 | TypeScript、Vue 3、Vite、Electron Main/Preload/Renderer 构建链已完成 |
| T02 | 核心模型 | 已完成 | Site、Vod、Flag、Episode、PlayerResult、ResolvedMedia |
| T03 | 配置解析 | 已完成首版 | JSON、本地/远程、相对 URL、核心配置字段 |
| T04 | HTTP Source | 已完成首版 | type=0 XML、type=1 JSON；首页、分类、搜索、详情、播放参数 |
| T05 | 搜索服务 | 已完成增强版 | 支持当前播放源搜索和跨全部已保存配置搜索；全局模式按配置隔离加载、Provider 去重、受控并发、单源超时、失败隔离和新搜索取消旧搜索 |
| T06 | 详情与线路 | 已完成 | 详情、线路、剧集协议解析 |
| T07 | 播放解析 | 已完成首版 | Direct、Prefix、JSON API、Header 合并 |
| T08 | mpv | 已完成首版 | 已安装 mpv，真实 Unix Socket IPC、媒体加载、时长读取、暂停、继续和停止烟雾测试通过 |
| T09 | 数据存储 | 已完成增强版 | SQLite 配置、历史、收藏和设置持久化；支持配置切换/重命名/删除、历史单条删除/清空和断点续播 |
| T10 | Spider 兼容 | 已完成增强版 | JavaScript Spider 全链路已实现；通用 `csp_AppYsV2/XBPQ/XYQ/Alist/CatOpen` 与具体 Android Dex Spider 已分开识别，避免将所有 `csp_*` 一律误判为 Android Dex |
| T11 | Electron UI | 已完成产品化改版 | 已形成 macOS 风格侧边栏、内容首页、来源状态搜索、独立详情、收藏、带进度历史、播放源中心、设置和全窗口内置播放器；默认字号已提升，并支持紧凑、标准、大、特大四档持久化字体设置 |
| T12 | Electron 实机启动 | 已完成首版 | 已修复 Electron runtime、ESM 路径与 Preload 格式；开发版和打包版均可创建可见窗口 |
| T13 | 发布打包 | 已完成双架构测试包 | 已生成 x64 与 arm64 `.app/.dmg`；正式应用图标、660×400 DMG 安装界面、DMG 校验、挂载结构、二进制架构、ASAR 本地 HLS 分块和打包应用窗口均验收通过；正式签名、公证和自动更新待补充 |
| T14 | 统一 SourceAdapter | 已完成首版 | SourceCapability、SourceAdapter、SourceAdapterFactory、统一错误、日志、超时和 Unsupported Adapter 已落地 |
| T15 | T4Adapter | 已完成增强版 | 支持当前 FongMi type=4 及兼容 type=6/8，覆盖远程 ext、URL-safe Base64、长参数 POST、Header、超时、健康检查和失败隔离；5 个公开候选端点当前均受超时、403 或 TLS/网络异常限制 |
| T16 | DrpyAdapter MVP | 已完成增强版 | 声明式规则与动态 `js:` 均纳入 Worker：支持预处理、推荐、分类、搜索、详情、对象二级中的动态 TABS/LISTS 和 lazy；提供受控同步 request、Cookie、选择器 RPC、存储、base64/hash、安全宽松数据字面量解析、请求次数/响应大小/超时限制，并默认阻断内网与任意字符串代码生成；固定提交的 5 个公开规则语法审计通过 |
| T17 | BrowserSniffer MVP | 已完成首版 | 独立临时 Session、隐藏 BrowserWindow、自动触发播放、重定向监听、广告排除、候选排序、媒体内容二次验证、取消、Cookie/Header 回传及播放失败自动降级已完成；GUI 实机烟雾测试需在普通 macOS 会话执行 |
| T18 | 内置播放器 | 已完成增强版 | 已实现受控 `fongmi-media://` 协议、HLS 清单/分片重写、全窗口 `<video>` 播放、原生能力检测、安装包内固定版本 HLS.js 1.6.16 + MSE、上一集/下一集、选集抽屉、控制层自动隐藏、双击全屏、倍速/快捷键、进度持久化、断点续播和 mpv 兼容降级；HLS.js 已作为独立懒加载代码块打入 ASAR，不依赖 CDN |
| T19 | Electron 43 升级 | 发布包升级已完成 | `package.json`、lockfile、electron-builder 配置与打包命令均锁定 Electron 43.2.0；x64 与 arm64 `.app/DMG`、Framework、ASAR HLS 代码块、图标和 DMG 挂载内容验收通过；Chromium 150 原生 HLS GUI 烟雾测试待普通 macOS 会话执行 |
| T20 | 正式发布闸门 | 工程准备已完成 | 已加入 Hardened Runtime、主/继承 Entitlements、Developer ID 与公证凭据预检、双架构挂载校验、SHA-256 清单、签名/Gatekeeper 检测及正式模式阻断；当前机器无有效证书，正式签名与公证尚未执行 |
| T21 | 多 Provider 运行时 | 已完成增强版 | AppYsV2、XYQ、XBPQ 已覆盖首页、分类、搜索、详情、线路和剧集；ProviderManager 支持配置 Hash、LRU 与销毁；CatOpen 使用独立 Node 子进程和受控宿主 API；Alist v2/v3 支持目录、搜索、目录密码、可选登录和文件直链 |
| T22 | 替代 Provider 与批量审计 | 已完成增强版 | 支持具体 `csp_*` 的精确 API/JAR Hash 匹配、替代运行时、来源/许可证/验证日期记录、能力裁剪和透明 Adapter 包装；单配置与批量 CLI 支持外部注册表，批量报告按出现次数和配置覆盖数输出 Android-only 排名；设置页支持导入、持久化恢复、即时重建和清除注册表；默认注册表保持为空，未内置未经验证的映射 |
| T23 | 在线配置与播放链审计 | 已完成首轮 | 支持带注释/尾逗号的宽松 JSON、影视仓 `urls` 多仓递归展开、Clash Fake-IP 安全识别、通用 Drpy 引擎指纹、Base64 规则、`play_url/urlencode` 宿主变量、网页播放自动嗅探和直链媒体签名验证；四个直连配置 506 个站点中识别 301 个，非凡/尤酷/极速抽样 HLS 验证通过 |
| T24 | 跨配置全局搜索 | 已完成首版 | 默认搜索全部已保存配置，可切换当前播放源；使用可持久化复合来源引用解决不同配置同名 `siteKey` 冲突，详情、收藏、历史和播放均可恢复原配置；聚合卡片支持选择具体配置/站点来源，当前配置不会被全局搜索切换 |

## 自动化测试与构建

当前：99 项通过，0 项失败。

构建：

```text
Renderer 构建通过
Electron Main 构建通过
Preload 构建通过
CatOpen 独立 Worker 构建与 IPC 烟雾测试通过
Alist v2/v3 本地协议回归通过
配置兼容审计文本与 JSON CLI 验证通过
替代 Provider 注册表执行、能力裁剪和来源展示回归通过
批量配置审计、大小写归并和 Android-only 高频排名 CLI 验证通过
设置页替代注册表导入、清除、持久化恢复和 Provider 即时重建回归通过
宽松 JSON/JSON5 与影视仓多仓递归展开回归通过
Clash/TUN Fake-IP 安全兼容、Drpy Base64 规则和标准宿主变量回归通过
网页播放地址自动嗅探、直链媒体签名和 404 线路阻断回归通过
公开配置非凡资源搜索、详情、HLS 探测和 `fongmi-media://` 内置播放会话实测通过
应用层 TypeScript 类型检查通过
Electron 43.2.0 与 HLS.js 1.6.16 锁文件 `npm ci --dry-run` 校验通过
Electron 43.2.0 x64 与 arm64 `.app/DMG` 构建通过，Mach-O 架构、Framework 版本、DMG 校验、挂载内容、正式图标、ASAR 本地 HLS 代码块与 CSP 均验收通过
打包后的 x64 应用通过 Playwright 启动验收：1360×860 窗口、Preload API、空状态、布局及控制台均正常
Electron 开发版启动基线通过
BrowserSniffer 烟雾测试已改为结果文件强校验，当前远程终端因 macOS Mach-port 权限无法启动 Electron GUI 子进程
`npm run release:verify` 可重复校验双架构发布物、DMG 挂载结构、图标、HLS 本地分块、签名状态并输出 JSON 报告与 SHA-256 清单
`npm run release:preflight` 会检查 Developer ID 与三类 Apple 公证凭据；`npm run release:formal` 在无签名环境下会阻止正式发布
mpv 本地测试媒体播放与控制通过
Playwright/Electron 真实公开 HLS 流通过 HLS.js + MSE 加载，媒体时长与元数据可读
```

已覆盖：

- 配置加载与相对 URL；支持 BOM、注释、尾逗号、单引号和未加引号对象键等宽松 JSON/JSON5；
- 影视仓顶层 `urls` 多仓索引识别、相对地址解析、递归展开、深度/数量限制及下级失败隔离；
- type=0 XML、type=1 JSON 播放源，以及当前 FongMi type=4 T4 服务；
- 首页、分类、搜索、详情；
- 多线路、多剧集；
- 播放地址和 JSON 解析器；
- 多源搜索及取消；
- JS Spider 执行、生命周期和宿主请求；
- Android Dex/JAR Spider 能力识别、禁用与降级提示；
- 通用 `csp_AppYsV2/XBPQ/XYQ/Alist/CatOpen` 与具体 Android Spider 的分层识别；
- 配置中的对象型 `ext` 可保留并交给 XBPQ 等规则运行时；
- AppYsV2 首页、分类、搜索、详情、线路、剧集、解析 API 与请求头传递闭环；
- XYQ 远程/内联宽松规则、HTML/JSON 列表、GET/POST 搜索、`firstPage`、占位符、常用选择器、详情线路、选集和直链提示处理；
- XBPQ 对象/远程规则、首页、分类、POST 搜索、二次截取、链接拼接、包含/不包含/替换、详情元数据、线路和剧集；
- CatOpen 独立 Node 子进程、IPC 生命周期、VM 沙箱、受控资源导入、请求/批量请求、存储、HTML 解析、MD5/AES、首页、分类、搜索、详情、播放和代理；
- CatOpen 默认不向 Provider 暴露 `process`、`require`、文件系统和系统命令，并限制网络协议、私有地址、响应大小和执行时间；
- Alist v2/v3 settings、目录列表、目录导航、搜索、目录密码、v3 登录 Token、文件详情和直链播放；登录 Token 不透传到第三方媒体地址；
- `vodTag=folder/file/action` 在核心模型和 Renderer 中保留，目录点击进入下级目录而不是误入影片详情；
- 配置兼容审计输出运行时分布、兼容率、已应用替代 Provider、Android-only 清单和其他不可用原因，支持文本、JSON 与文件输出；
- 批量兼容审计支持多个配置或清单文件、并发加载、失败隔离、运行时汇总，以及按 API 出现次数和配置覆盖数生成 Android-only 排名；
- 替代 Provider 注册表支持精确且忽略大小写的 `match.api`、可选 JAR MD5、启停控制、来源/仓库/许可证/验证日期、目标运行时和能力裁剪；
- 替代 Adapter 保留原站点 key/name，对 UI、搜索结果和历史记录透明，并在播放源页面展示替代来源和许可证；
- 设置页可导入本地或远程替代注册表，来源写入 SQLite，启动时优先恢复；加载或清除后销毁旧 Provider、清空缓存并重建当前配置，失败时回滚旧注册表；
- 配置加载器与 Android `csp_*` 兜底识别均支持大小写变体；
- Provider 按配置 Hash 复用、LRU 淘汰及 destroy 生命周期；
- HTTP、JavaScript、Drpy、T4、AppYsV2、XYQ、XBPQ、CatOpen、Alist 和 Unsupported Source 统一 Adapter 调度；
- T4 首页、分类、搜索、详情、播放、Header、健康检查与参数编码；兼容 FongMi type=4、旧 type=6/8、远程 ext 和长参数 POST；
- Drpy 声明式 Worker、Cookie、HTML/JSON 选择器、base64、MD5/SHA、localStorage、POST、筛选模板、搜索、详情、线路和播放；
- Drpy 动态 `js:` Worker：预处理、推荐、分类、搜索、详情、对象二级动态 TABS/LISTS 和 lazy，支持同步 request/fetch/post、fetch_params Header 继承、选择器宿主 RPC、结果归一化与状态回传；
- Drpy 动态运行安全边界：默认阻断 localhost/内网/链路本地地址与 DNS 重绑定到内网；公开域名解析到 Clash `198.18.0.0/15` 或 `fdfe:dcba:9876::/48` Fake-IP 时允许交给系统代理；限制操作时长、请求次数、单响应大小，并禁用任意 eval/Function/Wasm 动态生成；
- Drpy 支持通用远程 JS 引擎 + JS 规则指纹、整体 Base64 规则脚本，以及 `play_url`、`urlencode/encodeUrl/decodeUrl` 标准宿主变量；
- 固定上游提交的 5 个公开 Drpy 规则加载审计；8 个动态操作未发现已知宿主 API 缺口，2 个无网络 lazy 实际 Worker 执行通过；
- 公开 Drpy 在线回归：相声随身听首页返回 12 项、首项详情生成 1 条线路和 50 个音频、lazy 返回可播放直链；03影院因域名解析到内网被安全策略阻断，可可影视返回非标准 HTTP 850；
- BrowserSniffer 独立 Session、隐藏窗口、权限拒绝、弹窗阻断、播放控件自动触发、子框架执行、重定向监听、媒体识别、广告排除、候选排序、超时与用户取消；
- HLS、DASH、MP4 内容签名二次验证，过滤返回 HTML 的伪媒体地址；播放准备阶段对明显直链主动探测，404/410/HTML/格式不匹配直接报告线路失效，403/超时等不确定结果保留兼容回退；
- 爱奇艺、优酷等明显网页播放地址不再误当直链，而是自动进入 BrowserSniffer；
- BrowserSniffer Cookie、Referer、User-Agent 回传及内置播放器/mpv 降级链路；
- `fongmi-media://` 媒体会话隔离、请求头主进程托管、HLS 主/子清单及分片/密钥/字幕地址重写；
- 全窗口内置播放器、上一集/下一集、右侧选集抽屉、播放中控制层自动隐藏、双击全屏、播放快捷键、倍速、进度保存、断点续播以及携带当前进度切换 mpv；
- Electron 原生 HLS 能力为空时按需启用 HLS.js + MSE，真实 Mux HLS 流读取到媒体元数据与约 634.6 秒时长；
- Mux HLS、DASH-IF MPD、Video.js MP4 三个公网媒体样例审计通过；
- mpv 命令与播放器服务；
- SQLite 配置和历史管理生命周期；
- Renderer 首页、来源状态搜索、独立详情、内置播放、收藏、带进度历史、播放源配置管理和设置；默认使用舒适阅读字号，并提供紧凑、标准、大、特大四档字体设置；
- Playwright 首页、详情、内置播放器、播放源重命名、历史、搜索状态、设置与最小窗口尺寸 UI 验收，控制台 0 错误、0 警告；
- AppService 端到端闭环。

## 尚未完成

1. 在普通 macOS GUI 会话执行 `npm ci`、`npm run verify:electron`、`npm run smoke:embedded:electron43`，完成 Chromium 150 原生 HLS、内置播放器与 BrowserSniffer 实机回归；当前远程连接器启动 Electron GUI 子进程时返回 502；
2. 扩大公开动态 Drpy 在线回归样本；当前爱奇艺、优酷、杯狐等搜索/详情能力已抽样，部分站点仍受 403、444、模板依赖和上游失效影响；
3. 根据新失败样本补充专用加密、验证码、浏览器和其他规则宿主 API；
4. 扩大真实 XYQ、XBPQ、CatOpen、Alist 配置样本回归，并按失败样本补充方言、加密库和宿主 API；
5. Python Spider；
6. 使用批量兼容审计收集真实 Android-only 高频排名，验证具体替代实现后逐项录入默认注册表；当前基础设施已完成，但默认注册表仍为空；
7. 直播、EPG、时移；
8. 字幕、弹幕、DLNA；
9. 继续寻找稳定公开 T4 服务；首批 5 个候选端点当前均超时、返回 403 或出现 TLS/网络异常；
10. 安装有效的 Apple Developer ID Application 证书并配置 Apple 公证凭据，执行 `npm run release:formal`；自动更新发布流程仍待补充；
