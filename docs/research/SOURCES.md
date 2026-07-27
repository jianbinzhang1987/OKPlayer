# 调研来源

核验日期：2026-07-26

## 官方 GitHub 仓库

1. zyfun  
   <https://github.com/Hiram-Wong/zyfun>

2. TV-Multiplatform  
   <https://github.com/Greatwallcorner/TV-Multiplatform>

3. TVBox-Swift  
   <https://github.com/Jstrom2022/tvbox-Swift>

4. FongMi CatVodSpider  
   <https://github.com/FongMi/CatVodSpider>

5. CatVodTVSpider 上游  
   <https://github.com/CatVodTVOfficial/CatVodTVSpider>

6. hipy-server  
   <https://github.com/hjdhnx/hipy-server>

7. LunaTV  
   <https://github.com/MoonTechLab/LunaTV>

## 关键核验事实

### zyfun

- Electron 跨平台桌面应用；
- README 声明支持 T1-T4；
- 公开数据结构列出 T0_XML、T1_JSON、T4_DRPYS、T3_DRPY、T4_CATVOD、T3_XBPQ、T3_XYQ、T3_APPYSV2、T3_PY、T3_ALIST；
- macOS 支持 x64/arm64；
- AGPL-3.0。

### TV-Multiplatform

- Kotlin Compose Desktop；
- 动态加载为项目定制的 Java Spider JAR；
- 当前只支持 Java；
- 理论支持 macOS，但主要在 Windows 测试；
- GPL-3.0。

### TVBox-Swift

- SwiftUI + SwiftData；
- macOS/iOS；
- 支持 type=0/1/4；
- 明确不支持 type=3 Spider/JAR；
- MIT。

### CatVodSpider

- Android Gradle 工程；
- 包含 app、jar、json；
- 基于 CatVod；
- 用于研究 Spider 语义和迁移，不代表 macOS 可执行。

### hipy-server

- Python、FastAPI、Redis、SQLAlchemy、多数据库、Playwright；
- T4 服务后端；
- GPL-3.0。

### LunaTV

- Next.js、Tailwind、TypeScript；
- HLS.js、ArtPlayer；
- Docker 部署；
- 聚合搜索、收藏、历史；
- 非商业和相同方式共享的许可证声明。

## 内置播放器与 HLS 官方来源

8. Electron `protocol`  
   <https://www.electronjs.org/docs/latest/api/protocol>

9. Electron 43 发行信息  
   <https://releases.electronjs.org/release/v43.0.0>

10. Chromium：默认全平台启用 HLS 直接播放  
    <https://chromium.googlesource.com/chromium/src/media/+/858ef4647f8067fa2701583d4b77b9b9cd797219>

11. HLS.js  
    <https://github.com/video-dev/hls.js>

### 内置播放器核验事实

- Electron 自定义协议可注册为标准、安全和流式协议，并通过 `protocol.handle()` 返回 `Response`；
- Electron 43 使用 Chromium 150；
- Chromium 在 2025-10-21 提交了默认全平台启用 HLS 直接播放的变更；
- HLS.js 基于 Media Source Extensions，Apache-2.0，当前稳定版本为 1.6.16；
- 因此当前项目优先升级 Electron 运行内核，HLS.js 作为真实失败样本驱动的后备方案。
