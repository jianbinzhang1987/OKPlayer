# macOS 点播客户端技术设计说明书

> 项目暂定名：FongMi macOS 迁移版  
> 文档版本：v0.1  
> 文档状态：技术方案草案  
> 目标平台：macOS  
> 参考项目：`TV-fongmi`

---

## 1. 技术目标

本项目在 macOS 平台重新实现 FongMi/TVBox 的核心点播能力，重点兼容现有配置协议、播放源调用方式和播放解析链。

核心技术目标：

```text
配置兼容
  +
播放源兼容
  +
搜索/详情/线路/剧集数据兼容
  +
播放地址解析兼容
  +
macOS 播放器能力
```

技术设计应优先满足：

1. 核心引擎与界面分离；
2. 播放源执行环境可隔离；
3. 搜索和解析任务支持并发、超时和取消；
4. 播放 URL 与请求头完整传递；
5. 对现有配置协议尽量保持兼容；
6. 对无法兼容的 Android JAR Spider 明确降级；
7. 便于后续补充 Web 嗅探、Python Spider 和直播能力。

---

## 2. 参考项目核心结构

现有 Android 项目的核心调用关系可抽象为：

```text
VodConfig
   ↓
Site
   ↓
BaseLoader
   ├── JarLoader
   ├── JsLoader
   └── PyLoader
   ↓
Spider
   ├── homeContent
   ├── categoryContent
   ├── searchContent
   ├── detailContent
   └── playerContent
   ↓
SiteApi
   ↓
Result / Vod / Flag / Episode
   ↓
Source / ParseJob
   ↓
PlayerManager
```

macOS 版应保持这一业务层次，但不复用 Android UI、Android Lifecycle、Room、ExoPlayer 等平台实现。

---

## 3. 技术路线选择

## 3.1 推荐技术栈

第一版推荐：

```text
桌面框架：Electron
前端框架：Vue 3
开发语言：TypeScript
状态管理：Pinia
构建工具：Vite
本地数据库：SQLite
数据库访问：better-sqlite3 或等价方案
JavaScript Spider：Node.js Worker Threads / child_process
网络请求：undici 或 axios，统一封装
播放器：libmpv 或 mpv IPC
Web 嗅探：Electron WebContents / 隔离 BrowserWindow
日志：pino 或等价结构化日志
测试：Vitest + Playwright + Node 集成测试
```

## 3.2 选择 Electron 的原因

当前项目的迁移重点是兼容播放源，而不是追求最小安装包。

Electron 的主要优势：

- Node.js 可直接承载 JavaScript Spider；
- 便于实现独立 Worker 和子进程隔离；
- Chromium 对网页解析和后续视频嗅探更友好；
- Vue 页面开发效率高；
- 与 mpv IPC 集成成熟；
- 后续可扩展 Windows 版本。

## 3.3 暂不推荐的方案

### SwiftUI

优点是原生体验好，但 JavaScript Spider、网页嗅探、Node 生态和跨平台兼容成本较高。

### Tauri

应用更轻，但 WebView 网络拦截、Node 插件兼容和 JavaScript Spider 运行环境需要额外建设，首版迁移风险高于 Electron。

### Flutter

UI 跨平台能力较好，但播放源插件和 Web 嗅探不是其优势方向。

---

## 4. 总体架构

```text
┌──────────────────────────────────────────────┐
│                Renderer Process              │
│ Vue 3 / Pinia / Pages / Components           │
└──────────────────────┬───────────────────────┘
                       │ IPC
┌──────────────────────▼───────────────────────┐
│                 Main Process                 │
│                                              │
│ App Service                                  │
│ ├── Config Service                           │
│ ├── Site Service                             │
│ ├── Search Service                           │
│ ├── Detail Service                           │
│ ├── Playback Resolve Service                 │
│ ├── History/Favorite Service                 │
│ └── Settings Service                         │
└───────────────┬───────────────┬──────────────┘
                │               │
        ┌───────▼───────┐ ┌────▼──────────────┐
        │ Runtime Layer │ │ Player Layer       │
        │               │ │                   │
        │ HTTP Adapter  │ │ mpv Controller    │
        │ JS Worker     │ │ IPC / libmpv      │
        │ Python Future │ │                   │
        └───────┬───────┘ └────────┬──────────┘
                │                  │
        ┌───────▼──────────────────▼──────────┐
        │ Network / Cache / SQLite / Logging  │
        └─────────────────────────────────────┘
```

