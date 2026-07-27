# macOS 内置播放器选型与实施方案

更新时间：2026-07-27

## 1. 目标

将视频播放主体验迁移到 Electron 应用内部，以 ArtPlayer + 受保护媒体协议作为当前主路线，同时保留 FongMi/TVBox 播放源所需的解析、网页嗅探、Cookie、Referer、User-Agent、Range 和临时 Token 能力。

## 2. 已完成的首版架构

```text
用户点击剧集
  → AppService.resolve()
  → 解析失败时 BrowserSniffer
  → DesktopPlaybackService.prepare()
  → PlaybackSessionStore 保存真实 URL 与 Header
  → Renderer 仅获得 fongmi-media:// 随机会话地址
  → MediaProtocolService 使用 Electron net.fetch 转发请求
  → HLS Manifest Rewriter 重写子清单、分片、Key、字幕和初始化片段
  → EmbeddedPlayer / ArtPlayer 使用应用内播放器播放
  → 非 Web 兼容格式不再单独实现播放器窗口，提示换线路、换来源或外部播放器兜底
```

已完成：

- 全窗口内置播放页；
- MP4、WebM 和音频的内置播放；
- HTTP Range 与响应头透传；
- HLS 主/子清单、分片、AES Key、初始化片段和字幕地址重写；
- 真实媒体 URL、Cookie 和 Token 仅保留在主进程；
- 播放进度定期保存、暂停保存、退出保存和断点续播；
- 倍速、全屏、键盘快进/快退和音量控制；
- HLS 原生能力预检测；
- ArtPlayer 实验版按需懒加载，真实夸克 4K MP4/HLS 优先应用内播放；
- mpv/外部播放器仅作为最后兜底，不再作为 P0/P1 的非 Web 格式窗口方案；
- 设置页展示 Electron、Chromium、Node、系统架构和原生 HLS 能力。

## 3. 第二阶段方案对比

| 方案 | 优点 | 风险与代价 | 结论 |
|---|---|---|---|
| 升级 Electron 43 | 使用新版 Chromium 的原生 HLS；继续复用 `<video>`、自定义协议和现有状态管理；依赖更少 | Electron 37 跨多个大版本升级，需要回归 Electron API、打包和 UI | 首选 |
| 在 Electron 37 接入 HLS.js | 不必升级 Electron；HLS 兼容和错误恢复能力成熟 | 新增播放器生命周期、MSE 缓冲、清晰度、错误恢复和自定义 Loader；与原生 HLS 形成双路径 | 后备 |
| libmpv Render API | 格式和字幕能力最完整 | 需要原生模块、Metal/OpenGL 渲染、动态库打包、签名、公证和多架构维护 | 长期增强 |
| mpv `--wid` | 改动较小 | macOS 窗口嵌套、层级、缩放、焦点和稳定性风险较大 | 不作为正式方案 |

## 4. 最终决策

第二阶段采用 Electron 43.2.0 + ArtPlayer 应用内播放器路线，验证 Chromium 150 原生媒体能力与 HLS.js/MSE 兼容路径；不再单独实现“非 Web 格式高兼容播放器窗口”。

原因：

1. 当前媒体协议、Manifest 重写和 `<video>` 播放链路已经形成，升级运行内核即可直接复用；
2. 不需要同时维护原生 HLS 与 HLS.js 两套播放器生命周期；
3. 清晰度、音轨、字幕等能力可先使用 Chromium 原生轨道能力，再根据真实失败样本决定是否补 HLS.js；
4. Electron 37 已明显落后，继续在旧内核上增加媒体依赖会提高后续升级成本。

HLS.js 保留为兼容插件，而不是默认主路径。当前实现会先检测 `<video>.canPlayType()`，原生 HLS 不可用时再懒加载安装包内固定版本 HLS.js 1.6.16；ArtPlayer 作为可选应用内播放引擎同样以独立代码块进入 ASAR，不依赖 CDN。

## 5. 当前升级状态

已完成：

- `package.json` 与 `package-lock.json` 锁定 Electron 43.2.0；
- Node.js 最低版本调整为 22.12.0；
- `repair:electron` 改为读取 lockfile，不再写死旧版本；
- 新增 `verify:electron`，用于检测安装版本与锁定版本是否一致；
- 内置播放器烟雾测试增加 Electron≥43、Chromium≥150、MP4 Range、原生 HLS、Manifest 重写和 HLS 分片断言；
- 新增 `smoke:embedded:electron43`，可临时解析 Electron 43.2.0 执行验收；
- HLS.js 1.6.16 已改为本地构建依赖，源码、CSP、Renderer 产物与 ASAR 均无 CDN 引用；
- electron-builder 配置和所有打包命令强制使用 Electron 43.2.0，避免本地旧 `node_modules` 造成错误降级；
- Electron 43.2.0 x64 与 arm64 `.app/DMG` 已生成，Framework 版本、Mach-O 架构、DMG 校验、挂载内容、ASAR HLS 代码块与 CSP 验收通过；
- 播放器已补齐上一集/下一集、右侧选集抽屉、播放中控制层自动隐藏、Page Up/Down 切集和双击全屏；
- `npm ci`、类型检查、生产构建和 256 项自动化测试通过；
- `PLY-010` 中“非 Web 格式播放器窗口”已按方案替代处理，统一收敛到 ArtPlayer 应用内播放和外部播放器最后兜底。

