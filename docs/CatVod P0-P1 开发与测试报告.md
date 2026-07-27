# CatVod P0-P1 开发与测试报告

> 报告日期：2026-07-27  
> 项目：FongMi macOS  
> 依据：`CatVod Node JS 服务开发任务清单.md`、`Mac 客户端接入 CatVod Node JS 服务修改方案.docx`  
> **后续更新**：播放源快速选择页和顶部来源选择器已经确认并进入正式版本；搜索分页、来源失效重新找源、日志滚动、生命周期 E2E、性能与安全审计已经补齐。当前状态以 `CatVod 任务清单完成情况与后续计划.md` 为准。

---

## 1. 总体结论

本轮已经完成 CatVod Node JS 服务的 P0 核心闭环和主要 P1 基础能力：

```text
index.js.md5
→ 下载与完整性校验
→ 版本缓存、候选和回滚
→ Bootstrap 宿主桥
→ 本地 Node 服务
→ /config 动态站点
→ 首页、分类、筛选、分页
→ 搜索、详情、播放
→ 图片和视频代理
→ 字幕会话
→ 现有内置播放器
```

真实服务验证结果：

- 当前远程 MD5：`f19e5f02c106283ca5a599acea2c040b`
- 当前 SHA-256：`8e28b4fcc0ca4c99d30de4ebf45500c74f4146f81242d9791803aedac3049063`
- 加载站点：79 个
- 发现型站点：1 个
- 普通影视站点：62 个
- 首期默认隐藏：16 个
- 豆瓣首页返回：20 条
- 豆瓣分类返回：20 条
- 完整播放抽样：`天堂|采集`
- 抽样关键词：`庆余年`
- 已完成：搜索、详情、线路、剧集、播放地址和 Header 验证

---

## 2. P0 已完成功能

### 2.1 脚本下载和版本管理

已实现：

- `.md5` 格式校验；
- 自动推导同路径 `index.js`；
- 下载超时和最大文件大小限制；
- MD5 完整性校验；
- SHA-256 审计指纹；
- 按 MD5 保存版本目录；
- 当前版本、候选版本、上一版本；
- 候选版本与当前版本隔离；
- 手动激活候选版本；
- 版本回滚；
- 原子写入 manifest；
- 损坏文件不会被激活。

主要文件：

```text
src/core/catvod/catvod-types.ts
src/core/catvod/catvod-bundle-manager.ts
```

### 2.2 独立服务进程

已实现：

- Electron Utility Process 运行时；
- 独立 Bootstrap 入口；
- 下载脚本不直接进入 Electron 主进程；
- 仅监听 `127.0.0.1`；
- 动态分配端口；
- `/health` 和 `/config` 启动检测；
- 一次异常自动重启；
- 主应用退出时停止子进程；
- 最小环境变量传递；
- 日志敏感字段脱敏；
- 候选版本独立冒烟检查。

主要文件：

```text
src/desktop/catvod-bootstrap.ts
src/desktop/catvod-process-manager.ts
scripts/build-desktop.mjs
```

### 2.3 CatVod 协议和 Adapter

已实现：

- `/health`；
- `/config`；
- `/init`；
- `/home`；
- `/category`；
- `/search`；
- `/detail`；
- `/play`；
- 分类请求兼容 `id/tid`；
- 分页请求兼容 `page/pg`；
- 搜索请求兼容 `wd/key`；
- 动态筛选兼容 `filters/extend`；
- 播放结果兼容 `parse/jx`、`header/headers`、`subt/subtitle`、`danmu/danmaku`；
- 发现型、播放型、工具型、直播型、短剧、漫剧和网盘站点分类。

主要文件：

```text
src/core/catvod/catvod-node-client.ts
src/core/catvod/catvod-config-parser.ts
src/core/catvod/catvod-node-adapter.ts
src/core/catvod/catvod-url-rewriter.ts
```

### 2.4 动态站点和现有业务集成