---

## 5. 工程目录建议

```text
mac/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/                 # Electron 主进程
│       │   ├── preload/              # 安全 IPC 桥
│       │   └── renderer/             # Vue 页面
│       ├── resources/
│       │   └── mpv/
│       └── package.json
│
├── packages/
│   ├── core/                         # 核心业务模型和接口
│   │   ├── config/
│   │   ├── site/
│   │   ├── search/
│   │   ├── detail/
│   │   ├── playback/
│   │   └── errors/
│   │
│   ├── protocol/                     # FongMi/TVBox 协议兼容
│   │   ├── config-parser/
│   │   ├── result-parser/
│   │   ├── vod-parser/
│   │   └── xml-parser/
│   │
│   ├── runtimes/
│   │   ├── http-runtime/
│   │   ├── js-runtime/
│   │   └── python-runtime/           # 预留
│   │
│   ├── resolver/
│   │   ├── direct/
│   │   ├── json/
│   │   ├── web-sniffer/              # P1
│   │   └── resolver-chain/
│   │
│   ├── player/
│   │   ├── mpv-controller/
│   │   └── player-types/
│   │
│   ├── network/
│   │   ├── http-client/
│   │   ├── headers/
│   │   ├── proxy/
│   │   └── cookie/
│   │
│   ├── storage/
│   │   ├── sqlite/
│   │   ├── cache/
│   │   └── repositories/
│   │
│   └── shared/
│       ├── logger/
│       ├── timeout/
│       └── utils/
│
├── tests/
│   ├── fixtures/
│   ├── config/
│   ├── source/
│   ├── search/
│   ├── detail/
│   ├── resolver/
│   └── player/
│
├── REQUIREMENTS.md
├── TECHNICAL_DESIGN.md
└── README.md
```

可在首版适当简化为单仓库，但模块边界应保持不变。

---

## 6. 核心领域模型

## 6.1 Config

```ts
export interface VodConfig {
  sourceUrl?: string;
  baseUrl?: string;
  spider?: string;
  wallpaper?: string;
  logo?: string;
  notice?: string;
  sites: Site[];
  parses: ParseRule[];
  headers: HostHeaderRule[];
  flags: string[];
  proxy: ProxyRule[];
  rules: SniffRule[];
  hosts: string[];
  ads: string[];
}
```

## 6.2 Site

```ts
export interface Site {
  key: string;
  name: string;
  type: number;
  api: string;
  ext?: string;
  jar?: string;
  click?: string;
  playUrl?: string;
  hide?: number;
  timeout?: number;
  searchable?: number;
  changeable?: number;
  quickSearch?: number;
  indexs?: number;
  categories?: string[];
  header?: Record<string, string>;
  style?: SiteStyle;
}
```

## 6.3 Result

```ts
export interface SiteResult {
  class?: Category[];
  list?: Vod[];
  filters?: Record<string, Filter[]>;
  url?: string | UrlValue;
  header?: Record<string, string>;
  msg?: string;
  subs?: Subtitle[];
  playUrl?: string;
  artwork?: string;
  jxFrom?: string;
  flag?: string;
  desc?: string;
  format?: string;
  click?: string;
  key?: string;
  position?: number;
  pagecount?: number;
  parse?: number;
  code?: number;
  jx?: number;
  drm?: DrmInfo;
}
```

## 6.4 Vod

```ts
export interface Vod {
  vod_id: string;
  vod_name: string;
  type_name?: string;
  vod_pic?: string;
  vod_remarks?: string;
  vod_year?: string;
  vod_area?: string;
  vod_director?: string;
  vod_actor?: string;
  vod_content?: string;
  vod_play_from?: string;
  vod_play_url?: string;
  vod_tag?: string;
  action?: string;
  siteKey?: string;
  siteName?: string;
  flags?: PlayFlag[];
}
```

## 6.5 PlayFlag 与 Episode

```ts
export interface PlayFlag {
  flag: string;
  show?: string;
  episodes: Episode[];
}

export interface Episode {
  name: string;
  desc?: string;
  url: string;
  index: number;
  number?: number;
}
```

## 6.6 PlayerResult

```ts
export interface PlayerResult {
  url: string;
  parse: number;
  flag?: string;
  header?: Record<string, string>;
  playUrl?: string;
  format?: string;
  subs?: Subtitle[];
  drm?: DrmInfo;
  click?: string;
  jx?: number;
  jxFrom?: string;
  key?: string;
  msg?: string;
}
```

