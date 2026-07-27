# FongMi Desktop 跨平台兼容改造方案

> 文档状态：讨论版  
> 当前阶段：仅形成技术方案，不实施代码改造  
> 目标平台：macOS、Windows、Linux  
> 建议产品名称：FongMi Desktop

---

## 1. 背景与目标

当前程序最初以 macOS 客户端为目标建设，工程名称、窗口样式、播放器兼容层、打包脚本和自动化测试均带有明显的 macOS 特征。

但当前程序主体已经采用 Electron、Vue、TypeScript 和 Node.js 架构，核心业务能力不依赖 macOS 原生开发框架，具备改造成跨平台桌面软件的良好基础。

本次跨平台改造的目标是：

> 以一套 Electron 桌面代码同时支持 macOS、Windows 和 Linux，三端共享播放源、搜索、详情、收藏、历史、CatVod 服务和内置播放器等业务能力，将平台差异集中收敛在窗口、播放器降级、安全存储、打包发布和自动化测试层。

不建议分别维护三套客户端代码。

---

## 2. 总体可行性结论

当前程序可以改造成同时支持 Linux、macOS 和 Windows 的桌面软件，无需推倒重写。

### 2.1 可行性评估

| 能力范围 | 可行性 | 说明 |
|---|---|---|
| 基础界面和核心业务 | 高 | Electron、Vue 和 Node.js 业务逻辑天然支持三端 |
| 配置导入、搜索、详情、收藏和历史 | 高 | 主要依赖标准 Node.js API 和网络请求 |
| CatVod Node.js 服务 | 较高 | 当前使用 Electron UtilityProcess，具备跨平台基础 |
| Chromium 内置播放器 | 较高 | HTML Video、HLS.js 和自定义媒体协议可共用 |
| mpv 兼容播放模式 | 中 | Windows IPC、二进制分发和依赖库需要专项改造 |
| 三端安装、签名和升级 | 中 | 需要建设独立构建、签名和发布流水线 |
| Android Dex/JAR Spider | 低 | 依赖 Android Runtime，不能因桌面跨平台改造而直接兼容 |

### 2.2 建议交付产物

| 平台 | 首期建议支持范围 | 建议安装包 |
|---|---|---|
| macOS | macOS 12 及以上，x64、arm64 | DMG |
| Windows | Windows 10/11，x64 | NSIS EXE，可选 Portable |
| Linux | Ubuntu 22.04/24.04、Debian 系，x64 | AppImage、DEB |

Linux 首期不建议宣称支持所有发行版、桌面环境和显卡驱动组合，应先明确官方验证范围。

---

## 3. 当前技术基础

当前工程主要采用以下技术：

- Electron 43；
- Vue 3；
- TypeScript；
- Vite；
- Node.js 22；
- Node.js 内置 SQLite；
- Chromium HTML Video；
- HLS.js；
- Electron 自定义媒体协议；
- Electron UtilityProcess；
- mpv JSON IPC 兼容播放器。

以上技术除少量平台差异外，均具备跨平台运行基础。

---

## 4. 可直接复用的能力

### 4.1 核心业务层

`src/core` 下的大部分业务模块可以直接在三端复用，包括：

- 配置加载和解析；
- 播放源管理；
- Drpy、XBPQ、XYQ、T4、CatOpen 等适配器；
- 搜索、详情和播放解析链；
- 收藏、历史和设置；
- 媒体地址探测；
- 媒体嗅探；
- 来源质量评估；
- CatVod 配置解析；
- Provider 管理和替换规则。

这些模块主要依赖 Node.js 标准能力，不需要为三个平台分别重写。

### 4.2 CatVod Node.js 服务

当前程序通过 Electron `utilityProcess.fork()` 启动 CatVod 服务，已经包含：

- 动态端口分配；
- 健康检查；
- 服务自动重启；
- 日志记录；
- Provider 版本下载；
- MD5 和 SHA-256 校验；
- 候选版本激活；
- 版本回滚；
- Host Bridge；
- 远程访问审计。

该机制在 Electron 三个平台均有基础支持，整体架构可以保留，重点进行三端运行验证和文件权限兼容处理。

### 4.3 内置播放器

当前内置播放链路采用：

> Chromium HTML Video + HLS.js + `fongmi-media://` 受控媒体协议。

标准 HLS、MP4 和浏览器可解码媒体格式可以继续共用同一套播放器组件。

内置播放器应继续作为三端默认播放器，mpv 仅作为媒体格式、协议或解码失败时的兼容降级方案。

### 4.4 用户数据目录

当前主程序使用 Electron `app.getPath("userData")` 获取用户数据目录，可以自动映射到各平台标准位置：

- macOS：Application Support；
- Windows：AppData；
- Linux：用户配置目录。