已实现：

- 新增 `catvod-node` 运行时；
- CatVod 子站点动态注册；
- 不修改用户原始 TVBox 配置；
- 动态站点 key 增加 `catvod:` 前缀；
- 原有配置源和 CatVod 动态站点可并存；
- 没有用户配置时也可单独运行 CatVod；
- 应用首页优先使用发现型内容；
- 豆瓣等发现型内容不调用空详情和空播放；
- 发现型内容点击后进入全局搜索；
- 全局搜索默认排除 discovery、tool、live、comic；
- 工具、直播和版本站点默认隐藏；
- 服务级检查与子站点深度检查分离；
- 自动启动不阻塞主窗口显示。

主要文件：

```text
src/core/app-service.ts
src/core/source-capability.ts
src/core/source-adapter-factory.ts
src/core/provider-replacement-registry.ts
```

### 2.5 分类、筛选和分页

已实现：

- 分类 ID 与显示名称分离；
- 兼容旧字符串分类；
- CatVod `class` 转换为统一分类模型；
- CatVod `filters` 转换为统一筛选模型；
- 服务端动态筛选；
- 无动态筛选的旧来源继续使用本地地区和年份降级筛选；
- 片库分类分页；
- “加载更多”；
- 分页结果去重；
- 切换来源、分类或筛选时重置状态。

主要文件：

```text
src/core/models.ts
src/core/config-loader.ts
src/core/vod-parser.ts
src/desktop/renderer/App.vue
```

### 2.6 本地代理和播放

已实现：

- 稳定协议 `fongmi-catvod://`；
- 动态端口映射；
- 图片代理；
- 视频代理；
- Range 请求透传；
- Referer 和其他播放 Header 透传；
- CatVod 本地代理 URL 自动替换为当前服务端口；
- 播放历史保存原始剧集标识，而非最终临时播放 URL；
- 现有内置播放器和兼容模式保持不变。

主要文件：

```text
src/desktop/catvod-protocol-service.ts
src/desktop/media-protocol/playback-session-store.ts
src/desktop/desktop-playback-service.ts
```

### 2.7 更新和安全

已实现：

- Renderer 不能指定任意本地脚本路径；
- 仅允许 HTTP/HTTPS MD5 地址；
- MD5 不作为唯一审计信息，同时记录 SHA-256；
- 远程更新只下载候选版本，不自动执行；
- 候选版本通过服务冒烟后才允许激活；
- 保留上一版本；
- 可回滚；
- 不向子进程传递主应用非必要环境变量；
- Cookie、Token、Authorization、账号和密码日志脱敏；
- CatVod 服务异常不影响现有其他运行时。

---

## 3. P1 已完成或部分完成功能

### 3.1 宿主桥

已完成：

- `messageToDart` 通过本地桥接返回主进程；
- `queryProfile`；
- `saveProfile`；
- `toast`；
- `openInternalWebview`；
- `danmuPush` 消息传递；
- 配置 Profile 持久化到 SQLite；
- 配置中心使用隔离 BrowserWindow；
- 配置中心窗口启用 `contextIsolation`、关闭 `nodeIntegration`、启用 `sandbox`。

### 3.2 设置页

已完成：

- MD5 地址；
- 服务状态；
- 当前版本；
- 站点数量；
- 本地端口；
- 启动；
- 停止；
- 重启；
- 检查更新；
- 测试并激活候选版本；
- 回滚；
- 打开配置中心；
- 查看日志路径。

### 3.3 字幕和弹幕

字幕已完成：

- CatVod 字幕地址进入 `PlayerResult`；
- 字幕进入 `ResolvedMedia`；
- 字幕注册为受保护播放会话资源；
- Header 由主进程统一代理；
- 内置播放器通过 `<track>` 加载字幕。

弹幕代码闭环已完成：