---

## 7. 配置加载设计

## 7.1 加载流程

```text
用户输入配置地址
    ↓
ConfigLoader.fetch()
    ↓
判断内容类型
    ├── 普通 JSON
    ├── 加密/包装 JSON
    └── 配置仓库 urls
    ↓
ConfigParser.parse()
    ↓
解析相对地址
    ↓
生成标准 VodConfig
    ↓
缓存原始配置和解析结果
    ↓
更新站点与解析器仓库
```

## 7.2 相对路径解析

若配置地址为：

```text
https://example.com/config/main.json
```

配置中：

```text
./spider.js
../ext/source.json
```

应转换为：

```text
https://example.com/config/spider.js
https://example.com/ext/source.json
```

所有 `spider`、`api`、`ext`、`jar`、`wallpaper` 等路径统一通过 `resolveResourceUrl(baseUrl, value)` 处理。

## 7.3 缓存策略

本地缓存目录建议：

```text
~/Library/Application Support/<AppName>/
├── configs/
├── plugins/
├── cache/
├── logs/
└── database.sqlite
```

刷新失败时继续使用最近一次有效配置。

---

## 8. 播放源统一接口

所有播放源都应映射到统一接口：

```ts
export interface SourceAdapter {
  init(context: SourceContext, ext?: string): Promise<void>;
  homeContent(filter: boolean): Promise<SiteResult>;
  homeVideoContent(): Promise<SiteResult>;
  categoryContent(
    tid: string,
    page: string,
    filter: boolean,
    extend: Record<string, string>
  ): Promise<SiteResult>;
  detailContent(ids: string[]): Promise<SiteResult>;
  searchContent(
    keyword: string,
    quick: boolean,
    page?: string
  ): Promise<SiteResult>;
  playerContent(
    flag: string,
    id: string,
    vipFlags: string[]
  ): Promise<PlayerResult>;
  action?(action: string): Promise<SiteResult>;
  proxy?(params: Record<string, string>): Promise<unknown>;
  destroy(): Promise<void>;
}
```

SourceFactory 根据 `site.type` 和 `site.api` 创建适配器。

```text
Site
  ↓
SourceFactory
  ├── HttpXmlSourceAdapter
  ├── HttpJsonSourceAdapter
  ├── HttpType4SourceAdapter
  ├── JavaScriptSourceAdapter
  ├── PythonSourceAdapter      # 预留
  └── UnsupportedSourceAdapter
```

---

## 9. HTTP 播放源实现

## 9.1 type=0

调用 HTTP 接口，返回 XML。

需要支持：

- 首页 GET；
- 分类参数 `ac=videolist`；
- 详情参数 `ac=videolist` 或协议兼容逻辑；
- 搜索参数 `wd`；
- XML 转标准 `SiteResult`。

## 9.2 type=1

调用 HTTP JSON 接口。

### 搜索

```text
wd=<keyword>
quick=<true|false>
pg=<page>
extend=
```

### 分类

```text
ac=detail
t=<tid>
pg=<page>
f=<json filter>
```

### 详情

```text
ac=detail
ids=<vod id>
```

## 9.3 type=4

与 type=1 类似，但分类扩展参数使用 Base64 URL-safe 编码后传入 `ext`。

## 9.4 HTTP 请求上下文

所有 HTTP 请求统一支持：

- 站点 Header；
- 全局 Header；
- Cookie 管理；
- 超时；
- 代理；
- 重定向；
- Gzip；
- 请求取消；
- 日志脱敏。

---

## 10. JavaScript Spider Runtime

## 10.1 目标

兼容 `xxx.js` 类型 Spider，保持方法名和参数尽量与 Android 版一致。

## 10.2 运行方式

建议每个插件运行在独立 Worker Thread；对于不可信或高风险插件，可升级为独立 child process。

```text
Main Process
    ↓ RPC
Spider Worker
    ↓
加载 JS 插件
    ↓
调用 Spider 方法
    ↓
返回 JSON
```

## 10.3 Worker 消息协议

请求：

```ts
interface RuntimeRequest {
  requestId: string;
  siteKey: string;
  method:
    | 'init'
    | 'homeContent'
    | 'homeVideoContent'
    | 'categoryContent'
    | 'detailContent'
    | 'searchContent'
    | 'playerContent'
    | 'action'
    | 'proxy'
    | 'destroy';
  args: unknown[];
  timeoutMs: number;
}
```