应继续使用该机制，禁止在业务代码中硬编码系统目录。

---

## 5. 必须改造的平台差异

## 5.1 窗口和标题栏

当前主窗口使用 macOS 风格的 `hiddenInset` 标题栏，界面中还为左上角红黄绿窗口按钮预留了安全区域。

该设计在 Windows 和 Linux 上会产生以下问题：

- 顶部留白不合理；
- 缺少符合系统习惯的最小化、最大化和关闭按钮；
- 拖拽区域与交互控件冲突；
- 全屏播放器顶部布局不一致。

建议方案：

| 平台 | 首期窗口方案 |
|---|---|
| macOS | 保留 `hiddenInset` 和交通灯安全区域 |
| Windows | 优先使用原生标题栏 |
| Linux | 优先使用原生标题栏 |

首期不建议三端统一实现完全自定义标题栏。Windows 和 Linux 使用原生标题栏可以减少窗口拖动、缩放、触控、高分屏和无障碍方面的兼容风险。

## 5.2 mpv 兼容模式

当前 mpv 控制器使用 Unix Domain Socket：

```text
/tmp/fongmi-mac-mpv-<pid>.sock
```

该方式适用于 macOS 和 Linux，但 Windows 需要使用 Named Pipe，例如：

```text
\\.\pipe\fongmi-mpv-<pid>
```

此外，当前代码默认直接执行系统 PATH 中的 `mpv`，正式产品不能要求普通用户自行安装 mpv。

mpv 兼容模式需要专项解决：

- 三端 IPC 地址生成；
- 三端 mpv 二进制定位；
- mpv 和依赖动态库随包分发；
- 三端资源目录结构；
- 启动参数兼容；
- 进程退出和残留清理；
- Windows Defender 和代码签名；
- Linux 动态库和显卡驱动差异；
- macOS Hardened Runtime 和签名；
- 安装包体积控制。

详细方案应单独形成 mpv 三端兼容设计。

## 5.3 网络请求和系统代理

当前配置加载在 Node.js `fetch` 失败时，仅在 macOS 调用固定路径 `/usr/bin/curl` 作为网络回退。

该逻辑不能直接应用于 Windows 和 Linux：

- Windows 不保证存在 curl 或固定安装路径；
- Linux 不保证预装 curl；
- 三端系统代理、证书和 VPN 行为不同。

建议将网络请求统一收敛到跨平台网络层：

1. 优先使用 Electron `net.fetch`；
2. 统一继承系统代理配置；
3. 统一处理 HTTP/HTTPS、重定向和超时；
4. 明确证书异常和代理认证策略；
5. curl 仅保留为开发诊断工具，不作为正式业务依赖。

## 5.4 User-Agent 管理

当前多个播放源适配器使用固定 macOS 浏览器 User-Agent。

固定 Mac User-Agent 不一定立即导致播放失败，但不符合跨平台产品定位，也不利于针对不同站点进行兼容调整。

建议增加统一 User-Agent 策略：

- 默认桌面浏览器 UA；
- PC UA；
- Android UA；
- 移动端 UA；
- 站点级 UA 覆盖；
- 配置文件声明优先于平台默认值。

播放源兼容不应机械地使用当前操作系统 UA，而应根据目标站点规则选择合适 UA。

## 5.5 安全存储和文件权限

当前 CatVod Profile 使用 AES-256-GCM 加密，本地密钥文件使用 Unix `0600` 权限。

在 Windows 中，`chmod 0600` 不能等价于“仅当前用户可访问”，需要重新定义安全存储策略。

Electron `safeStorage` 在三端的底层机制存在差异：

- macOS：Keychain；
- Windows：DPAPI；
- Linux：Secret Service 或 libsecret，部分桌面环境可能不可用。

建议采用分层策略：

1. 优先使用系统安全存储；
2. 系统安全存储不可用时，使用本地 AES-256-GCM 密钥；
3. 在设置页面展示当前安全存储状态；
4. 保留旧版 macOS 密文和本地密钥迁移能力；
5. 禁止因产品更名导致旧用户配置、历史和收藏丢失。

## 5.6 产品命名和数据迁移

当前工程中大量使用以下 macOS 专用名称：

- FongMi macOS；
- fongmi-macos；
- tv-macos.sqlite；
- macOS Edition；
- 当前 macOS 版本无法执行。

建议统一调整为：

- 产品名称：FongMi Desktop；
- 包名称：fongmi-desktop；
- 数据库名称：fongmi-desktop.sqlite；
- 页面标识：Desktop Edition 或不展示平台版本文字。

工程目录当前仍可暂时保留为 `mac`，后续稳定后再考虑改为 `desktop`，避免产品重命名和目录重构同时进行导致变更范围过大。

数据迁移需要包含：

