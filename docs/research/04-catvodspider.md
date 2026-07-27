# FongMi CatVodSpider 实现分析

仓库：<https://github.com/FongMi/CatVodSpider>

上游：<https://github.com/CatVodTVOfficial/CatVodTVSpider>

## 1. 项目定位

CatVodSpider 是 Android TVBox/FongMi Spider 生态的重要实现仓库。

仓库包含：

```text
app/
jar/
json/
Gradle 工程
```

它不是一个可直接嵌入 macOS 的 Provider Runtime，而是：

- Android Spider 开发参考；
- `csp_*` 约定来源；
- JAR/Dex 产物构建来源；
- 站点源码迁移素材。

## 2. 核心方法模型

CatVod Spider 通常围绕以下能力：

```text
init
homeContent
homeVideoContent
categoryContent
searchContent
detailContent
playerContent
proxy
destroy
```

当前项目的 SourceAdapter 应尽可能保持这些语义，即使底层实现不是 Java。

## 3. Android 依赖问题

很多 Spider 会依赖：

- Android Context；
- OkHttp 或 Android 网络封装；
- WebView；
- Android 工具类；
- DexClassLoader；
- JNI `.so`；
- 设备信息；
- 存储和 Cookie。

因此，不应将“有 Java 源码”直接等同于“可以迁移”。

## 4. Spider 迁移分类

### A 类：容易迁移

特征：

- 普通 HTTP；
- HTML/JSON 解析；
- 简单哈希；
- 无 Android Context；
- 无 WebView；
- 无 JNI。

适合改为 TypeScript/JavaScript Provider。

### B 类：中等难度

特征：

- 依赖 Android 工具类，但算法普通；
- 使用 AES/RSA/MD5；
- Cookie 和签名可以复现；
- 有简单动态脚本。

适合重写为 JS Worker。

### C 类：不适合迁移

特征：

- 加固 Dex；
- JNI `.so`；
- 设备指纹；
- ARM 原生算法；
- 强依赖 Android WebView；
- 动态下发代码。

`csp_NewWoggGuard` 属于 C 类。

## 5. 对当前项目的正确使用方式

CatVodSpider 应作为：

```text
迁移知识库
```

工作流：

```text
找到 csp_* 对应实现
    ↓
检查是否依赖 Android/JNI
    ↓
A/B 类：迁移到 JS Provider
C 类：标记 Android-only
```

## 6. 可复用内容

- 方法命名；
- Vod JSON 字段；
- 线路和剧集格式；
- Header 处理；
- proxy 约定；
- `ext` 初始化参数；
- 分类筛选参数；
- playerContent 返回模型。

## 7. 不建议做的事情

- 不要将 Dex 转成 JAR 后直接在 Node/JVM 执行；
- 不要在 Electron 主进程内加载不可信 Java；
- 不要为了兼容一个 Spider 内嵌 Android；
- 不要默认认为所有 `csp_*` 都有网页 API；
- 不要复制来源和授权不清晰的站点实现进入产品。

## 8. 后续跟进任务

- [ ] 建立 `csp_*` 兼容分析模板；
- [ ] 每个高频源标记 A/B/C 类；
- [ ] 定位未加固上游源码；
- [ ] 建立 CatVod 返回结构测试样本；
- [ ] 建立 Provider 合规和来源登记；
- [ ] 对 NewWoggGuard 只保留 Android-only 结论，除非找到公开 JS/T4 实现。