响应：

```ts
interface RuntimeResponse {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
}
```

## 10.4 插件上下文

JavaScript Spider 不应直接访问 Node 全部能力，而应注入受控 API：

```ts
interface SpiderHostApi {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
  get(url: string, headers?: Record<string, string>): Promise<string>;
  post(url: string, body?: unknown, headers?: Record<string, string>): Promise<string>;
  base64Encode(value: string): string;
  base64Decode(value: string): string;
  md5(value: string): string;
  sha1(value: string): string;
  log(level: string, message: string): void;
  resolveUrl(base: string, value: string): string;
  getPreference(key: string): unknown;
  setPreference(key: string, value: unknown): void;
}
```

## 10.5 隔离要求

- 禁止默认访问 `fs`；
- 禁止 `child_process`；
- 禁止任意 `require`；
- 网络请求通过 Host API；
- 单次方法调用必须有超时；
- Worker 异常后可重建；
- 每个配置或站点可独立缓存实例；
- 插件日志带 `siteKey` 和 `requestId`。

## 10.6 兼容性策略

首版不追求兼容所有 JavaScript Spider 内置库，应通过真实样例逐步补齐：

1. 选择代表性 JS 源；
2. 运行搜索、详情、播放；
3. 记录缺失函数；
4. 在 Host API 或兼容层补充；
5. 建立兼容性测试夹具。

---

## 11. Python Spider Runtime

P2 预留。

推荐使用独立 Python 子进程：

```text
Main Process
    ↓ JSON-RPC
Python Runtime
    ↓
加载 Spider 模块
```

关键问题：

- Python 运行时打包；
- 第三方依赖；
- 插件路径；
- Apple 签名与公证；
- 子进程生命周期；
- 超时和强制终止。

第一阶段只保留接口，不实现完整运行时。

---

## 12. JAR Spider 兼容策略

## 12.1 不可直接复用的原因

原项目通过 Android `DexClassLoader` 加载 JAR/Dex，插件通常依赖：

- Android Context；
- Android SDK；
- CatVod Android 类库；
- Dalvik/ART；
- Android 特有网络与工具实现。

因此无法在普通 macOS JVM 中直接执行。

## 12.2 第一阶段处理

JAR 站点加载为 `UnsupportedSourceAdapter`，界面展示：

```text
不支持：Android JAR Spider
```

并保留：

- 站点名称；
- API；
- JAR 地址；
- 配置来源；
- 后续转换状态。

## 12.3 后续可选方案

1. 将常用 JAR Spider 转换为 JavaScript；
2. 建设远程兼容服务；
3. 提供 Android 辅助运行环境；
4. 重写常用站点适配器。

首版不实现。

---

## 13. 搜索服务设计

## 13.1 单站点搜索

```text
Renderer
  ↓ IPC
SearchService.searchSite()
  ↓
SourceAdapter.searchContent()
  ↓
标准化 SiteResult
  ↓
返回 Renderer
```

## 13.2 多站点搜索

```text
SearchService.searchAll(keyword)
    ↓
筛选 enabled && searchable 的站点
    ↓
为每个站点创建独立任务
    ↓
并发执行
    ↓
按站点增量发送结果事件
```

建议事件：

```ts
interface SearchProgressEvent {
  searchId: string;
  siteKey: string;
  siteName: string;
  status: 'started' | 'success' | 'empty' | 'failed' | 'timeout';
  items?: Vod[];
  error?: AppError;
  elapsedMs?: number;
}
```

## 13.3 搜索代次

保留原项目 `epoch` 思想：

```text
searchId A 开始
用户发起 searchId B
取消 A
只接受 B 的事件
```

Renderer 和 Main Process 均应校验 `searchId`，防止旧结果污染当前页面。

## 13.4 并发策略

建议：

- 默认最大并发 8～12；
- 其余站点排队；
- 每个站点独立超时；
- 用户可手动停止搜索；
- Worker 调用支持 AbortSignal；
- 结果不做强制去重。

---

## 14. 详情与线路解析

## 14.1 详情调用

```text
DetailService.getDetail(siteKey, vodId)
    ↓
SourceAdapter.detailContent([vodId])
    ↓
SiteResult.list[0]
    ↓
VodParser.parseFlags(vod)
```

## 14.2 播放线路规则