- 旧数据库路径识别；
- 旧数据库复制或就地迁移；
- 旧收藏、历史、配置和设置保留；
- 旧 CatVod Provider 版本目录迁移；
- 迁移失败时保留原始数据并提供回退。

---

## 6. Android Dex/JAR 兼容边界

将客户端改造成 Windows、Linux 和 macOS 三端软件，并不能使 Android Dex/JAR Spider 自动在桌面系统中运行。

依赖以下能力的 Spider 仍不能直接执行：

- Android Context；
- DexClassLoader；
- Android CatVod 类库；
- Android WebView 或 Android 系统服务；
- Android 专用文件和网络 API。

三端桌面能力边界建议统一为：

| 来源类型 | 三端支持情况 |
|---|---|
| HTTP、XML、JSON | 支持 |
| Drpy、通用 JavaScript | 支持 |
| XBPQ、XYQ | 支持 |
| CatOpen | 支持 |
| T4 和远程服务 | 支持 |
| CatVod Node.js Provider | 支持 |
| Android Dex/JAR Spider | 不直接支持 |

跨平台产品宣传中不能将“三端桌面支持”表述为“完整兼容 Android TVBox 所有接口”。

---

## 7. 建议的平台抽象架构

不建议在业务代码中大量散落：

```ts
if (process.platform === "darwin") { ... }
```

建议新增平台适配层：

```text
src/desktop/platform/
├── platform-runtime.ts
├── mac-runtime.ts
├── windows-runtime.ts
├── linux-runtime.ts
├── window-options.ts
├── player-runtime.ts
├── secure-storage.ts
├── network-runtime.ts
└── executable-locator.ts
```

统一接口示例：

```ts
interface DesktopPlatformRuntime {
  platform: "mac" | "windows" | "linux";
  createWindowOptions(): BrowserWindowConstructorOptions;
  getMpvExecutable(): string;
  getMpvIpcEndpoint(): string;
  getDefaultUserAgent(): string;
  getSecureStorageCapability(): SecureStorageCapability;
}
```

业务模块只依赖统一接口，不直接了解系统目录、IPC 类型、窗口按钮和可执行文件后缀。

---

## 8. 打包和发布体系

当前工程只有 macOS 的 APP 和 DMG 打包配置，需要扩展为三端统一构建体系。

建议提供以下命令：

```text
package:mac
package:win
package:linux
package:all
```

建议 electron-builder 目标：

```yaml
mac:
  target:
    - dmg

win:
  target:
    - nsis
    - portable

linux:
  target:
    - AppImage
    - deb
```

需要补充：

- Windows ICO 图标；
- Linux PNG 图标；
- Windows NSIS 安装配置；
- Linux Desktop Entry；
- 协议注册；
- 卸载行为；
- 缓存和用户数据保留策略；
- 应用升级策略；
- 安装包校验；
- 三端代码签名。

正式安装包不建议只在一台 Mac 上交叉构建。建议建立三平台构建矩阵：

- macOS Runner：构建、签名和公证 DMG；
- Windows Runner：构建和签名 EXE；
- Linux Runner：构建 AppImage 和 DEB。

---

## 9. 自动化测试改造

当前多个 E2E 和打包验收脚本直接使用 macOS APP 可执行文件路径，需要抽象统一的安装包定位逻辑。

建议增加：

```ts
resolvePackagedExecutable(platform, arch)
```

不同平台分别返回：

- macOS：`.app/Contents/MacOS/<ProductName>`；
- Windows：`<ProductName>.exe`；
- Linux：AppImage 或 unpacked executable。

### 9.1 可共用测试

- 配置解析；
- 搜索和详情；
- 收藏和历史；
- CatVod 配置解析；
- Provider 更新和回滚；
- 播放 URL 解析；
- HLS 清单改写；
- 数据库存储；
- 媒体探测；
- 安全策略。

### 9.2 必须三端分别执行的测试

- 应用启动和退出；
- 用户数据目录读写；
- CatVod 子进程生命周期；
- 自定义媒体协议；
- HLS 实际播放；
- mpv 降级播放；
- 系统代理；
- 窗口缩放和全屏；
- 高分屏和字体缩放；
- 安装、升级和卸载；
- 数据迁移；
- 安全存储；
- 安装包签名状态。

---

## 10. 建议实施阶段

### 第一阶段：通用桌面工程化

目标是在不降低现有 macOS 能力的前提下，将工程从“macOS 专用”改造成“跨平台可扩展”。

主要任务：

- 产品名称和文案去 macOS 化；
- 建立平台适配层；
- 清理硬编码 Mac 路径；
- 窗口配置按平台拆分；
- 网络访问层统一；
- 测试脚本可执行文件路径抽象；
- 保留旧 macOS 数据兼容。

### 第二阶段：Windows 支持

