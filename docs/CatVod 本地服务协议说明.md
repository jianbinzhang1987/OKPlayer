# CatVod 本地服务协议说明

> 版本：v1.0  
> 项目：FongMi macOS  
> 更新日期：2026-07-27

---

## 1. 服务边界

CatVod Node JS 服务运行在 Electron Utility Process 中，只监听 `127.0.0.1` 的动态端口。Renderer 不直接访问本地服务，也不能指定任意本地脚本路径；所有服务控制和播放代理均经过主进程 IPC 或应用内部协议。

运行链路：

```text
Renderer
  → Electron IPC
  → AppService / CatVodNodeClient
  → http://127.0.0.1:<动态端口>
  → CatVod bootstrap
  → index.js
```

服务端口变化后，图片、媒体、字幕和弹幕通过稳定内部协议继续访问：

```text
fongmi-catvod://...
fongmi-media://session/...
```

---

## 2. 服务级接口

### 2.1 健康检查

```http
GET /health
```

期望响应：

```json
{
  "ok": true
}
```

用途：

- 判断子进程是否已完成启动；
- 启动阶段轮询；
- 服务级可用性检查；
- 不用于逐个检测 79 个子站点。

### 2.2 动态配置

```http
GET /config
```

主要字段：

```json
{
  "video": {
    "sites": []
  }
}
```

客户端处理：

- 将服务站点转换为动态 `SiteConfig`；
- 站点 key 增加 `catvod:` 前缀；
- 保留原始 Spider key；
- 识别 discovery、vod、pan、live、short-drama、comic、tool；
- 工具、直播、漫画等内容不进入普通影视选择器。

---

## 3. Spider 操作接口

基础路径：

```text
/spider/{spiderKey}/3/{operation}
```

当前支持操作：

```text
init
home
category
search
detail
play
```

请求使用 `POST application/json`。

### 3.1 init

```http
POST /spider/{key}/3/init
```

用于初始化站点。站点无需额外初始化时允许返回空对象。

### 3.2 home

```http
POST /spider/{key}/3/home
```

请求样例：

```json
{
  "filter": true
}
```

可返回：

- `class`：分类数组；
- `filters`：动态筛选；
- `list`：首页内容；
- `page`、`pagecount`、`total`、`limit`：分页信息。

### 3.3 category

```http
POST /spider/{key}/3/category
```

请求样例：

```json
{
  "id": "category-id",
  "tid": "category-id",
  "page": 1,
  "pg": 1,
  "filters": {},
  "extend": {}
}
```

兼容要求：

- 分类显示名称与请求 ID 分离；
- 同时发送 `id/tid`；
- 同时发送 `page/pg`；
- 动态筛选同时发送 `filters/extend`。

### 3.4 search

```http
POST /spider/{key}/3/search
```

请求样例：

```json
{
  "wd": "庆余年",
  "key": "庆余年",
  "page": 1,
  "pg": 1,
  "quick": false
}
```

客户端支持：

- 当前来源搜索；
- 多配置、多来源聚合搜索；
- 按来源继续加载下一页；
- 结果按 `siteKey + vodId` 去重；
- 搜索取消、单源超时和全局超时。

### 3.5 detail

```http
POST /spider/{key}/3/detail
```

请求样例：

```json
{
  "id": ["vod-id"]
}
```

客户端解析：

- `vod_play_from`；
- `vod_play_url`；
- 线路、剧集名称和原始剧集标识；
- discovery、folder、action、live 等内容类型。

### 3.6 play

```http
POST /spider/{key}/3/play
```

请求样例：

```json
{
  "flag": "线路名称",
  "id": "原始剧集标识",
  "flags": []
}
```

兼容响应字段：

```text
parse / jx
url
header / headers
playUrl
format
subt / subtitle
subtitleUrl
danmu / danmaku
danmuUrl
```

播放结果进入现有 Resolver、媒体探测、网页嗅探和内置播放器降级链。

---

## 4. 内容类型路由

| 类型 | 默认行为 |
|---|---|
| playable | 打开详情并播放 |
| discovery | 按影片名称进入全局搜索 |
| folder | 打开目录或分类 |
| action | 路由到设置或配置中心 |
| live | 不进入普通点播流程 |
| tool | 默认隐藏 |
| comic | 默认隐藏 |
| short-drama | 首期不进入普通影视搜索 |

---

## 5. 宿主消息通道

Bootstrap 将 `messageToDart` 转发至 Electron 主进程。当前支持：

| action | 主进程处理 |
|---|---|
| queryProfile | 从 SQLite 读取 Profile |
| saveProfile | 写入 SQLite |
| toast | 转成 Renderer 通知 |
| openInternalWebview | 使用隔离 BrowserWindow 打开配置中心 |
| danmuPush | 转发弹幕信息到 Renderer |

隔离窗口配置：

```text
contextIsolation = true
nodeIntegration = false
sandbox = true
```

---

## 6. 错误分类

客户端统一转换为中文可诊断错误：

- CatVod 服务未启动；
- 健康检查超时；
- `/config` 响应无效；
- 站点不可用或已被屏蔽；
- 请求超时；
- 搜索、详情返回为空；
- 没有可播放剧集；
- 没有有效播放地址；
- 媒体代理失败；
- 播放准备被取消；
- 播放期间禁止重启或切换服务版本。

错误信息不得包含完整 Cookie、Authorization、Token、账号或密码。

---

## 7. 安全和更新约束

- `.md5` 地址只允许 HTTP/HTTPS；
- 下载脚本最大 32 MB；
- 同时校验 MD5 并记录 SHA-256；
- 新版本先保存为候选版本，不自动执行；
- 候选版本必须通过健康检查和配置检查；
- 用户确认后才能激活；
- 保留上一版本并支持回滚；
- 子进程只接收允许清单中的环境变量；
- 服务只监听 `127.0.0.1`；
- 日志按大小滚动并执行敏感信息脱敏。