- 弹幕地址已经进入播放会话；
- `danmuPush` 已经能够到达 Renderer；
- 新增 JSON/XML 弹幕解析器；
- 新增共享弹幕叠层组件；
- ArtPlayer 与稳定播放器均支持滚动、顶部、底部弹幕和弹幕开关。

尚待真实弹幕样本验收和高弹幕量性能观察。

### 3.4 配置与账号

已完成：

- Profile 读写桥；
- CatVod 自带配置中心入口；
- 可通过配置中心管理服务支持的账号和 Cookie；
- 账号与网盘页支持夸克、UC、百度、115、天翼、移动网盘状态展示和应用内扫码；
- UC 支持 Cookie 与 TV Token 两种登录模式；
- 已提供单网盘清除凭据入口。

尚未实现：

- 完全原生的各网盘账号表单；
- Renderer 中直接展示或编辑敏感 Cookie。

暂不直接在 Renderer 中实现的原因：需要先确认凭据字段、加密和交互范围，当前通过隔离配置中心已经可以使用。

---

## 4. 已确认并进入正式版本的播放源页面

播放源原型已经确认并完成正式开发：

1. 播放源页面调整为纯快速选择页；
2. 顶部普通 `<select>` 已替换为可搜索、可分组的来源选择器；
3. 支持最近使用、4K、秒播、采集和关键词搜索；
4. 服务版本、端口、日志、更新、配置导入和异常检测统一迁移到设置页；
5. 工具、直播、漫画和异常来源不进入普通影视选择器。

原“服务实例—子站点两级管理页”不再实施，属于经确认的方案替代，而不是遗留未完成项。

---

## 5. 暂未完成的 P1/P2 能力

以下能力仍保留为后续增强：

- 原生网盘账号和 Cookie 管理表单；
- 真实多层网盘目录、分页和文件播放样本验收；
- 真实弹幕/字幕样本验收和高弹幕量性能观察；
- Profile 敏感凭据加密存储；
- 直播专用播放模式；
- 短剧专用页面；
- 漫剧/漫画专用页面；
- 远程版本数字签名或独立可信签名体系；
- 自动灰度切换和长期运行失败自动回退。

搜索分页、收藏来源失效重新找源、远程访问审计和启动阶段阻止策略已在后续迭代中完成。

---

## 6. 自动化测试结果

最终完整测试：

```text
测试总数：140
通过：140
失败：0
跳过：0
```

执行命令：

```bash
npm test
npm run typecheck
npm run build
npm run audit:catvod:live
npm run audit:catvod:performance
npm run audit:catvod:security
npm run e2e:catvod
npm run e2e:catvod:lifecycle
```

执行结果：

- `npm test`：通过；
- `npm run typecheck`：通过；
- `npm run build`：通过；
- `npm run audit:catvod:live`：5 个真实站点通过；
- `npm run audit:catvod:performance`：通过；
- `npm run audit:catvod:security`：16/16 通过；
- `npm run e2e:catvod`：27/27 通过；
- `npm run e2e:catvod:lifecycle`：10/10 通过。

新增测试：

```text
tests/catvod-bundle-manager.test.ts
tests/catvod-config-parser.test.ts
tests/catvod-node-adapter.test.ts
tests/catvod-url-rewriter.test.ts
tests/catvod-protocol-service.test.ts
tests/catvod-subtitle-playback.test.ts
tests/app-service-catvod-dynamic.test.ts
tests/app-service-search-pagination.test.ts
tests/catvod-network-audit.test.ts
tests/catvod-process-logging.test.ts
tests/renderer-catvod.test.ts
```

覆盖范围：

- MD5 和脚本下载；
- MD5 不匹配；
- 候选版本；
- 激活和回滚；
- 79 站点配置解析；
- 站点分类；
- 分类 ID；
- 动态筛选；
- 搜索、详情和播放请求体；
- 播放 Header；
- 动态端口重写；
- 稳定代理；
- Range 和 Referer；
- 动态 AppService；
- 发现型首页；
- 全局搜索排除规则；
- 字幕和弹幕会话；
- Renderer IPC 隔离；
- 播放源快速选择页和顶部来源选择器；
- 搜索分页与来源失效重新找源；
- 远程访问 origin 审计和启动阶段阻止策略；
- 日志滚动和凭据脱敏；
- Utility Process 异常退出自动恢复。