主要任务：

- Windows 原生窗口和标题栏；
- mpv Named Pipe；
- Windows mpv 二进制和依赖分发；
- Windows 安装包；
- DPAPI 和 safeStorage；
- 系统代理和证书验证；
- 高分屏测试；
- Defender 和代码签名验证。

### 第三阶段：Linux 支持

主要任务：

- AppImage 和 DEB；
- Ubuntu、Debian 验证；
- X11 和 Wayland；
- mpv 和动态库分发；
- libsecret 缺失时的加密降级；
- 显卡硬件加速兼容；
- 桌面菜单、图标和协议注册。

### 第四阶段：三端正式发布体系

主要任务：

- 三平台 CI 构建；
- 三端代码签名；
- 自动升级；
- 安装包冒烟测试；
- 三端播放兼容矩阵；
- 发布校验和版本回滚。

---

## 11. 首期范围建议

首期建议坚持以下原则：

1. 一套代码，不建设三套客户端；
2. 先保证业务能力一致，再追求三端视觉完全一致；
3. 内置播放器优先，mpv 仅用于兼容降级；
4. Windows 先支持 x64，不立即承诺 Windows ARM64；
5. Linux 先支持 Ubuntu 和 Debian 系 x64；
6. 不将 Android Dex/JAR 纳入桌面跨平台承诺；
7. 不要求用户自行安装 Node.js、mpv、ffmpeg 或其他运行环境；
8. 所有必要运行时应随安装包提供，或由程序受控下载并校验；
9. 用户数据迁移和旧版本回退必须优先于产品重命名；
10. 三个平台必须分别进行真实安装和播放测试。

---

## 12. Web 播放器选型方案

### 12.1 名称说明

本节讨论的播放器是 **ArtPlayer**，不是 AirPlayer。

- ArtPlayer：基于 HTML Video 的 Web 播放器框架；
- AirPlayer：通常指 AirPlay 投屏或接收类产品，与当前播放器选型不是同一类技术。

### 12.2 当前播放器基础

当前项目并非只使用一个裸 `<video>` 标签，而是已经在 `EmbeddedPlayer.vue` 中实现了一套自研播放器外壳，主要包括：

- Chromium 原生 HTML Video 播放；
- macOS 原生 HLS 能力检测；
- HLS.js 动态加载；
- HLS 网络错误和媒体错误恢复；
- 播放、暂停、拖动、倍速和音量；
- 全屏和键盘快捷键；
- 剧集抽屉、上一集和下一集；
- 播放进度恢复和定期保存；
- 字幕和弹幕地址预留；
- 播放失败后自动切换 mpv；
- 自定义 `fongmi-media://` 媒体协议和请求头保护。

因此，引入 ArtPlayer 或 XGPlayer 并不是增加一个新的原生解码内核，而是考虑用成熟播放器框架替换或增强当前自研的播放器界面、状态管理和插件能力。

### 12.3 三种方案的定位差异

| 方案 | 主要定位 | 底层播放能力 | 当前关系 |
|---|---|---|---|
| 当前自研播放器 | 完全自定义播放器 UI 和状态管理 | HTML Video + HLS.js | 已经落地，控制力最强 |
| ArtPlayer | 轻量播放器 UI 和插件框架 | HTML Video，可接入 HLS.js、dash.js、mpegts.js | 可较平滑替换现有 UI 层 |
| XGPlayer | 播放器框架和多协议插件体系 | HTML Video + HLS、FLV、DASH、MP4 等插件 | 更适合直播和复杂多协议场景 |
| mpv | 独立原生兼容播放器 | FFmpeg/libmpv 解码体系 | 处理 Chromium 无法播放的特殊媒体 |

### 12.4 ArtPlayer 与当前方案的区别

ArtPlayer 主要提供成熟的播放器控制层和插件机制，包括：

- 标准控制栏；
- 倍速、音量、全屏和画中画；
- 清晰度切换；
- 播放记忆；
- 多字幕和 ASS 字幕扩展；
- 弹幕插件；
- 自定义按钮和菜单；
- 自定义媒体类型；
- 播放器事件和生命周期管理。

采用 ArtPlayer 后，可以继续保留项目现有的关键能力：

```text
ArtPlayer
├── 使用 ArtPlayer 的播放器 UI 和插件体系
├── HLS 继续接入现有 HLS.js
├── 媒体地址继续使用 fongmi-media://
├── 请求头继续由主进程和受控协议管理
├── 历史、剧集和来源信息继续由业务层管理
└── Web 播放失败后继续切换 mpv
```

ArtPlayer 的主要价值是减少播放器 UI、字幕、弹幕、控制栏和异常状态的长期自研成本，而不是替代 HLS.js 或 mpv。

### 12.5 XGPlayer 与当前方案的区别

