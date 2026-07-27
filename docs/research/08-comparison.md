# 开源实现横向对比

## 1. 总表

| 项目 | 平台 | 源运行时 | Android JAR | 浏览器能力 | 适合借鉴程度 |
|---|---|---|---|---|---|
| zyfun | Electron 桌面 | T1-T4、drpy、Python 等 | 不等同于直接兼容任意 Dex/JNI | 有 | 最高 |
| TV-Multiplatform | Kotlin 桌面 | 定制 Java JAR | 仅桌面 JVM JAR | TODO/WebView | 中 |
| TVBox-Swift | macOS/iOS | type=0/1/4 | 不支持 | 弱 | UI 高、引擎低 |
| CatVodSpider | Android | Dex/JAR/JNI | 原生支持 | Android WebView | 迁移研究高 |
| hipy-server | 服务端 | Python/T4/Playwright | 不支持 Android JNI | 强 | T4 高 |
| LunaTV | Web/Docker | 标准资源 API | 不支持 | Web 本身 | UI/播放器中 |

## 2. 按问题选择参考项目

### 桌面 Adapter 架构

首选：

```text
zyfun
```

### 桌面 Java 插件

首选：

```text
TV-Multiplatform
```

### macOS 原生 UI

首选：

```text
TVBox-Swift
```

### CatVod 方法语义和源迁移

首选：

```text
FongMi/CatVodSpider
```

### T4、Python、Playwright

首选：

```text
hipy-server
```

### Web 播放器和聚合搜索

首选：

```text
LunaTV
```

## 3. 对当前项目的选型结论

不建议：

```text
直接兼容任意 Android Dex/JAR
内嵌完整 Android 模拟器
一次性支持所有规则语言
直接复制大型 GPL/AGPL 项目
```

建议：

```text
统一 SourceAdapter 接口
        ↓
能力识别
        ├── HTTP/XML/JSON
        ├── JS Spider
        ├── T4
        ├── Drpy
        ├── Browser Sniffer
        ├── Python Sidecar（后期）
        └── Android-only 明确禁用
```

## 4. 许可证提醒

| 项目 | 许可证/声明 | 建议 |
|---|---|---|
| zyfun | AGPL-3.0 | 研究设计，谨慎复制 |
| TV-Multiplatform | GPL-3.0 | 研究设计，谨慎复制 |
| TVBox-Swift | MIT | 可借鉴程度较高 |
| hipy-server | GPL-3.0 | 优先通过外部服务对接 |
| LunaTV | CC BY-NC-SA/禁止商业化 | 不复制源码 |
| CatVodSpider | 仓库页未明确许可证 | 不直接复制未知授权代码 |

## 5. 最值得落地的三个能力

### 第一：T4Adapter

投入较小，能快速接入 hipy 等服务。

### 第二：DrpyAdapter

能替代一部分 Android JAR，符合纯 macOS 路线。

### 第三：BrowserSnifferAdapter

解决动态页面、解析页和临时媒体地址。

## 6. 结论

当前产品不应追求“配置导入后 100% 兼容”，而应追求：

```text
准确识别
明确提示
高价值源可用
运行时可扩展
失败可诊断
```
