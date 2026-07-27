# macOS 多 Provider 运行时设计方案

> 文档版本：v0.1  
> 文档状态：核心多 Provider 运行时已完成 MVP  
> 编写日期：2026-07-26  
> 目标工程：`/Users/adolf/Desktop/code/TV/mac`  
> 重点参考：zyfun 的多 Adapter、Worker 隔离、运行时缓存和播放嗅探设计

---

## 0. 实施进度

截至 2026-07-26，核心多 Provider MVP 已完成：

- 通用 `csp_*` 与具体 Android Dex Spider 分层识别；
- AppYsV2、XYQ、XBPQ 已接入本地 Adapter；
- 配置加载器支持对象型 `ext`，满足大量 XBPQ 配置的导入需求；
- XYQ 支持远程/内联宽松规则、HTML/JSON、GET/POST 搜索、详情、线路和剧集；
- XBPQ 支持对象/远程规则、字符串截取修饰、二次截取、详情、线路和剧集；
- CatOpen 已采用独立 Node 子进程、VM 沙箱和受控宿主 API，不在 Electron 主进程直接运行远程 Provider；
- CatOpen 支持首页、分类、搜索、详情、播放和代理，并对网络、响应大小、执行时间和资源导入进行限制；
- Alist v2/v3 已接入，支持目录列表、目录导航、搜索、目录密码、可选登录和文件直链；
- 核心模型保留 `folder/file/action` 标签，Renderer 可直接进入 Alist 下级目录；
- 新增按源配置 SHA-256 Hash 复用的 ProviderManager，支持容量为 10 的 LRU 淘汰和 `destroy()` 生命周期；
- 新增配置兼容审计 CLI，输出运行时分布、兼容率、已应用替代 Provider、Android-only 清单及不可用原因；
- 新增批量配置审计，支持并发加载、失败隔离、运行时汇总，以及按 API 出现次数和配置覆盖数生成 Android-only 排名；
- ProviderReplacementRegistry 已接入 Adapter 工厂，支持精确 API、可选 JAR MD5、启停、来源/许可证/验证日期和能力裁剪；
- 替代 Adapter 保留原站点 key/name，并在播放源页面展示替代来源和许可证；
- 设置页支持导入本地或远程注册表，来源持久化到 SQLite，启动时自动恢复；加载或清除后即时销毁并重建当前 Provider，失败时回滚；
- 默认替代注册表保持为空，不启用未经验证的映射；
- HTML 选择器补充 `:has`、`:not(:has)`、`:lt` 和 `:gt` 高频兼容能力；
- 配置加载与 Android `csp_*` 兜底识别均支持大小写变体；
- 配置加载器支持 BOM、注释、尾逗号和常见 JSON5 写法，并可识别、递归展开影视仓顶层 `urls` 多仓索引；
- Drpy/CatOpen 网络安全策略兼容 Clash/TUN Fake-IP，同时继续阻断直接私网地址和真实 DNS 私网解析；
- Drpy 增加通用远程引擎指纹、整体 Base64 规则、`play_url` 与 URL 编码宿主变量；
- 播放准备阶段支持网页地址自动嗅探、直链媒体签名验证和 404/HTML 失效线路阻断；
- 四个直连公开配置共 506 个站点中识别 301 个；非凡、尤酷、极速抽样 HLS 通过内容验证，非凡完成内置播放会话闭环；
- 类型检查、95 项自动化测试、生产构建、CatOpen Worker IPC、单配置和批量兼容审计 CLI 均通过。

下一阶段重点转向定期在线复测、失败站点方言补充、候选替代实现验证和首批默认注册表条目。

---

## 1. 背景

当前 macOS 客户端已经支持：

- `type=0/1` HTTP/XML/JSON 播放源；
- JavaScript Spider；
- Drpy 规则；
- T4 HTTP 服务；
- 浏览器媒体嗅探；
- macOS 内置播放器及兼容播放模式。

当前存在的主要兼容性问题是：配置中大量 `type=3`、`api=csp_*` 的站点被统一识别为 `android-dex`，随后直接标记为不可用。

这一判断对 `csp_NewDouBanGuard`、`csp_NewWoggGuard` 等强依赖 Android Context、Dex、JNI 或加固逻辑的具体 Spider 是合理的，但对以下通用规则解释器并不准确：

```text
csp_XBPQ
csp_XYQ
csp_XYQHiker
csp_AppYsV2
csp_Alist
csp_Drpy
csp_Drpy2
```

这类 `csp_*` 名称虽然来自 Android CatVod 生态，但其业务能力可以在 macOS 上通过 TypeScript、JavaScript Worker、HTTP 服务或独立子进程重新实现，并不要求执行原始 Android Dex。

因此，本方案将问题重新定义为：

> 不追求在 macOS 进程内执行任意 Android Dex/JAR，而是建立多 Provider 运行时，最大范围兼容 TVBox/CatVod 配置所表达的首页、分类、搜索、详情、线路、剧集和播放解析能力。

---

## 2. 设计目标

### 2.1 核心目标