```text
vod_play_from = "线路一$$$线路二"
vod_play_url  = "第1集$url1#第2集$url2$$$第1集$url3"
```

解析步骤：

1. `vod_play_from.split('$$$')` 得到线路名；
2. `vod_play_url.split('$$$')` 得到各线路剧集串；
3. 每条线路按 `#` 拆分剧集；
4. 每个剧集按第一个 `$` 拆分名称和地址；
5. 没有名称时生成两位数字序号；
6. 线路和剧集数量不匹配时容错处理；
7. 去除重复剧集。

## 14.3 容错

需要兼容：

- 只有一条线路；
- 剧集地址本身包含 `$`；
- 空线路名；
- 空剧集名；
- 详情已直接返回结构化 `flags/episodes`；
- 搜索返回结果没有详情字段；
- 影片为单集电影。

---

## 15. 播放解析链设计

## 15.1 解析流程

```text
Episode.url / id
    ↓
SourceAdapter.playerContent(flag, id, flags)
    ↓
PlayerResult
    ↓
SourceExtractorChain
    ↓
判断 direct / parse / special
    ↓
ResolverChain
    ↓
ResolvedMedia
    ↓
mpv
```

## 15.2 ResolvedMedia

```ts
export interface ResolvedMedia {
  url: string;
  headers: Record<string, string>;
  format?: string;
  subtitles?: Subtitle[];
  drm?: DrmInfo;
  sourceName?: string;
  originalUrl?: string;
}
```

## 15.3 解析判断

### 直接播放

满足以下条件时可直接交给 mpv：

- `parse === 0`；
- URL 为常见媒体格式；
- 不需要 Web 嗅探；
- 特殊协议提取器未命中。

### 二次解析

满足以下任一条件时进入 ResolverChain：

- `parse === 1`；
- `jx === 1`；
- `playUrl` 非空；
- `flag` 命中配置 `flags`；
- URL 为网页或平台地址；
- 站点明确要求解析。

## 15.4 ResolverChain

```text
ResolverChain
├── DirectResolver
├── PrefixResolver
├── JsonApiResolver
├── WebSnifferResolver     # P1
└── UnsupportedResolver
```

### DirectResolver

直接返回 URL 和 Header。

### PrefixResolver

输出：

```text
result.playUrl + result.url
```

### JsonApiResolver

请求：

```text
parse.url + webUrl
```

响应兼容：

```json
{"url":"https://...m3u8"}
```

或：

```json
{"data":{"url":"https://...m3u8"}}
```

并提取：

- User-Agent / ua；
- Referer；
- Cookie。

### WebSnifferResolver

P1 实现，通过隔离的 BrowserWindow 加载网页并监听媒体请求。

---

## 16. Web 嗅探技术设计

## 16.1 目标

从需要执行 JavaScript 的网页中识别真实媒体 URL。

## 16.2 实现方式

建议使用隐藏或离屏 BrowserWindow：

```text
WebSnifferResolver
    ↓
创建隔离 Session
    ↓
加载解析页面
    ↓
监听 webRequest
    ↓
匹配媒体 URL
    ↓
返回 URL + Headers
    ↓
销毁窗口和 Session
```

## 16.3 媒体识别

应结合：

- URL 后缀：m3u8、mp4、mpd；
- MIME Type；
- 配置中的 regex；
- exclude 规则；
- 广告域名黑名单；
- URL 长度与参数特征。

## 16.4 安全隔离

- `nodeIntegration=false`；
- `contextIsolation=true`；
- 使用独立 partition；
- 禁止下载；
- 禁止打开外部窗口；
- 超时销毁；
- 成功后立即停止网络请求；
- Cookie 仅在解析会话内存在，除非明确持久化。

---

## 17. 网络层设计

统一网络层应支持：

```ts
interface NetworkClient {
  request<T>(request: NetworkRequest): Promise<NetworkResponse<T>>;
}
```

### 必须能力

- GET/POST；
- Query/Form/JSON Body；
- 自定义 Header；
- Cookie Jar；
- 超时；
- 重定向；
- AbortSignal；
- Gzip；
- 代理；
- Host 重写；
- 错误标准化；
- 日志脱敏。

### Header 合并顺序

建议：

```text
默认 Header
    ↓
全局 Host Header
    ↓
Site.header
    ↓
Parse.header
    ↓
PlayerResult.header
    ↓
调用级 Header
```

