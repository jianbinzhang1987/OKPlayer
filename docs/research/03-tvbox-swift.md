# TVBox-Swift 实现分析

仓库：<https://github.com/Jstrom2022/tvbox-Swift>

许可证：MIT

## 1. 项目定位

TVBox-Swift 使用 Swift、SwiftUI 和 SwiftData 构建，同时支持 macOS 14+ 与 iOS 17+。

其设计明确接受一个边界：

```text
支持 type=0/1/4
不支持 type=3 Spider/JAR
```

这与当前项目对 Android Dex/JAR 的判断一致。

## 2. 技术架构

```text
SwiftUI
├── macOS / iOS 共用视图
├── 网络解析
├── SwiftData
├── AVPlayer
└── VLCKit
```

## 3. 数据源能力

官方 README 列出：

- type=0 XML；
- type=1 JSON；
- type=4 Remote；
- JSON/XML 容错；
- 详情、历史、收藏；
- 基础直播；
- 分类和搜索。

它不支持：

- Java/Rhino；
- type=3；
- 完整嗅探；
- Android JAR。

## 4. 播放器实现

采用：

- AVPlayer；
- VLCKit；
- 双引擎切换。

与当前 mpv 路线相比：

| 方案 | 优点 | 缺点 |
|---|---|---|
| AVPlayer | 原生、签名友好 | 格式和 Header 控制有限 |
| VLCKit | 格式丰富 | 包体和依赖较重 |
| mpv | 网络媒体和控制能力强 | 外部二进制与签名复杂 |

当前项目没有必要切换到 Swift/VLCKit，但可以参考播放器能力降级策略：

```text
优先 mpv
失败时外部播放器
未来可增加 Web/HLS 播放器
```

## 5. 配置容错

README 对比 Android 版时指出，Swift 版目前只支持常规 URL 和注释容错，而 Android 版还有：

- 加密配置；
- clan://；
- 相对路径；
- 独立直播配置。

这可作为当前配置模块的补充检查清单。

## 6. UI 借鉴价值

适合参考：

- macOS 侧边栏；
- 详情页布局；
- 毛玻璃和暗色主题；
- iOS/macOS 自适应；
- 收藏与历史入口。

不适合直接借鉴：

- Swift 技术栈；
- SwiftData；
- AVPlayer 业务层。

## 7. 优点

- MIT，设计借鉴风险低；
- 真正面向 macOS；
- 平台 UI 体验好；
- 明确源兼容边界；
- 有 DMG/打包脚本。

## 8. 缺点

- 源类型较少；
- 不支持 type=3；
- 解析链路不完整；
- 字幕、EPG 等能力仍有限；
- 与当前 Electron 代码无法直接复用。

## 9. 对当前项目的价值

主要用于：

1. UI 和交互参考；
2. macOS 打包流程；
3. type=0/1/4 容错测试；
4. 明确“不支持 Android JAR”是合理产品边界。

## 10. 后续跟进任务

- [ ] 对比其 XML/JSON 容错规则；
- [ ] 对比 macOS 页面结构；
- [ ] 研究 DMG 脚本；
- [ ] 研究 AVPlayer/VLCKit 降级逻辑；
- [ ] 记录其不支持项，作为我们的能力差异表。
