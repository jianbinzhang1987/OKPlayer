# 后续实施路线与跟进清单

## 阶段 A：适配器基础重构

目标：让所有 Source 都通过统一能力模型管理。

### 任务

- [x] 定义 `SourceCapability`；
- [x] 定义 `SourceAdapter`；
- [x] 建立 `SourceAdapterFactory`；
- [x] 将 HttpSource 纳入 Adapter；
- [x] 将 JsSiteAdapter 纳入 Adapter；
- [x] 统一错误模型；
- [x] 统一日志和超时；
- [x] UI 显示 runtime、supported、reason、capabilities。

### 完成标准

```text
配置加载后，每个站点都能得到：
runtime
supported
capabilities
reason
```

## 阶段 B：T4Adapter

目标：接入现有 T4 服务。

### 方法

```text
home
category
search
detail
player
proxy
```

### 任务

- [x] 确认接口参数；
- [x] 支持远程 T4；
- [x] 支持本机 localhost T4；
- [x] 支持 Header 和超时；
- [x] 支持健康检查；
- [x] 支持失败降级；
- [ ] 真实源回归（当前已完成本地模拟 T4 服务自动化回归）。

## 阶段 C：DrpyAdapter MVP

目标：用纯 Node/Worker 跑通 drpy 搜索、详情和播放。

### MVP 范围

- [x] JS Worker（规则初始化隔离执行）；
- [x] request（宿主统一网络请求与超时）；
- [x] Cookie（同域 CookieJar）；
- [x] HTML selector（常用 CSS 选择器、`&&Text`、属性提取、`:eq`）；
- [x] base64；
- [x] 常用 hash（MD5、SHA-1、SHA-256）；
- [x] localStorage（站点运行期内存存储）；
- [x] search；
- [x] detail；
- [x] player。

### 当前实现边界

声明式规则支持 HTML/JSON 列表、字段级 `*` 继承、POST 地址、筛选模板、`二级.tabs`、`tab_text`、`lists`、`list_text`、`list_url` 和图片域名替换。

动态 `js:` 已通过独立 Worker 和受控宿主 RPC 接入 `预处理`、`推荐`、`一级`、`搜索`、`二级`、对象二级中的动态 `TABS/LISTS` 与 `lazy`，提供同步 request/fetch/post、Cookie、fetch_params Header 继承、选择器、存储、base64/hash 和结果回传。默认禁止任意 eval/Function/Wasm 字符串生成，并阻断 localhost、内网、链路本地地址及解析到内网的域名；同时限制操作时长、请求次数和响应大小。为兼容页面中的 `audio: [{...}]` 数据，规则调用的 `eval` 仅映射为不执行表达式的宽松数据字面量解析器。

- [x] 固定上游提交并审计 5 个公开 Drpy 规则，均可下载和初始化；
- [x] 根据真实规则补充 `$js.toString`、UA 常量、JSON 路径、POST、字段继承和筛选模板；
- [x] 设计并实现动态 `js:` 操作的受控执行环境；
- [x] 本地自动化覆盖动态预处理、推荐、分类、搜索、详情线路、对象二级动态 TABS/LISTS 和 lazy 播放闭环；
- [x] 固定公开规则动态宿主审计：8 个动态操作未发现已知 API 缺口，2 个无网络 lazy 实际 Worker 执行通过；
- [x] 首批在线回归：相声随身听首页 12 项、首项详情 1 条线路/50 个音频、lazy 直链成功；
- [ ] 扩大在线回归样本；03影院域名当前解析到内网并被安全策略阻断，可可影视当前返回非标准 HTTP 850；
- [ ] 根据新失败样本补充专用加密、验证码、浏览器及其他规则宿主 API。

### 不在 MVP

- 全量加密算法；
- 所有旧 drpy 兼容；
- Python；
- Android Context；
- JNI。

## 阶段 D：BrowserSnifferAdapter

目标：处理网页解析和媒体嗅探。

### 架构

```text
Electron hidden BrowserWindow
├── isolated session
├── webRequest
├── response headers
├── Cookie
├── referer
└── candidate ranking
```

### 候选媒体

- `.m3u8`
- `.mp4`
- `.flv`
- `.mpd`
- MIME video/audio
- 带签名的无扩展 URL

### 任务

- [x] 创建独立临时 Session；
- [x] 隐藏 BrowserWindow 嗅探窗口；
- [x] 请求、响应头与重定向监听；
- [x] 默认及配置广告排除；
- [x] HLS、DASH、MP4、带签名无扩展 URL 候选排序；
- [x] HLS/DASH/MP4 内容前缀验证，过滤 HTML 伪媒体响应；
- [x] 对明确播放控件和 video/audio 执行受限自动激活，并覆盖子框架；
- [x] 用户取消、超时与资源清理；
- [x] Cookie、Referer、User-Agent 等 Header 回传；
- [x] 常规解析失败后降级到嗅探并交给 mpv 播放；
- [x] BrowserSniffer 烟雾测试与公网回归脚本采用结果文件强校验，避免仅凭 Electron 退出码误判；
- [x] Mux HLS、DASH-IF MPD、Video.js MP4 公网媒体资源审计；
- [ ] 在普通 macOS GUI 会话执行隐藏窗口本地烟雾测试（当前远程终端受 Mach-port 权限限制）；
- [ ] 真实互联网解析页成功率回归与规则调优。

## 阶段 E：高频源迁移

目标：选择少量高价值源迁移到 JS/Drpy。

### 评估模板

```text
源名称：
当前运行时：
是否有源码：
是否依赖 Android：
是否依赖 JNI：
是否有网页：
是否有公开 API：
迁移难度：
维护频率：
是否值得迁移：
```

### NewWoggGuard 当前结论

```text
Android Dex
Android ARM/ARM64 .so
加固
当前不建议迁移
```

除非找到：

- 公开 JS 版本；
- T4 版本；
- 未加固源码；
- 可复现网页 API。

## 阶段 F：可选 Sidecar

目标：按需支持 Python/Playwright。

### 原则

- 默认不随主应用启动；
- 可选下载；
- 仅监听 localhost；
- Token 鉴权；
- 有资源限制；
- 有版本和健康检查；
- 可一键卸载。

## 建议排期顺序

```text
1. T4Adapter
2. AdapterFactory 重构
3. Drpy MVP
4. BrowserSniffer
5. 高频源迁移
6. Python Sidecar
7. Desktop Java Provider
8. Android Bridge
```

## 决策检查点

### 检查点 1

T4 能否覆盖用户常用源？

### 检查点 2

Drpy MVP 能否稳定跑通 3～5 个公开源？

### 检查点 3

BrowserSniffer 对解析页成功率是否达到可接受水平？

### 检查点 4

仍有多少高价值源必须依赖 Android？

只有第 4 个答案仍然很高时，才重新评估 Android Bridge。
