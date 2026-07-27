# TV-Multiplatform 实现分析

仓库：<https://github.com/Greatwallcorner/TV-Multiplatform>

许可证：GPL-3.0

## 1. 项目定位

这是基于 FongMi/TV 思路实现的桌面客户端，使用 Kotlin Compose Multiplatform，但当前主要使用桌面端能力。

官方 README 明确说明：

- 动态加载 JAR 获取数据；
- Spider 必须是为该项目定制的版本；
- 当前只支持 Java Spider；
- 不计划支持 JS 和 Python；
- 理论支持 Windows、Linux、macOS，但主要在 Windows 测试；
- 内部播放器依赖 VLC，也可调用 mpv 等外部播放器。

## 2. 核心架构

```text
Compose Desktop
├── UI
├── 配置
├── Java Spider Loader
├── 搜索/详情模型
├── 内部 VLC
└── 外部播放器
```

核心价值不在于兼容 Android JAR，而在于证明：

> 桌面客户端可以定义一套桌面 Java Spider ABI，通过标准 JVM 动态加载。

## 3. JAR 兼容的真实边界

它所说的 JAR 与 TVBox Android Dex/JAR 不是同一个概念。

桌面 Java JAR 通常包含：

```text
.class
标准 JVM 依赖
桌面兼容网络库
```

当前真实配置中的插件包含：

```text
classes.dex
Android Context 依赖
Android ARM .so
```

因此 TV-Multiplatform 的 JAR Loader 不能直接解决 `csp_NewWoggGuard`。

## 4. 可借鉴的能力

### 4.1 Desktop Java Provider 标准

可以在当前项目中新增可选 Provider：

```text
runtime=desktop-java
jar=https://...
entryClass=...
```

但它只能服务于专门编译的桌面插件。

### 4.2 插件生命周期

应包含：

- 下载；
- 校验；
- 缓存；
- 版本切换；
- 加载；
- 初始化；
- 释放；
- 错误隔离。

### 4.3 外部播放器

其通过命令行调用 mpv/VLC 的思路与当前 mpv 方案一致。

### 4.4 搜索分页和多源策略

README 的 TODO 提到：

- 默认只搜索少量源；
- 无结果时继续搜索；
- 用户手动加载更多。

这个策略比一次性并发所有源更适合真实配置。

## 5. 优点

- 桌面 TVBox 业务闭环完整；
- Kotlin 模型比较接近原 Android 项目；
- Java Spider ABI 清晰；
- 外部播放器集成思路简单；
- 适合研究桌面插件管理。

## 6. 缺点

- Java-only；
- 不支持 JS 和 Python；
- macOS 实测不足；
- 定制 Spider 生态规模有限；
- GPL-3.0；
- 无法运行 Android DEX/JNI。

## 7. 对当前项目的价值

建议将其作为：

```text
Desktop Java Provider 可选扩展参考
```

而不是当前主路线。

优先级低于：

1. DrpyAdapter；
2. T4Adapter；
3. BrowserSnifferAdapter；
4. JS Spider Worker。

## 8. 后续跟进任务

- [ ] 定位动态 JAR Loader；
- [ ] 梳理 Spider Java 接口；
- [ ] 研究 JAR 版本和缓存机制；
- [ ] 验证其 macOS 构建；
- [ ] 判断是否值得增加 DesktopJavaAdapter；
- [ ] 不与 Android Dex/JAR 兼容需求混淆。