越靠后的优先级越高。

---

## 18. mpv 播放器集成

## 18.1 接入方式

首版建议使用 mpv 子进程 + JSON IPC，开发难度低于直接绑定 libmpv。

```text
Electron Main Process
    ↓
启动 mpv
    ↓
Unix Socket IPC
    ↓
发送 loadfile / seek / pause 等命令
    ↓
接收 time-pos / duration / end-file 等事件
```

正式版本可评估 libmpv 原生嵌入。

## 18.2 播放参数

示例：

```text
--input-ipc-server=<socket>
--force-window=yes
--keep-open=yes
--hwdec=auto-safe
--cache=yes
```

请求头可转换为：

```text
--user-agent=<value>
--referrer=<value>
--http-header-fields=Cookie: ...,Origin: ...
```

## 18.3 PlayerController

```ts
interface PlayerController {
  start(): Promise<void>;
  load(media: ResolvedMedia, startPosition?: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(positionSeconds: number): Promise<void>;
  setVolume(value: number): Promise<void>;
  setSpeed(value: number): Promise<void>;
  addSubtitle(url: string): Promise<void>;
  destroy(): Promise<void>;
}
```

## 18.4 事件

至少监听：

- 播放状态；
- 当前进度；
- 总时长；
- 缓冲状态；
- 播放结束；
- 播放错误；
- 当前音轨；
- 当前字幕轨。

## 18.5 播放进度保存

建议：

- 每 10～15 秒保存一次；
- 暂停时保存；
- 切集时保存；
- 退出播放器时保存；
- 播放完成后标记完成或重置进度。

---

## 19. 数据库设计

建议使用 SQLite。

## 19.1 configs