1. 扩大公开 TVBox/CatVod 配置在 macOS 客户端中的实际可用比例；
2. 避免将所有 `csp_*` 站点误判为 Android 专用源；
3. 在现有 `SourceAdapter` 架构上扩展，不推翻当前工程；
4. 将第三方规则和脚本与 Electron 主进程隔离；
5. 将不同运行时的结果统一为现有业务模型；
6. 将播放地址、请求头、脚本和嗅探参数完整传递给播放解析链；
7. 对真正依赖 Android Dex/JNI 的站点保留明确、可解释的降级状态；
8. 为后续定向迁移高价值具体 Spider 预留兼容注册机制。

### 2.2 非目标

本阶段不实现：

- 通用 Dalvik/ART 虚拟机；
- 通用 Dex 字节码解释器；
- Android Framework 完整模拟；
- Android JNI/Bionic ABI 模拟；
- 任意加固 Dex 的自动反编译和迁移；
- 内嵌完整 Android 模拟器；
- 自动导入未经验证的公开接口进入产品默认源列表。

---

## 3. 参考 zyfun 得出的关键结论

zyfun 的核心做法不是“模拟 Android”，而是将来源拆分为多个独立 Adapter：

```text
T0 XML
T1 JSON
T3 Drpy
T3 XBPQ
T3 XYQ
T3 AppYsV2
T3 CatOpen
T3 Python
T3 Alist
T4 Drpys
T4 CatVod
```

其主要设计特点包括：

1. **明确的运行时类型**：不通过 `csp_*` 一个条件判断全部来源；
2. **统一 CMS 接口**：不同 Adapter 最终实现相同业务方法；
3. **Worker/子进程隔离**：Drpy 和 CatOpen 不在主进程直接运行；
4. **宿主能力注入**：为规则提供请求、HTML 解析、存储和加解密方法；
5. **Adapter 缓存**：以源配置 Hash 作为缓存失效依据；
6. **生命周期管理**：初始化、复用、淘汰和销毁形成闭环；
7. **标准播放结果**：除 URL 外，还可返回 Header、清晰度、解析标志和嗅探脚本；
8. **CDP 嗅探兜底**：对网页播放地址执行浏览器媒体请求监听；
9. **完整链路检测**：不只检查接口是否能访问，而是检查搜索、详情和播放链路。

本项目应借鉴上述架构和协议思想，但不直接复制 zyfun 的具体实现代码。zyfun 使用 AGPL-3.0，若直接复制源码，需要单独评估开源义务和分发模式。

---

## 4. 总体设计原则

### 4.1 兼容能力，不兼容交付文件

配置中的 Dex/JAR、JS、JSON 或远程地址只是 Provider 的交付方式。客户端真正需要的是：

```text
首页
分类
筛选
搜索
详情
线路
剧集
播放解析
代理
交互动作
```

因此运行时识别应优先回答：

> 当前站点的业务能力可以由哪一种 macOS 可执行 Provider 提供？

而不是：

> 当前站点是不是配置了 Android JAR？

### 4.2 配置协议与执行运行时解耦

同一个 TVBox 配置项：

```json
{
  "type": 3,
  "api": "csp_XBPQ",
  "ext": "https://example.com/rule.json"
}
```

在 Android 上可以由 Java 类 `csp_XBPQ` 解释，在 macOS 上可以由本地 `XbpqAdapter` 解释。

配置协议保持兼容，但执行运行时由客户端重新选择。

### 4.3 第三方代码默认不可信

远程 JavaScript、Drpy 和 CatOpen Provider 应视为不可信代码：

- 不在 Electron 主进程执行；
- 默认禁止任意文件系统访问；
- 默认禁止启动系统进程；
- 网络请求由宿主统一代理；
- 设置执行超时；
- 可强制销毁异常进程；
- 日志带站点、运行时和操作信息。

### 4.4 统一模型优先

所有 Adapter 无论底层实现如何，必须先转换为统一业务模型，再进入 UI、搜索聚合和播放器。

不允许 Renderer 层针对不同 Provider 编写大量分支。

---

## 5. 目标总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                     Renderer / Vue UI                       │
│ 首页、分类、搜索、详情、播放、设置、源状态                   │
└──────────────────────────────┬──────────────────────────────┘
                               │ IPC
┌──────────────────────────────▼──────────────────────────────┐
│                         AppService                          │
│ Config / Search / Detail / Resolve / History / Settings    │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    ProviderManager                          │
│ RuntimeResolver / AdapterFactory / Cache / Health / Logs    │
└───────────┬──────────────┬──────────────┬──────────────┬─────┘
            │              │              │              │
┌───────────▼──────┐ ┌─────▼────────┐ ┌──▼───────────┐ ┌▼──────────────┐
│ Direct Adapters  │ │ Rule Adapters│ │ Script Runtime│ │ Remote Runtime│
│ HTTP/XML/JSON    │ │ XBPQ / XYQ   │ │ Drpy/CatOpen │ │ T4/Sidecar    │
│ AppYsV2/Alist    │ │ 声明式解析    │ │ Child Process│ │ HTTP Provider │
└───────────┬──────┘ └─────┬────────┘ └──┬───────────┘ └┬──────────────┘
            └──────────────┴──────────────┴──────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                 Unified Provider Result                    │