---

## 7. 真实服务测试结果

真实测试入口：

```bash
npm run audit:catvod:live
```

验证路径：

```text
下载并校验真实 index.js
→ 通过已构建 catvod-bootstrap.cjs 启动
→ /health
→ /config
→ 豆瓣首页
→ 豆瓣分类
→ 普通影视站点搜索
→ 详情
→ 播放
```

最终抽样结果：

```json
{
  "status": "passed",
  "versionMd5": "f19e5f02c106283ca5a599acea2c040b",
  "siteCount": 79,
  "homeCount": 20,
  "categoryCount": 20,
  "playableSourceCount": 5,
  "siteNames": ["天堂|采集", "爱看|采集", "瓜子|秒播", "独播|秒播", "文采|秒播"],
  "urlKind": "remote",
  "allHaveHeaders": true,
  "hasLocalProxySource": false
}
```

---

## 8. Electron 生命周期与 GUI 验证

直接调用 Electron 的旧 smoke runner 在当前工具环境仍可能卡在 `app.ready`，因此正式验收改用已经稳定运行的 Playwright Electron 通道：

```text
npm run e2e:catvod
npm run e2e:catvod:lifecycle
```

实际结果：

- 主流程 GUI E2E：27/27；
- 服务生命周期 E2E：10/10；
- 启动、停止、换端口重启和再次启动：通过；
- 远程访问允许/阻止策略：通过；
- 强制终止 Utility Process 后自动重启：通过；
- 应用退出后服务端口释放：通过；
- 真实服务日志归档和凭据扫描：通过。

旧 `smoke:catvod` 脚本继续保留为开发辅助工具，但不再作为正式验收唯一入口。

---

## 9. 主要修改文件

### 新增

```text
src/core/catvod/catvod-types.ts
src/core/catvod/catvod-bundle-manager.ts
src/core/catvod/catvod-node-client.ts
src/core/catvod/catvod-config-parser.ts
src/core/catvod/catvod-node-adapter.ts
src/core/catvod/catvod-url-rewriter.ts
src/desktop/catvod-bootstrap.ts
src/desktop/catvod-process-manager.ts
src/desktop/catvod-protocol-service.ts
scripts/audit-catvod-live.ts
scripts/smoke-catvod.ts
scripts/run-catvod-smoke.mjs
```

### 修改

```text
src/core/models.ts
src/core/config-loader.ts
src/core/vod-parser.ts
src/core/resolver.ts
src/core/app-service.ts
src/core/source-capability.ts
src/core/source-adapter-factory.ts
src/core/provider-replacement-registry.ts
src/desktop/main.ts
src/desktop/preload.ts
src/desktop/register-ipc.ts
src/desktop/desktop-playback-service.ts
src/desktop/media-protocol/playback-session-store.ts
src/desktop/renderer/App.vue
src/desktop/renderer/components/EmbeddedPlayer.vue
src/desktop/renderer/styles.css
scripts/build-desktop.mjs
package.json
```

---

## 10. 下一步建议

下一步不建议继续直接扩大正式页面改动。应先确认：

```text
docs/prototypes/CatVod 播放源管理与来源选择器原型.html
```

重点确认：

1. 播放源页面是否采用“CatVod 服务卡 + 分组子站点”的结构；
2. 顶部来源选择器是否采用右侧浮层；
3. 是否默认只显示普通影视来源；
4. 直播、短剧、漫剧和工具是否继续隐藏；
5. 子站点是否需要提供启停、隐藏、检测和设默认四个操作。

确认后再实施正式的大页面替换。