```sql
CREATE TABLE configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_url TEXT,
  local_path TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  parsed_json TEXT,
  last_success_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## 19.2 site_states

```sql
CREATE TABLE site_states (
  config_id TEXT NOT NULL,
  site_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  searchable INTEGER NOT NULL DEFAULT 1,
  changeable INTEGER NOT NULL DEFAULT 1,
  compatibility TEXT NOT NULL,
  last_success_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (config_id, site_key)
);
```

## 19.3 histories

```sql
CREATE TABLE histories (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  site_key TEXT NOT NULL,
  vod_id TEXT NOT NULL,
  vod_name TEXT NOT NULL,
  vod_pic TEXT,
  flag TEXT,
  episode_name TEXT,
  episode_url TEXT,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

建议唯一键：

```text
config_id + site_key + vod_id
```

## 19.4 favorites

```sql
CREATE TABLE favorites (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  site_key TEXT NOT NULL,
  vod_id TEXT NOT NULL,
  vod_name TEXT NOT NULL,
  vod_pic TEXT,
  vod_snapshot TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(config_id, site_key, vod_id)
);
```

## 19.5 settings

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
```

---

## 20. IPC 设计

Renderer 不直接访问文件、数据库、网络运行时和 mpv。

Preload 暴露最小 API：

```ts
interface DesktopApi {
  config: {
    list(): Promise<ConfigSummary[]>;
    add(input: AddConfigInput): Promise<ConfigSummary>;
    refresh(id: string): Promise<ConfigSummary>;
    activate(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  site: {
    list(configId: string): Promise<SiteSummary[]>;
    test(configId: string, siteKey: string): Promise<SiteTestResult>;
  };
  search: {
    start(input: SearchInput): Promise<{ searchId: string }>;
    stop(searchId: string): Promise<void>;
    onProgress(listener: (event: SearchProgressEvent) => void): () => void;
  };
  vod: {
    detail(input: DetailInput): Promise<VodDetail>;
  };
  playback: {
    resolve(input: ResolveInput): Promise<ResolvedMedia>;
    open(input: OpenPlayerInput): Promise<void>;
    control(command: PlayerCommand): Promise<void>;
    onEvent(listener: (event: PlayerEvent) => void): () => void;
  };
  history: {
    list(): Promise<HistoryItem[]>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
  };
}
```

所有 IPC 调用应验证参数，禁止 Renderer 传递任意文件路径或命令。

---

## 21. 错误模型

统一错误：

```ts
interface AppError {
  code: string;
  message: string;
  stage:
    | 'config'
    | 'source-init'
    | 'search'
    | 'detail'
    | 'player-content'
    | 'resolve'
    | 'sniff'
    | 'player'
    | 'storage';
  configId?: string;
  siteKey?: string;
  resolverName?: string;
  retryable: boolean;
  cause?: string;
}
```

建议错误码：

```text
CONFIG_DOWNLOAD_FAILED
CONFIG_INVALID_JSON
CONFIG_UNSUPPORTED_FORMAT
SOURCE_UNSUPPORTED
SOURCE_INIT_FAILED
SOURCE_TIMEOUT
SOURCE_INVALID_RESULT
SEARCH_CANCELLED
DETAIL_EMPTY
PLAYER_CONTENT_FAILED
MEDIA_URL_EMPTY
JSON_PARSE_FAILED
WEB_SNIFF_TIMEOUT
MPV_START_FAILED
MPV_PLAYBACK_ERROR
DATABASE_ERROR
```

---

## 22. 日志设计

日志应结构化并按模块记录：

```json
{
  "level": "info",
  "module": "search",
  "requestId": "...",
  "searchId": "...",
  "siteKey": "...",
  "elapsedMs": 523,
  "message": "site search completed"
}
```

禁止默认记录：

- Cookie 完整内容；
- Authorization；
- Token；
- 带签名的完整播放 URL；
- 用户本地文件内容。

可对 URL query 中敏感字段脱敏。

---

## 23. 安全设计

## 23.1 Electron

- `nodeIntegration=false`；
- `contextIsolation=true`；
- `sandbox=true`；
- 仅通过 preload 暴露白名单 API；
- 禁止任意导航；
- 禁止 Renderer 直接执行系统命令。

## 23.2 插件

- JS 插件隔离在 Worker/子进程；
- 限制文件系统访问；
- 限制模块加载；
- 统一网络层；
- 超时后终止；
- 插件缓存按哈希管理；
- 下载插件可记录来源和校验值。

## 23.3 播放器

- mpv 参数采用数组传递，禁止拼接 Shell 命令；
- IPC Socket 使用应用私有目录；
- 播放地址和 Header 传递时避免日志泄露；
- 退出应用时销毁 mpv 进程。

---

## 24. 测试策略

## 24.1 单元测试

重点覆盖：

- 配置字段解析；
- 相对 URL 转换；
- XML/JSON Result 解析；
- `vod_play_from` 和 `vod_play_url` 拆分；
- Header 合并；
- 解析器选择；
- 错误标准化。

## 24.2 集成测试

建立固定 Fixture：

```text
fixtures/
├── config-type1.json
├── config-type4.json
├── config-js.json
├── result-search.json
├── result-detail.json
├── result-player-direct.json
├── result-player-parse.json
└── sample-spider.js
```

覆盖：

- 配置 → 站点；
- 搜索 → 结果；
- 详情 → 线路和剧集；
- 播放调用 → 解析；
- 最终媒体 URL。

## 24.3 兼容性测试

为每个实际播放源维护：

| 配置 | 站点 | 类型 | 首页 | 搜索 | 详情 | 播放 | 备注 |
|---|---|---:|---:|---:|---:|---:|---|
| 示例配置 | 站点A | 1 | ✅ | ✅ | ✅ | ✅ | 直链 |
| 示例配置 | 站点B | 3-JS | ✅ | ✅ | ✅ | ⚠️ | 需补函数 |
| 示例配置 | 站点C | 3-JAR | ❌ | ❌ | ❌ | ❌ | 暂不支持 |

## 24.4 播放测试

至少覆盖：

- MP4；
- 普通 HLS；
- 带 Referer 的 HLS；
- 带 Cookie 的 HLS；
- JSON 解析器；
- 播放进度；
- 自动下一集；
- 播放失败。

---

## 25. 构建与分发

## 25.1 开发阶段

- 先支持 Apple Silicon；
- mpv 可通过 Homebrew 或项目 resources 引入；
- 使用 Electron Builder 打包；
- 开发版允许未签名运行。

## 25.2 正式分发

需要完成：

- Universal Binary 或分别构建 arm64/x64；
- 应用签名；
- Hardened Runtime；
- Apple 公证；
- mpv 和动态库签名；
- 自动更新；
- 外部运行时和插件执行策略验证。

---

## 26. 分阶段实施方案

## 阶段一：核心链路验证

目标：不做完整 UI，用命令行证明链路可行。

实现：

1. ConfigLoader；
2. `type=1` HTTP Source；
3. Result/Vod/Flag/Episode 解析；
4. 搜索、详情和 playerContent；
5. DirectResolver；
6. JsonApiResolver；
7. mpv IPC；
8. 一个端到端测试源。

验收：

```text
配置 URL
  → 站点
  → 搜索
  → 详情
  → 线路/剧集
  → 最终 URL
  → mpv 播放
```

## 阶段二：JavaScript Spider

实现：

1. Worker Runtime；
2. Spider RPC；
3. Host Network API；
4. 插件缓存；
5. 超时和重建；
6. 代表性 JS 源兼容。

## 阶段三：桌面 MVP

实现：

- 配置页；
- 搜索页；
- 详情页；
- 播放页；
- 历史和收藏；
- 基础设置。

## 阶段四：兼容性增强

实现：

- 首页和分类；
- Web 嗅探；
- 代理；
- 字幕；
- 更多 JS 兼容 API；
- 站点健康检测。

## 阶段五：发布准备

实现：

- 稳定性优化；
- 自动化测试；
- 崩溃日志；
- 签名、公证和安装包；
- 版本升级。

---

## 27. 第一阶段任务拆分

建议按以下顺序开发：

### T01 工程初始化

- Electron + Vue 3 + TypeScript；
- 主进程、preload、renderer；
- 基础 IPC；
- 日志和测试框架。

### T02 核心模型

- VodConfig；
- Site；
- Result；
- Vod；
- Flag；
- Episode；
- PlayerResult；
- ResolvedMedia。

### T03 配置解析

- 远程配置下载；
- 本地配置读取；
- 相对 URL 解析；
- 配置缓存；
- 错误模型。

### T04 HTTP Source

- type=0；
- type=1；
- type=4；
- XML/JSON 解析；
- Header 和超时。

### T05 搜索服务

- 单源搜索；
- 多源搜索；
- searchId；
- 取消；
- 增量事件。

### T06 详情与线路

- detailContent；
- Vod 标准化；
- Flag/Episode 拆分；
- 容错测试。

### T07 播放解析

- playerContent；
- DirectResolver；
- PrefixResolver；
- JsonApiResolver；
- Header 合并。

### T08 mpv

- 启动和退出；
- IPC；
- loadfile；
- 播放控制；
- 进度事件；
- 请求头传递。

### T09 数据库

- configs；
- site_states；
- histories；
- favorites；
- settings。

### T10 端到端验证

- 导入真实配置；
- 搜索；
- 详情；
- 解析；
- 播放；
- 续播。

---

## 28. 关键技术决策

### 决策一：先核心引擎，后 UI

原因：最大风险在播放源兼容，不在页面开发。

### 决策二：第一版采用 Electron

原因：JS Spider、Chromium WebView 和 mpv 集成更容易。

### 决策三：JAR Spider 暂不兼容

原因：Android Dex/JAR 不能直接在 macOS 运行。

### 决策四：搜索结果增量返回

原因：保留原项目体验，避免慢站点阻塞整体。

### 决策五：不合并同名搜索结果

原因：不同站点代表不同资源，首版合并会增加详情和线路映射复杂度。

### 决策六：mpv 作为唯一播放器内核

原因：减少首版复杂度，并提高网络媒体兼容性。

### 决策七：外部插件必须隔离

原因：远程插件不可信，不能运行在 Renderer 或主进程上下文。

---

## 29. 当前技术风险排序

1. JavaScript Spider 对宿主内置函数的依赖范围未知；
2. 常用配置中 JAR Spider 占比可能较高；
3. 部分播放地址依赖 Web 嗅探；
4. 带 Cookie、Referer 和临时签名的媒体地址容易失效；
5. Electron 内嵌 mpv 的窗口集成需要实际验证；
6. 正式签名和公证可能限制外部插件执行；
7. 播放源本身不稳定，测试结果可能随时间变化。

---

## 30. 下一步技术验证建议

在开始完整开发前，建议先选取三类真实样例：

```text
样例 A：type=1 HTTP JSON 源
样例 B：JavaScript Spider 源
样例 C：Android JAR Spider 源
```

验证并记录：

- 配置是否可解析；
- 搜索接口；
- 详情接口；
- 线路和剧集；
- playerContent；
- 是否需要 JSON 解析；
- 是否需要 Web 嗅探；
- 是否需要特殊协议；
- 是否依赖 Android 特有 API。

该验证结果将决定首版真实兼容范围和 JavaScript Runtime 的具体实现清单。