│ Home / List / Detail / Play / Action / Proxy               │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                   Playback Resolver Chain                   │
│ Direct → Header Proxy → Parse → CDP Sniffer → Compatibility│
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                     Embedded Player                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 运行时类型设计

建议将当前 `SourceRuntime` 从：

```typescript
"http" | "javascript" | "drpy" | "t4" | "android-dex" | "unknown"
```

扩展为：

```typescript
type SourceRuntime =
  | "http"
  | "javascript"
  | "drpy"
  | "catopen"
  | "xbpq"
  | "xyq"
  | "appysv2"
  | "alist"
  | "t4"
  | "python-remote"
  | "android-dex"
  | "replacement"
  | "unknown";
```

首期真正落地时不必一次实现全部运行时，但类型和识别流程应预留完整。

### 6.1 运行时优先级

运行时识别顺序建议如下：

```text
1. 用户显式指定 runtime
2. ProviderReplacementRegistry 精确替代映射
3. 已知 csp 通用别名映射
4. type + api + ext 组合识别
5. ext 内容指纹识别
6. HTTP/T4 地址识别
7. 具体 csp_* + JAR/Dex 判定为 android-dex
8. unknown
```

关键点是：

> `api.startsWith("csp_")` 必须放到通用别名和规则内容识别之后，不能继续作为优先判断条件。

---

## 7. RuntimeResolver 设计

建议新增：

```text
src/core/runtime-resolver.ts
```

职责：

- 综合分析 `type`、`api`、`ext`、`jar`；
- 识别通用 `csp_*` 解释器；
- 检查替代 Provider 注册表；
- 必要时加载少量远程规则头部进行内容指纹判断；
- 返回运行时、能力、置信度和识别依据；
- 不负责创建 Adapter。

建议结果模型：

```typescript
interface RuntimeResolution {
  runtime: SourceRuntime;
  supported: boolean;
  confidence: "explicit" | "exact" | "heuristic" | "fallback";
  reason: string;
  matchedBy:
    | "user-runtime"
    | "replacement-registry"
    | "api-alias"
    | "type-api-ext"
    | "ext-fingerprint"
    | "android-dex"
    | "unknown";
  normalizedApi?: string;
  normalizedExt?: string;
  replacement?: ProviderReplacement;
  capabilities: SourceCapabilities;
}
```

### 7.1 通用 CSP 别名

```typescript
const CSP_RUNTIME_ALIASES: Record<string, SourceRuntime> = {
  csp_xbpq: "xbpq",
  csp_xyq: "xyq",
  csp_xyqhiker: "xyq",
  csp_appysv2: "appysv2",
  csp_alist: "alist",
  csp_drpy: "drpy",
  csp_drpy2: "drpy",
};
```

别名匹配应：

- 忽略大小写；
- 允许已知后缀变体；
- 记录识别依据；
- 不使用模糊包含匹配替代精确匹配，防止将具体 Spider 误识别为通用解释器。

### 7.2 ext 内容指纹

可识别的典型特征：

| Runtime | ext 特征示例 |
|---|---|
| Drpy | `rule = {}`、`host`、`一级`、`二级`、`搜索`、动态 `js:` |
| XBPQ | `分类url`、`数组`、`标题`、`链接`、`播放数组` 等字段 |
| XYQ | `分类名称`、`分类链接`、`请求头参数`、`首页列表数组规则` |
| AppYsV2 | ext 为 App API 根地址，接口呈现 `/types`、`/nav` 等特征 |
| CatOpen | api 为 JS 模块，导出 `init/home/category/detail/play/search` |
| T4 | api 为 HTTP 服务，满足约定端点或请求参数 |

远程内容指纹检测应限制：

- 最大读取字节数；
- 连接和读取超时；
- 禁止自动访问内网地址；
- 不执行远程脚本；
- 结果缓存；
- 识别失败不阻塞配置载入。

---

## 8. ProviderReplacementRegistry 设计

针对 `csp_NewDouBanGuard` 等具体 Android Spider，不应简单映射为某个通用运行时，而应建立替代 Provider 注册表。

建议新增：

```text
src/core/provider-replacement-registry.ts
```

数据模型：

```typescript
interface ProviderReplacement {
  match: {
    api: string;
    jarHash?: string;
    configHost?: string;
  };
  replacement: {
    runtime: SourceRuntime;
    api?: string;
    ext?: string;
  };
  capabilities: Partial<SourceCapabilities>;
  source: {
    name: string;
    repository?: string;
    license?: string;
    verifiedAt?: string;
  };
  notes?: string;
}
```

注册表用于表达：

```text
原配置要求某具体 Android Spider
        ↓
已确认存在公开、可维护、授权清晰的替代实现
        ↓
改由本地 CatOpen / Drpy / T4 / 专用 Adapter 执行
```

### 8.1 注册原则

一个替代 Provider 进入默认注册表前，必须确认：