尚待普通 macOS 图形会话完成：

- 实际执行 `npm ci` 替换当前安装目录中的 Electron 37；
- 执行 Electron 43 原生 HLS GUI 烟雾测试与应用启动回归。

当前远程连接器能够解析临时 Electron 43.2.0 包，但启动 Electron GUI 子进程时返回 502，因此不能在该连接器内形成真实画面结论。

## 6. Electron 升级实施步骤

### 6.1 升级前基线

必须保持：

```bash
npm run typecheck
npm test
npm run build
```

全部通过，并记录当前应用启动、详情、播放、历史和配置管理截图。

### 6.2 升级依赖

将 Electron 从 37 升级到 43 的稳定版本，重新生成 lockfile 和本地依赖，不手工修改 `node_modules`。

同时检查：

- `electron-builder` 对 Electron 43 的兼容性；
- Node 24 与构建脚本兼容性；
- `protocol.registerSchemesAsPrivileged()`；
- `protocol.handle()`；
- `net.fetch()`；
- Preload sandbox 与 context isolation；
- 隐藏 BrowserWindow 网页嗅探；
- macOS title bar 和全屏行为。

### 6.3 自动化回归

执行：

```bash
npm ci
npm run verify:electron
npm run typecheck
npm test
npm run build
npm run smoke:embedded:electron43
npm run smoke:sniffer
```

其中 GUI 烟雾测试需要在普通 macOS 图形会话中执行，远程无 GUI 终端不能作为最终结论。

### 6.4 媒体样本矩阵

至少验证：

| 类型 | 验证重点 |
|---|---|
| 普通 MP4 | 内置播放、拖动、暂停、全屏 |
| 带 Header 的 MP4 | Referer、Cookie、Range |
| 单码率 HLS | Manifest 与分片加载 |
| 多码率 HLS | 子清单和清晰度切换 |
| AES-128 HLS | Key 重写与请求头 |
| 带 Cookie 的 HLS | Session Header 继承 |
| 直播 HLS | Manifest 刷新和长时间播放 |
| 嗅探得到的 HLS | Cookie、Referer、临时 Token |
| WebM/音频 | 原生媒体播放 |
| FLV/MKV/特殊编码 | 正确提示不在应用内播放，建议换线路、换来源或外部播放器兜底 |

### 6.5 发布回归

验证：

- x64 与 arm64 `.app`；
- x64 与 arm64 `.dmg`；
- 安装后首次启动；
- 应用退出后无残留媒体会话；
- ArtPlayer/HLS 分块在 x64 与 arm64 发布物中均存在；
- 非 Web 兼容格式不创建新的高兼容播放器窗口，错误提示清晰并给出换源或外部播放器兜底路径。

## 7. HLS.js 保留条件

升级 Electron 43 后，满足以下任一条件继续保留或增强 HLS.js：

- 真实 HLS 样本成功率仍低于预期；
- 原生 HLS 无法满足手动清晰度切换；
- 需要更细的网络、缓冲和错误恢复事件；
- 需要低延迟直播调优；
- 需要对特定异常 Manifest 做兼容处理。

后续若继续增强清晰度、音轨、低延迟直播等能力，应将现有 HLS.js 逻辑迁移到独立的 `HlsPlayerEngine`，不能继续堆入 `App.vue` 或 `EmbeddedPlayer.vue`。

```text
EmbeddedPlayer
  └── PlayerEngine
      ├── NativeVideoEngine
      ├── HlsJsEngine
      └── ArtPlayerEngine
```

## 8. 验收标准

第二阶段完成标准：

- 常见 MP4 与 HLS 默认在应用内部播放；
- 播放时不创建外部 mpv 窗口；
- 只有确实不兼容的媒体才提示换线路、换来源或外部播放器兜底；
- Header、Cookie、Range、Key 和分片请求正确；
- 播放进度可保存和恢复；
- 连续切换剧集无残留请求和明显内存增长；
- 全量自动化测试、生产构建和 GUI 烟雾测试通过；
- 打包后的 `.app` 与 `.dmg` 行为一致。
