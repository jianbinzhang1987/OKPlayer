# zyfun 实现分析

仓库：<https://github.com/Hiram-Wong/zyfun>

许可证：AGPL-3.0

## 1. 项目定位

zyfun 是目前调研中最接近当前项目目标的实现：

- Electron 跨平台桌面客户端；
- macOS、Windows、Linux；
- 支持 T1～T4 多种资源；
- 包含影视、直播、历史、播放等完整桌面功能；
- 通过适配器区分不同规则和源类型。

官方 README 将其描述为“一站式管理 T1-T4 全类型资源”的跨平台影音管理工具，并明确提供 macOS x64/arm64 构建。

## 2. 技术架构

从仓库结构可以确认其采用：

```text
Electron
├── 主进程
├── Renderer
├── Preload
├── packages
├── 插件和二进制目录
└── electron-builder
```

关键工程化特征：

- Electron + TypeScript；
- 独立的 main/web TypeScript 配置；
- electron-builder 打包；
- 多包或 workspace 结构；
- 独立测试目录；
- macOS 下维护应用数据目录和二进制目录。

## 3. 适配器体系

zyfun 的数据结构公开列出了多种适配器：

```text
type=0   T0_XML
type=1   T1_JSON
type=6   T4_DRPYS
type=7   T3_DRPY
type=8   T4_CATVOD
type=9   T3_XBPQ
type=10  T3_XYQ
type=11  T3_APPYSV2
type=12  T3_PY
type=13  T3_ALIST
```

这说明它并未试图将所有 `type=3` 都解释为 Android JAR，而是继续细分运行时。

这正是当前项目应该借鉴的重点：

```text
SiteConfig
    ↓ capability detection
SourceAdapterFactory
    ├── CmsAdapter
    ├── DrpyAdapter
    ├── CatVodT4Adapter
    ├── PythonAdapter
    ├── AlistAdapter
    └── UnsupportedAndroidDexAdapter
```

## 4. drpy 与 Worker 机制

从发布说明可以确认：

- drpy 执行使用 Worker；
- 有初始化缓存；
- 处理 `atob`、`withHeaders` 等兼容问题；
- 网络请求可放到子进程；
- macOS 下子进程网络请求有性能优化；
- 支持数据源检测和错误日志。

对当前项目的启发：

1. JS 规则不能长期放在 Electron 主进程中直接执行；
2. 每个 Provider 应有隔离 Worker；
3. 网络请求、Cookie、缓存应由宿主统一管理；
4. Provider 初始化需要缓存和淘汰策略；
5. 规则执行错误必须返回明确的站点与方法信息。

## 5. Python Provider

zyfun 已经支持 T3Py：

- 需要 Python 运行环境；
- 通过独立进程执行；
- 涉及虚拟环境、PID、端口和进程退出管理；
- 修复记录显示 Python 子进程和 ZMQ/端口管理是主要复杂点。

因此，当前项目不应第一阶段直接内嵌完整 Python 生态。

更合理的方式：

```text
第一阶段：仅支持用户配置外部 Python Provider 服务
第二阶段：提供可选本地 Python Runtime
第三阶段：再考虑应用内自动安装依赖
```

## 6. 网页嗅探

zyfun 的发布记录明确出现：

- WebView；
- 嗅探播放页；
- 自动识别视频类型；
- 多播放器融合；
- Web 解析脚本；
- iframe 嗅探方案曾被移除，因为限制较多。

启示：

1. 不应该只做一个简单 `webRequest` 监听；
2. 需要独立嗅探窗口或 Session；
3. 要处理 Cookie、Referer、UA、重定向；
4. 应过滤广告和小媒体资源；
5. 需要超时、用户取消和候选地址排序；
6. iframe 方案不能作为唯一嗅探方式。

## 7. 播放器体系

zyfun 使用多播放器统一抽象，支持：

- HLS/Web 播放器；
- 不同播放器导入样式；
- 请求头格式化；
- 去广告；
- 下一集；
- 历史记录。

当前项目已经采用 mpv，因此建议继续保持：

```text
ResolvedMedia
    ↓
PlayerService
    ├── mpv
    ├── Web Player（可选）
    └── External Player（可选）
```

不需要照搬其全部播放器实现，但应借鉴统一播放器接口。

## 8. 数据和插件目录

README 明确给出 macOS 路径：

```text
~/Library/Application Support/zyfun/
~/.zy/bin/
```

说明其将：

- 数据库；
- 配置；
- 插件；
- 日志；
- 外部二进制；

与应用安装包分离。

当前项目也应采用类似策略：

```text
Application Support/fongmi-macos/
├── database/
├── providers/
├── cache/
├── logs/
├── browser/
└── binaries/
```

## 9. 优点

- 与当前 Electron 技术栈高度一致；
- Provider 类型最丰富；
- 已处理 macOS 和 Windows 差异；
- 有真实用户规模和长期提交历史；
- 支持 T3/T4、drpy、Python、Alist、直播；
- 有完整打包和更新经验。

## 10. 不适合直接复制的部分

- AGPL-3.0 对闭源或商业分发约束较强；
- 代码规模已经较大；
- 多种 Provider 同时存在，复杂度高；
- 部分功能与当前最小业务闭环无关；
- 它也没有证明可以直接执行任意 Android Dex/JAR。

## 11. 建议复用方式

建议“研究设计，不直接复制源码”：

1. 借鉴 Adapter 类型划分；
2. 借鉴 Worker/子进程隔离；
3. 借鉴 Provider 缓存与日志；
4. 借鉴 macOS 数据目录；
5. 借鉴 Web 嗅探候选媒体筛选；
6. 借鉴 T4、drpy 和 Python 的分层方式。

## 12. 后续跟进任务

- [ ] 克隆仓库并定位适配器工厂；
- [ ] 找到 T3Drpy 的 Worker 实现；
- [ ] 找到 T4CatVod 的 HTTP 调用规范；
- [ ] 找到 WebView 嗅探事件过滤规则；
- [ ] 找到 Python 子进程生命周期管理；
- [ ] 梳理可独立借鉴但不受 AGPL 污染的设计思想；
- [ ] 输出当前 AppService 到 zyfun Adapter 的字段映射。