XGPlayer 除播放器 UI 外，还提供较完整的多协议插件体系，适合以下场景：

- HLS 点播和直播；
- HTTP-FLV；
- MPEG-TS；
- DASH；
- MP4 分段加载；
- 直播低延迟；
- 复杂码率和缓冲控制；
- 多协议播放器统一管理。

如果后续产品明确发展为“点播 + IPTV 直播 + FLV + DASH”的综合播放器，XGPlayer 的价值会明显提升。

但在当前以点播、HLS 和 MP4 为主的阶段，直接引入 XGPlayer 全套插件会带来更大的改造范围：

- 需要重新验证现有 HLS.js 行为；
- 需要重新梳理自定义媒体协议接入方式；
- 播放事件和错误处理需要重新适配；
- 包体、依赖和测试矩阵增加；
- 可能与现有自研剧集和播放状态逻辑重复。

### 12.6 格式兼容能力边界

ArtPlayer 和 XGPlayer 能够增强的是协议和封装适配能力，例如：

- HLS；
- DASH；
- HTTP-FLV；
- MPEG-TS；
- 清晰度和码率切换；
- 字幕和弹幕；
- 点播和直播控制。

但二者最终仍依赖 Electron Chromium 的媒体解码能力，不能自动解决：

- Chromium 不支持的 HEVC 组合；
- 特殊 MKV 封装；
- DTS、TrueHD 等音频格式；
- 部分 10-bit 或特殊编码 Profile；
- 私有、异常或非标准媒体流。

因此应坚持以下边界：

```text
协议或 Web 播放管理问题
→ 由 ArtPlayer、HLS.js、dash.js、mpegts.js 等处理

Chromium 底层解码不支持
→ 由 mpv 兼容播放器处理
```

### 12.7 推荐选型

当前推荐采用以下路线：

> 以 ArtPlayer 作为首选 Web 播放器框架验证对象，保留现有 HLS.js、自定义媒体协议、业务进度管理和 mpv 降级链路；暂不引入 XGPlayer 全家桶。

推荐原因：

1. 当前项目以点播为主，ArtPlayer 的能力范围更匹配；
2. 现有 HLS.js 播放链路已经较完整，可以继续复用；
3. 现有 `fongmi-media://` 协议和请求头保护无需推倒重做；
4. ArtPlayer 更适合承担 UI、字幕、弹幕和插件层；
5. 接入范围小于 XGPlayer，迁移风险更可控；
6. mpv 仍可处理真正的底层解码兼容问题；
7. 避免同时维护多套 Web 播放器造成状态、快捷键和历史记录逻辑重复。

不建议形成以下结构：

```text
ArtPlayer + XGPlayer + OPlayer + 自研播放器 + mpv
```

建议始终保持一套统一播放器抽象：

```text
PlayerController
├── WebPlayer：ArtPlayer
│   ├── Native Video
│   ├── HLS.js
│   ├── 后续可选 DASH
│   └── 后续可选 MPEG-TS/FLV
└── CompatibilityPlayer：mpv
```

### 12.8 建议实施方式

当前阶段不应直接替换主播放器，而应先建立独立验证分支或实验页面，对 ArtPlayer 进行兼容性验证。

建议测试场景：

| 场景 | 验证重点 |
|---|---|
| 普通 MP4 | 基础播放、暂停、拖动和结束事件 |
| HLS 点播 | HLS.js 接入、清晰度和错误恢复 |
| HLS 直播 | 缓冲、追赶直播点和长期稳定性 |
| 自定义媒体协议 | `fongmi-media://` 是否可正常加载 |
| 带 Header 的媒体 | Referer、User-Agent、Cookie 是否继续受控 |
| HLS 相对分片 | 清单和分片重写是否保持有效 |
| 字幕 | 外挂字幕、编码和样式 |
| 弹幕 | 数据加载、性能和开关控制 |
| 剧集切换 | 上一集、下一集和剧集抽屉 |
| 进度恢复 | 历史位置恢复和定期保存 |
| 播放错误 | 错误展示、重试和状态清理 |
| mpv 降级 | Web 播放失败后能否无缝切换并续播 |
| Windows/macOS/Linux | 三端 UI、全屏、快捷键和硬件加速 |

只有在上述核心场景不弱于当前自研播放器时，才进入正式替换。

### 12.9 当前最终播放路线

综合跨平台、ZyFun 调研和现有工程基础，当前建议将播放体系确定为：

```text
主播放链路
└── 应用内 ArtPlayer
    ├── HTML Video
    ├── 现有 HLS.js
    ├── fongmi-media://
    ├── 字幕、弹幕、清晰度和剧集控制
    └── 后续按需增加 DASH、MPEG-TS 或 FLV

兼容播放链路
└── 随应用分发的 mpv 独立进程
    ├── Chromium 不支持的编码和封装
    ├── Web 播放连续失败
    └── 用户主动选择兼容模式
```