- 功能边界是否一致；
- 是否只负责元数据，还是同时负责播放；
- 开源许可证是否允许当前使用方式；
- 是否包含硬编码不稳定接口；
- 是否依赖用户 Cookie 或登录；
- 是否通过真实配置回归测试；
- 是否可以随时禁用和撤回。

### 8.2 NewDouBanGuard 的处理原则

`csp_NewDouBanGuard` 当前先保持 `android-dex` 状态，不做未经验证的强行映射。

后续分析时按能力拆分：

```text
豆瓣推荐与榜单
豆瓣元数据与评分
影片搜索
播放来源搜索
播放地址解析
```

如果它只负责推荐和元数据，可以由 `DoubanMetadataProvider` 替代，并让播放来源由其他站点搜索完成，不要求一对一复刻原 Spider。

---

## 9. 统一 Adapter 接口

当前 `SourceAdapter` 已经具备良好基础，建议补充 `homeVod`、`action` 和标准播放脚本信息。

目标接口：

```typescript
interface SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime: SourceRuntime;
  readonly supported: boolean;
  readonly capabilities: SourceCapabilities;
  readonly reason?: string;

  init(): Promise<void>;
  home(signal?: AbortSignal): Promise<HomeResult>;
  homeVod?(signal?: AbortSignal): Promise<SourceResult>;
  category(
    tid: string,
    page?: string,
    extend?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<SourceResult>;
  search(
    keyword: string,
    page?: string,
    quick?: boolean,
    signal?: AbortSignal,
  ): Promise<SourceResult>;
  detail(id: string, signal?: AbortSignal): Promise<Vod>;
  player(
    flag: string,
    episodeUrl: string,
    flags?: string[],
    signal?: AbortSignal,
  ): Promise<PlayerResult> | PlayerResult;
  action?(action: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  proxy?(params: Record<string, string>, signal?: AbortSignal): Promise<unknown>;
  healthCheck?(signal?: AbortSignal): Promise<SourceHealth>;
  destroy(): Promise<void>;
}
```

### 9.1 标准播放结果

建议扩展 `PlayerResult`：

```typescript
interface PlayerResult {
  url: string;
  headers?: Record<string, string>;
  parse?: number;
  jx?: number;
  quality?: Array<{ name: string; url: string }>;
  script?: {
    runScript?: string;
    initScript?: string;
    customRegex?: string;
    snifferExclude?: string;
  };
  proxy?: {
    enabled: boolean;
    params?: Record<string, string>;
  };
}
```

这样可以覆盖 zyfun 的播放解析表达能力，并与当前浏览器嗅探和媒体协议代理衔接。

---

## 10. ProviderManager 与缓存

建议新增：

```text
src/core/provider-manager.ts
```

替代由业务代码随意创建和持有 Adapter 的方式。

### 10.1 主要职责

- 创建 Adapter；
- 保证同一源配置只初始化一次；
- 维护初始化中的 Promise，防止并发重复初始化；
- 使用 LRU 管理运行时实例；
- 配置变化后自动失效；
- 淘汰时调用 `destroy()`；
- 记录健康状态和最后一次错误；
- 支持强制刷新；
- 统一停止所有 Worker 和子进程。

### 10.2 缓存键

建议：

```text
site.key + runtime + hash(normalized site config)
```

Hash 输入至少包括：

```text
api
ext
jar
header
timeout
categories
runtime override
replacement version
```

### 10.3 缓存容量

首期建议最多缓存 8～10 个 Adapter，与 zyfun 的 LRU 思路接近。

脚本类 Adapter 占用子进程和内存，不能无限常驻。

---

## 11. 运行时实现方案

## 11.1 HTTP/XML/JSON

沿用并增强当前 `HttpSource`：

- XML 和 JSON 自动识别；
- 非标准 Content-Type 容错；
- 编码识别；
- 字段容错；
- 分类和分页标准化；
- Header、Cookie 和 Referer 传递；
- 统一错误类型。

## 11.2 AppYsV2

建议首批新增：

```text
src/core/appysv2-adapter.ts
```

原因：

- 主要是 JSON API；
- 无需脚本引擎；
- 无需浏览器；
- 实现和测试成本低；
- 对公开配置兼容收益较高。

主要能力：

- 识别不同 AppYs API 版本；
- 获取分类和筛选；
- 首页推荐；
- 分类列表；
- 搜索；
- 详情；
- 将播放线路转换为统一 `Flag/Episode`；
- 保存线路对应解析地址；
- 返回最终播放 URL 或待解析网页。

## 11.3 XBPQ

建议新增：

```text
src/core/xbpq/
├── xbpq-adapter.ts
├── xbpq-rule-loader.ts
├── xbpq-parser.ts
├── xbpq-transform.ts
└── xbpq-types.ts
```

第一版仅支持高频、明确的规则子集，不追求一次兼容所有方言。

优先能力：

- 远程或内联 JSON5 规则；
- 首页、分类、搜索、详情；
- HTML 字符串截取规则；
- 常见包含、不包含、替换语法；
- URL 拼接；
- 线路和剧集生成；
- Header 和 UA；
- JSON 响应路径提取。

复杂自动猜测模板可放到后续阶段，避免首版过度膨胀。

