# OKPlayer

一个面向桌面端的跨平台影音播放器。

它兼容常见的 **FongMi / TVBox 配置格式**，支持导入你自己合法拥有或有权访问的播放源配置，在电脑上完成搜索、浏览、播放、收藏和历史续播。

> 当前安装包内的应用显示名称仍为 **FongMi Desktop**，仓库与发布版本名称为 **OKPlayer**。后续版本会逐步统一品牌名称。

---

## 为什么选择 OKPlayer？

很多 TVBox / FongMi 配置主要面向电视盒子或移动端使用，在电脑上使用时经常会遇到配置管理麻烦、播放体验割裂、外部播放器跳转频繁、历史记录不连续等问题。

OKPlayer 希望把这些能力整理成一个更适合桌面端的应用：

- **一个应用完成导入、搜索、详情、播放和收藏**，不再频繁切换工具；
- **优先使用内置播放器**，播放、选集、倍速、续播和全屏都在应用内完成；
- **支持多种常见配置形态**，尽量兼容 FongMi / TVBox 生态里常见的 JSON、T4、JS、Drpy、XYQ、XBPQ、Alist 等来源；
- **多平台发布**，同一套体验覆盖 macOS、Windows 和 Linux；
- **更重视安全边界**，播放请求头、Cookie 等敏感信息尽量保留在主进程，不直接暴露给页面层。

---

## 核心功能

### 播放源导入与管理

支持导入本地或远程配置，识别不同站点的能力和可用状态。你可以在应用内切换、重命名、删除配置，也可以查看来源是否可搜索、可分类、可播放。

### 首页、分类与搜索

支持首页推荐、分类浏览、单源搜索和多源搜索。搜索结果会尽量按可用性和质量排序，并展示不同来源的返回状态。

### 详情、线路和剧集

支持视频详情页、线路选择、剧集列表、上一集/下一集、线路偏好和失败后自动尝试备用线路。

### 内置播放器优先

内置播放器支持：

- MP4 / WebM / 常见音视频播放；
- HLS 播放；
- 播放进度记忆；
- 倍速、全屏、键盘控制；
- 右侧选集抽屉；
- 字幕和弹幕基础能力；
- 不兼容格式时再提示换源或使用外部播放器兜底。

### 历史与收藏

支持播放历史、断点续播和收藏管理。退出应用后再次打开，也可以继续上次的观看进度。

### 跨平台桌面体验

目前已经发布：

- macOS Intel x64；
- macOS Apple Silicon arm64；
- Windows x64 安装版；
- Windows x64 便携版；
- Linux x64 AppImage；
- Linux x64 DEB。

---

## 下载

最新版本：**OKPlayer v0.1.1**

前往 Release 页面下载：

<https://github.com/jianbinzhang1987/OKPlayer/releases/latest>

| 系统 | 推荐下载文件 | 说明 |
|---|---|---|
| macOS Intel | `FongMi.Desktop-0.1.1-x64.dmg` | 适用于 Intel 芯片 Mac |
| macOS Apple Silicon | `FongMi.Desktop-0.1.1-arm64.dmg` | 适用于 M1 / M2 / M3 / M4 等 Apple Silicon Mac |
| Windows | `FongMi.Desktop.Setup.0.1.1.exe` | 安装版，适合大多数用户 |
| Windows | `FongMi.Desktop.0.1.1.exe` | 便携版，适合临时试用 |
| Linux | `FongMi.Desktop-0.1.1-x86_64.AppImage` | 通用 AppImage 包 |
| Linux | `FongMi.Desktop-0.1.1-amd64.deb` | 适用于 Debian / Ubuntu 系发行版 |

Release 页面同时提供 `SHA256SUMS.txt`，可用于校验安装包完整性。

---

## 第一次使用

1. 下载并安装适合你系统的版本；
2. 打开应用，进入播放源或设置页面；
3. 导入你自己合法拥有或有权访问的 FongMi / TVBox 配置；
4. 回到首页、分类或搜索页面开始浏览；
5. 进入详情页选择线路和剧集，使用内置播放器观看；
6. 常看的内容可以加入收藏，播放过的内容会自动进入历史记录。

---

## 适合谁使用？

OKPlayer 更适合这些用户：

- 已经有合法可用的 FongMi / TVBox 配置，希望在电脑上统一管理；
- 希望在 macOS、Windows、Linux 上获得接近一致的播放体验；
- 希望减少外部播放器跳转，优先使用应用内播放；
- 需要收藏、历史、断点续播、多源搜索等桌面端体验；
- 想研究 FongMi / TVBox 配置兼容和桌面播放器实现的开发者。

---

## 当前支持情况

| 能力 | 状态 |
|---|---|
| 本地 / 远程 JSON 配置 | 支持 |
| type=0 XML 源 | 支持 |
| type=1 HTTP JSON 源 | 支持 |
| type=3 JavaScript Spider | 支持部分常见形态 |
| Drpy 规则 | 支持声明式规则与受控动态能力 |
| T4 服务 | 支持常见 HTTP / HTTPS T4 服务 |
| XYQ / XBPQ | 支持高频规则形态 |
| Alist | 支持 v2 / v3 的基础目录、搜索和播放能力 |
| Android Dex / JAR Spider | 暂不支持，会明确提示不可用 |
| 直播 / EPG / DLNA | 暂未作为当前版本重点能力 |

---

## 使用注意

- 本项目 **不内置、不分发、不提供任何影视内容或播放源**；
- 用户需要自行导入自己合法拥有或有权访问的配置；
- 不同播放源的稳定性、清晰度、速度和可用性由来源本身决定；
- macOS 和 Windows 安装包当前未配置商业代码签名，首次打开时系统可能出现安全提示；
- 某些特殊格式、私有协议或受保护媒体可能需要更换线路、换源或使用外部播放器兜底。

---

## 开发者入口

如果你想本地运行或参与开发，可以使用下面的命令：

```bash
npm ci
npm run typecheck
npm test
npm run dev
```

打包命令：

```bash
# macOS DMG
npm run package:dmg

# Windows 安装版与便携版
npm run package:win

# Linux AppImage 与 DEB
npm run package:linux
```

环境要求：

- Node.js `>= 22.13.0`；
- Electron `43.2.0`；
- macOS / Windows / Linux 桌面环境。

更多实现细节可查看：

- [`REQUIREMENTS.md`](REQUIREMENTS.md)：需求说明；
- [`TECHNICAL_DESIGN.md`](TECHNICAL_DESIGN.md)：技术设计；
- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)：实现状态；
- [`docs/RELEASE.md`](docs/RELEASE.md)：发布说明；
- [`docs/待完成事项与优先级.md`](docs/待完成事项与优先级.md)：后续计划。

---

## 版本状态

当前版本：`v0.1.0`

这是 OKPlayer 的第一个跨平台公开版本，已经完成基础播放闭环和多平台安装包发布。后续会继续优化品牌命名、安装体验、真实平台回归、播放兼容性和更多桌面端体验细节。

---

## 免责声明

OKPlayer 只是一个播放器和配置兼容工具，不提供内容源，也不对第三方配置中的内容、可用性或合法性负责。请遵守你所在地区的法律法规，只使用你合法拥有或有权访问的内容与服务。