XGPlayer 暂时作为后续候选。当直播、HTTP-FLV、DASH 或复杂流媒体成为核心范围时，再重新进行 ArtPlayer 与 XGPlayer 的专项评估。

### 12.10 第一阶段实施进展（2026-07-27）

本阶段已经完成播放器升级的安全重构基础，现有播放能力保持可用：

- 新增统一 `PlayerContainer`，应用页面不再直接依赖具体播放器组件；
- 抽离播放会话、进度和剧集共享类型；
- 将 HLS.js 动态加载、类型声明和原生 HLS 检测抽离为独立 `hls-engine`；
- 将兼容播放器自动切换规则抽离为独立错误策略模块；
- 自动切换等待时间由 0.9 秒调整为 4 秒，降低临时网络波动导致的误切换；
- 新增“自动切换/仅手动切换”设置并持久化；
- 保留重新加载、手动兼容播放、自动下一集、外部播放器和历史进度能力；
- 旧 `EmbeddedPlayer` 继续作为稳定实现，由统一容器托管，便于后续新旧播放器灰度切换；
- 新增播放器升级架构、错误策略、HLS 引擎和兼容回退测试。

当前验证结果：

- TypeScript 类型检查通过；
- 单元及结构测试 225 项全部通过；
- Renderer 生产构建通过；
- 桌面主进程完整构建通过。

本阶段尚未直接引入 ArtPlayer 运行包。下一实施单元应在依赖可受控安装后新增 `ArtPlayerHost` 和适配器，并通过统一容器进行实验性灰度切换；在其核心播放场景通过之前，不删除旧播放器。

### 12.11 第二阶段实施进展：ArtPlayer 双引擎接入（2026-07-27）

本阶段已正式接入 ArtPlayer，但仍将其定位为可回退的实验播放器，不直接替换稳定播放器。

已完成内容：

- 将 ArtPlayer 5.4.0 作为本地固定依赖纳入 `package.json` 和锁文件，不使用 CDN；
- 新增 `ArtPlayerHost.vue`，实际实例化 ArtPlayer；
- `PlayerContainer` 同时支持 `legacy` 和 `artplayer` 两种引擎；
- ArtPlayer 组件采用异步按需加载，未启用实验播放器时不增加主界面启动负担；
- ArtPlayer 组件或分块加载失败时，自动切回稳定播放器并持久化回退结果；
- 设置页新增“稳定播放器 / ArtPlayer 实验版”选择项；
- 播放器引擎设置支持安全归一化，未知值自动回到稳定播放器；
- ArtPlayer 继续使用现有 `fongmi-media://` 受控媒体协议；
- HLS 继续通过统一 `hls-engine` 接入原生 HLS 或 HLS.js；
- 保留 HLS 网络错误和媒体错误恢复；
- 支持普通 MP4、HLS 点播、直播模式提示、倍速、进度恢复和定期保存；
- 接入受控字幕 URL；
- 支持上一集、下一集、自动下一集和剧集抽屉；
- 保留手动和自动 mpv 兼容降级；
- 使用应用播放器根节点全屏，确保自定义标题栏和剧集面板一并进入全屏；
- 增加旧实例生命周期保护，避免切集或销毁时误写入零进度；
- 新增第三方许可证声明，并将其纳入安装包；
- 发布校验脚本增加 ArtPlayer 按需分块和许可证文件检查。

构建优化结果：

- 主 Renderer JavaScript 约 193 KB；
- ArtPlayer 独立按需 JavaScript 分块约 150 KB；
- ArtPlayer 独立样式分块约 5 KB；
- HLS.js 继续保持独立动态分块；
- 未启用 ArtPlayer 时不会提前加载其播放器代码。

验证结果：

- TypeScript 类型检查通过；
- 完整测试 232 项全部通过；
- Renderer 生产构建通过；
- Electron 桌面完整构建通过；
- 发布校验脚本语法检查通过；
- 已新增真实 ArtPlayer MP4/HLS 烟雾测试脚本，可验证 ArtPlayer 实例、`fongmi-media://`、HLS.js 和媒体分片请求。

### 12.12 第三阶段实施进展：播放器端到端验证（2026-07-27）

已通过 Playwright Electron 能力启动最新打包的 `.app`，使用隔离用户目录和本地离线 MP4/HLS 服务完成真实用户路径验证。

端到端流程覆盖：