## 11.4 XYQ

建议新增：

```text
src/core/xyq/
├── xyq-adapter.ts
├── xyq-rule-loader.ts
├── xyq-html-parser.ts
├── xyq-json-parser.ts
└── xyq-types.ts
```

优先支持：

- 远程和内联 JSON5；
- 中文规则字段；
- 分类名称与 ID 映射；
- URL 占位符；
- 筛选条件；
- HTML 选择器写法；
- JSON 数据路径写法；
- 首页、分类、搜索、详情和剧集。

## 11.5 Drpy

当前项目已具备 Drpy MVP，但后续建议参考 zyfun，将不可信动态规则从当前进程内 VM 逐步迁移到独立子进程。

目标形态：

```text
DrpyAdapter
    ↓ RPC
Drpy Child Process
    ↓
受控宿主 API
```

子进程提供：

- 规则初始化；
- 网络请求 RPC；
- CookieJar；
- HTML 解析；
- JSON5；
- Base64、Hash 和常用加密；
- 日志回传；
- 超时中止；
- 销毁。

首期可以保留现有实现，同时新增运行时抽象，避免立即重构全部 Drpy 代码。

## 11.6 CatOpen

建议采用独立 Node 子进程，不在主进程直接动态 `import` 远程模块。

目录建议：

```text
src/core/catopen/
├── catopen-adapter.ts
├── catopen-process-host.ts
├── catopen-worker-entry.ts
├── catopen-inject.ts
└── catopen-types.ts
```

注入能力：

```text
BaseSpider
req / batchFetch
local storage
joinUrl
HTML parser
MD5
AES / DES / RSA
Base64
proxy helper
```

安全限制：

- 不暴露 `require`；
- 不暴露 `process`；
- 不允许直接访问文件系统；
- 不允许启动子进程；
- 网络只通过宿主 RPC；
- 单站点单进程；
- 最大内存和超时可配置；
- 异常后可销毁并重建。

## 11.7 T4

保留当前 `T4Adapter`，补充：

- CatVod 风格 `/init`、`/home`、`/category`、`/detail`、`/search`、`/play` 接口；
- 传统 query 风格 T4；
- 服务能力探测；
- 请求超时；
- 服务版本；
- 健康检查；
- 本地和远程服务标识；
- 代理接口。

T4 是复杂 Provider 的重要解耦方式，适合：

- Python；
- Playwright；
- 复杂加密依赖；
- 需要集中维护的规则；
- 多客户端共享。

## 11.8 Alist（已完成 v2/v3 MVP）

当前实现已经覆盖：

- Alist v2/v3 settings 识别与 API 路由；
- 首页目录、分页列表和递归导航；
- `folder/file` 标签在核心模型与 Renderer 中透传；
- v3 搜索及 v2 公共搜索兼容；
- 路径级目录密码；
- v3 用户名密码登录与 Authorization Token；
- 文件详情和直链播放；
- 视频、音频和常见媒体扩展名识别；
- 登录 Token 仅用于 Alist API，不向第三方媒体地址透传。

后续根据真实样本补充缩略图鉴权、字幕关联、更多文件类型和特殊反向代理路径。

## 11.9 Python

第一阶段只支持外部 Python/T4 Provider，不将完整 Python 运行时打包进 DMG。

原因：

- 包体和依赖复杂；
- 虚拟环境管理复杂；
- 进程、端口和退出管理复杂；
- macOS 签名和公证复杂；
- Python Provider 的收益需先验证。

---

## 12. 宿主能力层

建议建立统一 `ProviderHostApi`，供 Drpy、CatOpen 及未来脚本运行时使用。

```typescript
interface ProviderHostApi {
  request(input: HostRequest): Promise<HostResponse>;
  batchRequest(input: HostRequest[]): Promise<HostResponse[]>;
  getCookie(url: string): Promise<string>;
  setCookie(url: string, value: string): Promise<void>;
  storageGet(namespace: string, key: string): Promise<string | null>;
  storageSet(namespace: string, key: string, value: string): Promise<void>;
  parseHtml(html: string, expression: string): Promise<unknown>;
  crypto(operation: CryptoOperation): Promise<string>;
  proxyUrl(params: Record<string, string>): Promise<string>;
  log(level: string, values: unknown[]): void;
}
```

### 12.1 网络请求统一管理

所有 Provider 网络请求统一经过宿主，便于：

- 代理设置；
- DNS；
- Cookie；
- UA；
- Referer；
- 超时；
- 重定向；
- 内网访问限制；
- 日志；
- 请求取消；
- 测试 Mock。

### 12.2 存储隔离

存储命名空间建议：

```text
provider:<siteKey>:<runtime>:<configHash>
```

禁止不同站点共享无边界的全局存储。

---

## 13. 播放解析链

统一播放处理流程：

```text
Adapter.player()
       ↓
标准 PlayerResult
       ↓
是否为直接媒体地址？
  ├── 是：媒体探测
  │      ↓
  │   Header/代理处理
  │      ↓
  │   内置播放器
  │
  └── 否：是否需要解析或嗅探？
         ↓
      Resolver Chain
         ├── JSON 解析
         ├── 内置解析规则
         ├── 页面脚本
         ├── CDP 浏览器嗅探
         └── 兼容播放器降级
```

### 13.1 播放结果判定

需要综合判断：

- `parse`；
- `jx`；
- URL 后缀；
- Content-Type；
- HLS/DASH 探测；
- 是否返回 HTML；
- 是否包含运行脚本；
- 是否配置自定义媒体正则；
- 是否配置排除规则。

### 13.2 CDP 嗅探

参考 zyfun，嗅探接口应接收：

```text
url
headers
timeout
runScript
initScript
customRegex
snifferExclude
```

嗅探结果必须返回：

```typescript
{
  url: string;
  headers: Record<string, string>;
}
```

当前项目已有浏览器嗅探基础，应重点补充：

- Provider 返回脚本到嗅探器的传递；
- 候选媒体排序；
- 排除广告和小媒体文件；
- Cookie、Referer、UA 回传；
- 超时和用户取消；
- 页面和 Session 的及时释放。

---

## 14. 数据源健康检查

不能只检查 API 是否返回 HTTP 200。

建议支持三种检查级别：

### 14.1 快速检查

```text
初始化成功
首页或搜索成功
```

### 14.2 主链路检查

```text
首页
→ 随机分类
→ 随机详情
→ 获取线路和剧集
```

### 14.3 完整播放检查

```text
搜索或分类
→ 详情
→ 随机剧集
→ player
→ 媒体探测或嗅探
```

健康状态：

```text
healthy
partial
unavailable
unsupported
unknown
```

记录：

- 最后检查时间；
- 检查级别；
- 耗时；
- 失败步骤；
- 错误类型；
- 最近连续失败次数。

---

## 15. 设置页面建议

源管理页面不再只显示“支持/不支持”，而是显示：

```text
站点名称
识别运行时
识别依据
能力范围
运行状态
替代 Provider
最后检查结果
失败原因
```

示例：

```text
某某影视
运行时：XBPQ
识别依据：api=csp_XBPQ
能力：首页 / 分类 / 搜索 / 详情 / 播放
状态：可用
```

```text
NewDouBanGuard
运行时：Android Dex/JNI
识别依据：具体 csp + 加固插件
状态：暂不支持
可选替代：尚未验证
```

### 15.1 配置统计

导入配置后展示：

```text
共发现 82 个站点
直接支持 34
规则解释器支持 30
远程 T4 支持 8
存在替代 Provider 4
Android 专用 5
未知 1
```

该统计能直观衡量后续 Adapter 的兼容收益。

---

## 16. 错误模型和日志

建议扩展 `SourceAdapterError`：

```typescript
type SourceErrorCode =
  | "UNSUPPORTED"
  | "RUNTIME_DETECTION"
  | "INIT_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "NETWORK"
  | "INVALID_RULE"
  | "INVALID_RESPONSE"
  | "SCRIPT_ERROR"
  | "PROCESS_CRASHED"
  | "MEDIA_NOT_FOUND"
  | "RUNTIME";
```

日志至少包含：

```text
siteKey
siteName
runtime
operation
configHash
workerPid（如适用）
elapsedMs
errorCode
message
```

远程规则内容、Cookie、Token 和完整播放 URL 不应默认写入普通日志。

---

## 17. 安全设计

### 17.1 脚本隔离

- Drpy/CatOpen 使用独立子进程；
- 不可信脚本不进入 Electron 主进程；
- 不暴露 Node 内置模块；
- 不暴露文件系统；
- 不暴露系统命令；
- 网络走宿主 RPC；
- 限制执行时间；
- 可销毁异常运行时。

### 17.2 SSRF 与内网保护

远程规则和脚本默认禁止访问：

```text
127.0.0.0/8
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
::1
fc00::/7
```

用户明确启用本地服务或 T4 时，按站点授权允许指定地址。

### 17.3 远程 Provider 来源

- 记录来源 URL；
- 保存内容 Hash；
- 更新后重新初始化；
- 可固定版本；
- 可禁用自动更新；
- 默认不执行来源不明的替代 Provider；
- 提供风险提示。

---

## 18. 工程改造建议

目标目录结构：

```text
mac/src/core/
├── source-adapter.ts
├── source-capability.ts
├── source-adapter-factory.ts
├── runtime-resolver.ts                 # 新增
├── provider-manager.ts                 # 新增
├── provider-replacement-registry.ts    # 新增
├── provider-host-api.ts                # 新增
├── http-source.ts
├── appysv2-adapter.ts                  # 新增
├── xbpq/                               # 新增
├── xyq/                                # 新增
├── catopen/                            # 新增
├── drpy-adapter.ts
├── t4-adapter.ts
├── resolver.ts
└── media-sniffer.ts
```

### 18.1 当前文件的职责调整

#### `source-capability.ts`

从“简单识别函数”调整为调用 `RuntimeResolver`，自身只保留能力模型和兼容导出。

#### `source-adapter-factory.ts`

只负责根据已解析的 runtime 创建 Adapter，不再自行做复杂识别。

#### `app-service.ts`