1. 设置 ArtPlayer 和兼容降级策略；
2. 导入并激活本地测试配置；
3. 选择本地测试播放源；
4. 搜索影片并进入详情；
5. 使用 ArtPlayer 播放 MP4；
6. 验证 `fongmi-media://` 受控协议；
7. 验证完整播放器外壳全屏；
8. 使用 ArtPlayer 播放 HLS；
9. 验证 HLS 清单和分片请求；
10. 切回稳定播放器并播放同一 MP4；
11. 重启应用并验证播放器选择和配置持久化；
12. 检查页面脚本、控制台和运行时异常。

端到端结果：

- 用例总数：8；
- 通过：8；
- 失败：0；
- 页面脚本错误：0；
- 控制台错误：0；
- 控制台警告：0。

关键播放结果：

- ArtPlayer MP4：`readyState=4`，时长 4 秒，进度正常推进；
- ArtPlayer HLS：时长约 4.02 秒，清单和媒体分片均已实际请求；
- 全屏：全屏元素为 `SECTION.art-player-host`，自定义标题栏与播放器外壳同时保留；
- 稳定播放器：切换后正常播放同一 MP4；
- 重启持久化：`webPlayerEngine=artplayer` 和测试配置均保留。

端到端测试发现并修复了一个真实缺陷：

- 原实现对普通 MP4 仍传入 `type: undefined`；
- ArtPlayer 参数校验因此拒绝初始化，并自动回退到稳定播放器；
- 已调整为非 HLS 场景完全不传 `type` 字段；
- 已补充自动化回归断言，防止再次出现。

当前验证状态：

- TypeScript 类型检查通过；
- 完整单元和结构测试 232 项全部通过；
- 最新 macOS `.app` 打包通过；
- 播放器专项 E2E 8 项全部通过。

测试报告和截图位于：

```text
artifacts/player-upgrade-e2e/report.html
artifacts/player-upgrade-e2e/report.json
artifacts/player-upgrade-e2e/report.md
```

可重复执行：

```bash
npm run package:mac:dir
npm run e2e:player
npm test
```

### 12.13 第四阶段实施进展：跨平台基础迁移（2026-07-27）

本阶段已将工程由“macOS 专用实现”迁移为“FongMi Desktop 跨平台基础架构”。业务解析、播放源、搜索、详情、收藏、历史和 ArtPlayer 主播放链路保持不变，重点迁移平台外围能力。

#### 1. 产品标识和旧数据迁移

已统一使用：

```text
产品名称：FongMi Desktop
包名称：fongmi-desktop
应用标识：com.fongmi.desktop
数据库：fongmi-desktop.sqlite
```

启动时会检测并迁移旧版本数据：

- `FongMi macOS` 用户目录；
- `fongmi-macos` 用户目录；
- `tv-macos.sqlite`；
- SQLite WAL/SHM 文件；
- CatVod 本地运行目录和其他持久化文件。

迁移采用“目标文件不存在时才复制”的策略，不覆盖新版本已经生成的数据。显式传入 `--user-data-dir` 的测试或隔离运行保持原路径，不触发用户目录重定向。

#### 2. 窗口和界面平台适配

新增统一窗口配置：

- macOS 保留 `hiddenInset` 和交通灯安全区；
- Windows 使用系统原生标题栏并自动隐藏菜单栏；
- Linux 使用系统原生标题栏并自动隐藏菜单栏；
- 播放器标题栏左侧安全区仅在 `data-platform="darwin"` 下显示；
- Windows/Linux 不再出现为 macOS 交通灯预留的空白；
- Renderer 可读取 `platform`、`desktopPlatform` 和平台能力信息；
- IINA 只在 macOS 设置中显示。

#### 3. 网络和代理迁移

配置下载已取消对 `/usr/bin/curl` 的 macOS 专属回退，统一由主进程注入 Electron `net.fetch`：

- 使用系统代理和 Electron 网络栈；
- Windows、macOS、Linux 行为一致；
- 核心模块测试时仍可注入普通 Fetch；
- 不再依赖操作系统自带 curl 路径。

#### 4. mpv 兼容播放迁移

已完成：

- macOS/Linux 使用系统临时目录 Unix Socket；
- Windows 使用 `\\.\pipe\fongmi-desktop-mpv-<pid>` Named Pipe；
- Windows 退出时不再对 Named Pipe 执行文件删除；
- 支持 `FONGMI_MPV_PATH` 显式指定；
- 支持从安装包 `resources/mpv/<platform>/<arch>/` 查找；
- 开发环境仍可回退到系统 PATH；
- Windows 子进程使用 `windowsHide`；
- 三端资源目录规范已经纳入安装包。

当前安装包只包含 mpv 目录说明，尚未放入三端 mpv 可执行文件、动态库和许可证。因此 mpv 的平台接口已经迁移，但“随应用分发 mpv”尚未完成。

#### 5. 外部播放器和安全存储

外部播放器：

- macOS：IINA、VLC、系统默认播放器；
- Windows：VLC、系统默认播放器；
- Linux：VLC、系统默认播放器；
- Windows 系统播放器通过 `rundll32 url.dll,FileProtocolHandler` 打开，不使用 Shell 字符串拼接；
- IINA 在 Windows/Linux 会明确拒绝。

安全存储：

- Windows/Linux 优先使用 Electron `safeStorage`；
- macOS 未签名测试包继续使用本地 AES-256-GCM，避免钥匙串弹窗；
- Windows 不再将 POSIX `chmod 0600` 当作有效 ACL；
- 旧 Profile 密文和明文迁移逻辑保持兼容。

#### 6. 三端构建体系

新增构建入口：

```bash
npm run package:mac:dir
npm run package:win:dir
npm run package:linux:dir
npm run package:mac
npm run package:win
npm run package:linux
```

Electron Builder 已配置：

- macOS：DMG / unpacked；
- Windows：NSIS / Portable / unpacked；
- Linux：AppImage / DEB / unpacked；
- Windows 卸载默认不删除用户数据；
- 三端均包含 ASAR、许可证和 mpv 资源目录。

构建资源脚本在 Windows/Linux 不再调用 `sips`、`qlmanage` 或 `iconutil`，而是复用预生成 PNG；Electron 修复脚本使用跨平台 ZIP 解压，并识别 macOS `.app`、Windows `electron.exe` 和 Linux `electron` 运行时布局。

Playwright 和产物审计脚本使用统一可执行文件定位器，可定位：

```text
macOS   release/mac/FongMi Desktop.app/Contents/MacOS/FongMi Desktop
Windows release/win-unpacked/FongMi Desktop.exe
Linux   release/linux-unpacked/fongmi-desktop
```

同时新增 macOS、Windows、Linux 原生 CI 构建矩阵，用于在各自系统执行类型检查、完整测试和 unpacked 打包。

#### 7. 当前验证结果

代码验证：

- TypeScript 类型检查通过；
- 完整测试 247 项全部通过；
- Renderer 和主进程生产构建通过；
- 跨平台专项测试通过；
- 构建和修复脚本语法检查通过。

macOS 原生验证：

- `FongMi Desktop.app` 打包通过；
- 打包应用界面审计通过；
- 播放器专项 E2E 8/8 通过；
- MP4、HLS、全屏、稳定播放器回退和重启持久化正常。

跨平台产物结构验证：

- macOS x64：Mach-O 结构通过；
- Windows x64：PE32+ unpacked 结构通过；
- Linux x64：ELF unpacked 结构通过；
- 三端 ASAR 内容一致；
- 三端均包含 HLS.js、ArtPlayer 按需分块和第三方许可证；
- 三端均包含 mpv 资源目录规范。

审计报告：

```text
artifacts/cross-platform-package-audit/report.json
artifacts/cross-platform-package-audit/report.md
```

#### 8. 尚未完成的原生验证

以下事项不能仅凭 macOS 交叉打包认定完成：

1. Windows 真实启动、窗口、系统代理、DPAPI/safeStorage 和 Named Pipe 测试；
2. Linux 真实启动、X11/Wayland、系统代理、Secret Service 和 Unix Socket 测试；
3. Windows NSIS/Portable 安装与卸载测试；
4. Linux AppImage/DEB 安装、桌面入口和依赖测试；
5. 三端 mpv 可执行文件、动态库、许可证和签名纳入安装包；
6. Windows 代码签名、macOS 公证、Linux 包签名；
7. Windows/Linux 原生播放器 E2E。

因此当前状态应表述为：

> 跨平台基础迁移和三端打包结构已经完成；macOS 已通过原生运行验证；Windows/Linux 已生成并通过结构审计，仍需在目标系统完成原生运行、安装、mpv 和签名验收。

---

## 13. 结论

当前程序适合改造成 FongMi Desktop 三端桌面客户端。

本次改造的核心不是重写搜索、详情、播放源、收藏和历史等业务，而是建设规范的平台适配层，并解决以下外围工程问题：

- 窗口和标题栏；
- Web 播放器框架；
- mpv 兼容播放；
- 网络和代理；
- 安全存储；
- 数据迁移；
- 三端打包；
- 三端签名；
- 三端自动化测试。

播放器方面，当前推荐采用“ArtPlayer 应用内主播放器 + 现有 HLS.js 和媒体协议 + mpv 独立兼容播放器”的分层方案。XGPlayer 暂不纳入首期实现，待直播和复杂多协议播放成为核心需求后再重新评估。

mpv 的三端 IPC、可执行文件定位和资源目录已经进入代码实施；下一阶段重点不再是方案设计，而是补齐三端二进制和动态库，并在 Windows/Linux 原生环境验证 Named Pipe、Unix Socket、播放进度同步和安装包签名。