通过 `ProviderManager` 获取 Adapter，不再直接依赖 Factory 生命周期。

#### `models.ts`

扩展 runtime override、播放脚本、替代 Provider 和健康状态字段。

#### 设置页面

增加识别依据、能力范围、替代状态和健康检查结果。

---

## 19. 分阶段实施计划

## 阶段 0：配置样本统计（审计工具已完成）

目标：先确认真实配置中的运行时分布，避免凭感觉决定开发优先级。

当前已提供 `npm run audit:config`，支持文本、JSON 和报告文件输出。

任务：

- 收集当前实际使用的配置；
- 输出所有 site 的 `type/api/ext/jar` 摘要；
- 统计 HTTP、Drpy、XBPQ、XYQ、AppYsV2、Alist、具体 csp 的数量；
- 记录使用频率和高价值站点；
- 建立测试样本库。

产出：

```text
runtime-distribution.json
provider-samples/
compatibility-baseline.md
```

## 阶段 1：运行时识别重构（已完成）

任务：

- 新增 `RuntimeResolver`；
- 新增通用 CSP 别名；
- 保留 Android 专用精确降级；
- 增加识别依据和置信度；
- 增加单元测试；
- 设置页展示新的识别结果。

验收：

- `csp_XBPQ` 不再被识别为 Android Dex；
- `csp_XYQHiker` 不再被识别为 Android Dex；
- `csp_AppYsV2` 不再被识别为 Android Dex；
- `csp_NewDouBanGuard` 仍被准确识别为 Android 专用；
- 原有 HTTP、JS、Drpy、T4 测试不回归。

## 阶段 2：AppYsV2 Adapter（已完成 MVP）

任务：

- 分类、筛选、首页、搜索、详情和播放线路；
- 不同接口版本兼容；
- Header 和解析地址；
- 单元测试和公开样本回归。

验收：

- 至少 2 个不同 AppYsV2 样本完成主链路；
- 至少 1 个样本完成内置播放；
- 异常接口能够给出明确错误。

## 阶段 3：XYQ MVP（已完成首版）

任务：

- JSON5 规则；
- HTML 与 JSON 两类列表；
- 分类、搜索、详情、剧集；
- 常用占位符和 Header。

验收：

- 至少 3 个 XYQ 规则通过搜索、详情和播放链路；
- 规则失败能定位到具体字段和操作。

## 阶段 4：XBPQ MVP（已完成首版）

任务：

- 高频规则子集；
- 首页、分类、搜索、详情和剧集；
- 常用截取、包含、不包含、替换语法；
- JSON 路径支持。

验收：

- 至少 3 个 XBPQ 样本完成主链路；
- 不依赖自动猜测模板也可稳定运行明确规则。

## 阶段 5：ProviderManager 和进程隔离（ProviderManager 与 CatOpen 隔离已完成）

任务：

- 配置 Hash；
- LRU；
- 初始化锁；
- destroy；
- Drpy 子进程抽象；
- 日志回传；
- 进程异常恢复。

验收：

- 同一源并发请求只初始化一次；
- 配置变化后自动使用新实例；
- LRU 淘汰时子进程被释放；
- 崩溃脚本不导致 Electron 主进程退出。

## 阶段 6：CatOpen Adapter（已完成隔离运行 MVP）

任务：

- 远程 JS 下载和 Hash；
- Child Process；
- 宿主 API 注入；
- 首页、搜索、详情、播放、代理；
- 安全限制。

验收：

- 至少 2 个公开 CatOpen Provider 完成主链路；
- 脚本无法直接访问文件系统和系统命令；
- Worker 异常可被销毁和重建。

## 阶段 7：播放解析链增强

任务：

- PlayerResult 脚本字段；
- CDP 嗅探脚本注入；
- 自定义正则和排除规则；
- Header/Cookie 回传；
- 候选媒体排序。

验收：

- 直接媒体地址进入内置播放器；
- 网页播放地址能够自动嗅探；
- Referer/UA/Cookie 能正确传给播放器；
- 嗅探超时可取消并释放页面。

## 阶段 8：具体 CSP 替代 Provider（基础设施已完成）

已完成：

- ProviderReplacementRegistry 数据模型和 JSON 加载；
- 精确且忽略大小写的 `match.api`；
- 可选 JAR MD5 约束；
- 目标运行时、来源、仓库、许可证、验证日期和备注；
- 能力裁剪和透明 Adapter 包装；
- 单配置审计应用外部注册表；
- 批量审计生成 Android-only 高频排名；
- UI 展示替代来源和许可证；
- 设置页导入、清除、SQLite 持久化、启动恢复和 Provider 即时重建；
- 默认注册表为空，避免未经验证的自动替换。

后续任务：

- 对真实公开配置执行批量审计；
- 查找授权清晰的开源替代实现；
- 按具体能力和在线链路验证；
- 将通过验收的条目加入默认注册表；
- 不具备稳定替代时保持不支持。

优先评估：

```text
csp_NewDouBanGuard
csp_NewWoggGuard
其他使用频率高的具体 Spider
```

---

## 20. 测试策略

### 20.1 单元测试

- RuntimeResolver；
- CSP 别名；
- ext 指纹；
- XBPQ/XYQ 规则解析；
- AppYsV2 字段映射；
- 播放结果标准化；
- LRU 和配置 Hash；
- 错误映射。

### 20.2 合约测试

所有 Adapter 使用同一组合约测试：

```text
init
home
category
search
detail
player
destroy
```

验证返回模型和异常语义一致。

### 20.3 样本回归

保存脱敏后的：

- 配置样本；
- 规则样本；
- HTML/JSON 响应样本；
- 详情结果；
- 播放结果；
- 嗅探候选记录。

尽量减少测试对实时公开站点的强依赖。

### 20.4 在线审计

在线审计作为补充：

- 不进入默认单元测试；
- 支持手动运行；
- 输出成功率和失败步骤；
- 不将公开地址硬编码为产品默认来源。

---

## 21. 验收指标

建议使用兼容率而不是“支持了几个 Adapter”作为最终指标。

### 21.1 配置识别率

```text
可识别站点数 / 配置站点总数
```

### 21.2 主链路成功率

```text
完成 首页/搜索 → 详情 → 剧集 的站点数
/ 可识别站点数
```

### 21.3 播放成功率

```text
获得有效媒体并在内置播放器起播的站点数
/ 完成详情链路的站点数
```

### 21.4 稳定性

- 规则脚本异常不导致主进程崩溃；
- 无失控子进程；
- 无长期未释放 BrowserWindow；
- 并发搜索可取消；
- Adapter 淘汰后资源释放；
- 错误可定位到站点、运行时和步骤。

---

## 22. 风险与应对

| 风险 | 说明 | 应对措施 |
|---|---|---|
| 规则方言过多 | XBPQ/XYQ 存在大量变体 | 先实现高频子集，基于真实样本迭代 |
| 公开地址不稳定 | 接口随时失效 | 不硬编码默认地址，增加健康检查和替换机制 |
| 不可信脚本 | 可能访问系统或泄漏数据 | 子进程隔离、宿主网络、权限限制 |
| 运行时膨胀 | 一次支持过多类型导致复杂度失控 | 按兼容收益分阶段实施 |
| AGPL 污染 | 直接复制 zyfun 源码可能产生义务 | 只参考架构和协议，独立实现 |
| 播放地址需复杂嗅探 | 页面脚本、Cookie、反爬较多 | CDP 嗅探、脚本参数、Header 回传 |
| 具体 Android Spider 无替代 | JNI、加固、设备指纹 | 保持明确不支持，最后评估 Android Bridge |
| 自动识别误判 | ext 内容相似 | 输出置信度，允许用户覆盖 runtime |

---

## 23. 初步决策结论

### 23.1 已确定方向

1. 不在 macOS 主进程中直接执行 Android Dex/JAR；
2. 目标调整为最大范围兼容 TVBox/CatVod 站点能力；
3. 采用多 Provider Adapter 架构；
4. 优先识别和实现通用 `csp_*` 规则解释器；
5. Drpy/CatOpen 最终采用独立子进程；
6. 保留 T4 作为复杂运行时的服务化通道；
7. 使用 CDP 浏览器嗅探作为播放解析兜底；
8. 对具体 Android Spider 建立可验证的替代注册表；
9. Android Bridge 仅作为最后阶段的可选方案。

### 23.2 推荐开发优先级

```text
配置样本统计
    ↓
RuntimeResolver + CSP 别名
    ↓
AppYsV2
    ↓
XYQ
    ↓
XBPQ
    ↓
ProviderManager + 子进程隔离
    ↓
CatOpen
    ↓
播放脚本与 CDP 嗅探增强
    ↓
高价值具体 CSP 替代
```

### 23.3 第一阶段不建议做

```text
通用 Android 模拟器
Dex 转 JAR 自动执行
JNI 模拟
内嵌 Android Emulator
一次性照搬 zyfun 全部 Adapter
直接复制 AGPL 源码
```

---

## 24. 下一步讨论事项

在进入代码改造前，建议先完成以下决策：

1. 当前实际使用的配置地址和样本范围；
2. 首批以 AppYsV2、XYQ 还是 XBPQ 为优先；
3. 是否允许用户手动覆盖识别出的 runtime；
4. CatOpen 和 Drpy 是否统一使用 Child Process；
5. 替代 Provider 注册表是内置静态文件还是可更新远程索引；
6. 在线公开规则的来源和许可证管理方式；
7. 是否保留当前 `javascript` VM 作为轻量受信脚本运行时；
8. 完整播放检查是否默认执行，还是仅用户手动触发。

---

## 25. 参考项目

- zyfun：`https://github.com/Hiram-Wong/zyfun`
- FongMi/TV：`https://github.com/FongMi/TV`
- CatVodSpider：`https://github.com/FongMi/CatVodSpider`
- hipy-server：`https://github.com/hjdhnx/hipy-server`
- TV-Multiplatform：`https://github.com/Greatwallcorner/TV-Multiplatform`

本方案仅参考这些项目的公开架构、协议和工程经验。具体代码实现应根据许可证要求独立完成。
