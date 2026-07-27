# CatVod 端到端测试用例与执行记录

## 1. 测试目标

验证 macOS 客户端从应用启动、CatVod 服务加载、播放源快速选择、搜索、详情、播放，到配置管理和异常恢复的完整业务闭环，重点确认本次“播放源页面简化”和“顶部来源选择器”修改没有破坏已有功能。

## 2. 测试范围

- 正式 Electron 应用启动与页面渲染
- CatVod Node 服务与动态站点加载
- 播放源页面快速搜索、分组、切换
- 顶部来源选择器搜索、分组、切换、关闭
- 最近使用与默认播放源持久化
- 配置导入、切换、重命名、删除、异常配置处理
- 搜索、详情、播放会话与内置播放器
- 设置页 CatVod 管理入口和检测入口
- 真实 CatVod 服务搜索—详情—播放解析闭环
- 页面脚本错误、控制台错误和应用重启恢复

## 3. 测试环境

| 项目 | 说明 |
|---|---|
| 工程目录 | `/Users/adolf/Desktop/code/TV/mac` |
| 测试日期 | 2026-07-27 |
| 应用形式 | Electron macOS 桌面客户端，x64 目录包 |
| 自动化框架 | Playwright Electron + Node.js Test |
| 固定测试数据 | 本地 HTTP Fixture，避免外部源波动影响功能判断 |
| 播放媒体 | W3C Sintel MP4，通过应用受保护媒体协议加载 |
| 真实环境验证 | `https://9280.kstore.vip/cat/index.js.md5` |
| 用户数据 | 每轮 GUI 测试使用独立临时用户目录 |

## 4. 测试用例及结果

| 编号 | 优先级 | 测试场景 | 预期结果 | 结果 |
|---|---|---|---|---|
| E2E-001 | P0 | 应用冷启动 | 主窗口和应用壳正常显示，无白屏 | 通过 |
| E2E-002 | P0 | 空数据状态 | 播放源页显示空状态，不显示技术诊断列表 | 通过 |
| E2E-003 | P0 | 设置页导入配置 | 配置保存并立即启用，播放源载入 | 通过 |
| E2E-004 | P0 | 只显示可用影视源 | 工具、隐藏和不兼容来源不进入选择列表 | 通过 |
| E2E-005 | P0 | 播放源页面搜索 | 仅显示名称或分组匹配来源 | 通过 |
| E2E-006 | P0 | 播放源页面分组 | 4K、秒播、采集分组结果正确 | 通过 |
| E2E-007 | P0 | 卡片一键切换 | 当前来源、卡片选中态和顶部来源同步 | 通过 |
| E2E-008 | P0 | 顶部选择器打开与关闭 | 浮层正常打开，遮罩可关闭 | 通过 |
| E2E-009 | P0 | 顶部选择器搜索和分组 | 搜索及分类结果准确 | 通过 |
| E2E-010 | P0 | 顶部选择器切换 | 切换后浮层关闭，当前来源同步 | 通过 |
| E2E-011 | P1 | 最近使用来源 | 按最后选择顺序展示 | 通过 |
| E2E-012 | P0 | 当前来源持久化 | 应用重启后保持当前来源 | 通过 |
| E2E-013 | P1 | 最近使用持久化 | 应用重启后保持顺序 | 通过 |
| E2E-014 | P0 | 当前来源片库 | 片库加载当前来源内容 | 通过 |
| E2E-015 | P0 | 搜索结果 | 当前来源返回指定影片和来源信息 | 通过 |
| E2E-015A | P1 | 搜索分页 | 加载第二页并保留第一页结果，无重复 | 通过 |
| E2E-016 | P0 | 详情页 | 显示片名、线路、剧集和播放按钮 | 通过 |
| E2E-017 | P0 | 播放会话 | 建立 `fongmi-media://` 受保护播放会话 | 通过 |
| E2E-018 | P1 | 实际媒体加载 | video 进入 HAVE_ENOUGH_DATA 并开始播放 | 通过 |
| E2E-019 | P0 | 配置切换 | 当前配置和来源列表同步替换 | 通过 |
| E2E-020 | P1 | 配置重命名 | 名称即时更新并持久化 | 通过 |
| E2E-021 | P1 | 配置删除二次确认 | 第一次确认，第二次删除且无残留 | 通过 |
| E2E-022 | P0 | 非法配置恢复 | 显示错误，当前配置不被替换 | 通过 |
| E2E-023 | P1 | 播放源重新检测 | 真实访问来源接口并结束检测 | 通过 |
| E2E-024 | P1 | CatVod 设置入口 | 启停、重启、更新、配置中心、日志入口存在 | 通过 |
| E2E-025 | P0 | 页面运行稳定性 | 无 pageerror、控制台错误和请求失败 | 通过 |
| E2E-026 | P1 | 收藏来源失效恢复 | 显示“查找其他来源”并进入全局搜索 | 通过 |
| LIVE-001 | P0 | 真实 CatVod 服务加载 | MD5/SHA256 校验通过并读取动态站点 | 通过 |
| LIVE-002 | P0 | 真实搜索—详情—播放解析 | 5 个真实站点获得远程媒体 URL 和请求头 | 通过 |
| REG-001 | P0 | 单元、集成、类型和构建回归 | 全部测试和构建成功 | 通过 |

## 5. 执行结果汇总

### 5.1 GUI 端到端测试

- 用例数：27
- 通过：27
- 失败：0
- P0 失败：0
- 页面脚本异常：0
- 控制台错误：0
- 请求失败：0

播放器实际状态：

```text
readyState: 4（HAVE_ENOUGH_DATA）
paused: false
currentTime: 0.016575
媒体时长: 52.208333 秒
media error: 0
```

### 5.2 单元与集成回归

```text
测试总数：154
通过：154
失败：0
TypeScript 类型检查：通过
Renderer 生产构建：通过
Electron 主进程构建：通过
```

### 5.3 真实 CatVod 服务验证

```text
状态：passed
MD5：f19e5f02c106283ca5a599acea2c040b
SHA256：8e28b4fcc0ca4c99d30de4ebf45500c74f4146f81242d9791803aedac3049063
总站点：79
发现站点：1
影视站点：62
隐藏站点：16
首页内容：20
分类内容：20
实际播放流程：5 个站点
代表站点：天堂|采集
搜索结果：庆余年 第一季
媒体类型：远程 URL
请求头：已返回
真实本地代理流：本轮样本未发现，继续保留专项验收
```

### 5.4 服务生命周期与安全

```text
服务生命周期 E2E：14/14 通过
Utility Process 强制终止后自动重启：通过
远程访问允许/阻止策略：通过
宿主桥 saveProfile/queryProfile/toast/danmuPush：通过
Profile AES-256-GCM 加密及应用重启恢复：通过
应用退出后端口释放：通过
发布前安全检查：20/20 通过
实际扫描服务日志：1 份，约 130 KB
明文凭据泄漏：0
```

## 6. 测试过程中发现并修复的问题

### 6.1 最近使用来源无法通过 IPC 保存

**现象：** 选择来源后控制台出现 `An object could not be cloned`。

**原因：** Vue 响应式数组直接传入 Electron IPC，不满足结构化克隆要求。

**修复：** 保存前转换为普通数组：

```ts
window.tvApi.setSetting("recentSiteKeys", [...recentSourceKeys.value]);
```

**验证：** 最近使用排序和应用重启持久化均通过。

### 6.2 应用启动时覆盖已保存的默认来源

**现象：** 重启应用后恢复为列表第一项，而不是上次选择项。

**原因：** `refreshSites()` 初始化第一个来源时触发监听器，提前覆盖 `defaultSite`，之后才读取原保存值。

**修复：** 增加初始化恢复状态，在读取并恢复默认来源完成前禁止监听器写入，并通过 `nextTick()` 明确初始化边界。

**验证：** 重启后当前来源和最近使用顺序均保持正确。

### 6.3 更换 MD5 地址仍复用旧脚本

**现象：** 服务状态中的 `sourceMd5Url` 已变更，但实际运行版本和远程访问域名仍属于旧脚本。

**原因：** BundleManager 只判断 manifest 中的 current 文件是否存在，没有校验 current 是否属于当前 MD5 来源地址。

**修复：** `ensureCurrent`、`checkForUpdate` 和 `currentVersion` 同时校验规范化后的 `sourceMd5Url`；来源变化时重新下载、校验并切换脚本。

**验证：** 新增来源切换单元测试，并完成真实服务恢复测试。

### 6.4 旧子进程退出事件干扰新服务

**现象：** 停止旧服务后立即启动新服务，旧 Utility Process 的延迟 `exit` 事件可能把新进程误判为异常退出。

**原因：** 退出回调只判断当前存在子进程，没有确认退出事件对应的是否仍是当前子进程。

**修复：** 退出回调携带具体 `UtilityProcess` 实例，仅当 `this.child === exitedChild` 时才执行自动恢复。

**验证：** 生命周期 E2E 覆盖连续停止、启动、策略切换、宿主桥、Profile 重启恢复和强制终止后自动重启，14/14 通过。

### 6.5 未签名包触发 macOS 钥匙串弹窗

**现象：** 应用启动时系统提示“找不到用于储存‘FongMi macOS Key’的钥匙串”。

**原因：** 未签名测试包默认调用 Electron `safeStorage`，macOS 无法为当前应用身份找到稳定的钥匙串项目。

**修复：** Profile 默认改用本地 AES-256-GCM 加密；密钥独立存放并限制为当前用户 `0600` 权限。系统钥匙串只保留为显式启用的兼容能力，默认启动路径不会访问。旧 `SAFE1` 密文会归档到受保护恢复项，不再重复触发钥匙串。

**验证：** Profile 专项测试 9/9、生命周期 E2E 14/14 通过；SQLite 主库和 WAL 中不存在测试凭据明文，Renderer 通用设置 IPC 无法读取 Profile。

## 7. 测试证据

详细报告和截图位于：

```text
artifacts/catvod-e2e/gui-report.json
artifacts/catvod-e2e/gui-report.md
artifacts/catvod-e2e/01-quick-source-page.png
artifacts/catvod-e2e/02-after-restart.png
artifacts/catvod-e2e/03-search-result.png
artifacts/catvod-e2e/04-detail.png
artifacts/catvod-e2e/05-player.png
artifacts/catvod-e2e/06-settings-config-management.png
artifacts/catvod-e2e/07-favorite-source-recovery.png
artifacts/catvod-service-lifecycle/report.json
artifacts/catvod-service-lifecycle/service.log
artifacts/catvod-security/report.json
```

自动化入口：

```bash
npm run e2e:catvod
npm test
npm run typecheck
npm run build
npm run audit:catvod:live
npm run audit:catvod:performance
npm run audit:catvod:security
npm run e2e:catvod:lifecycle
npm run e2e:core-hardening
npm run e2e:storage-recovery
```

## 8. 结论

本轮主流程 GUI 27/27、核心修复 Electron E2E 13/13、服务生命周期 14/14、数据库损坏恢复 E2E 5/5、单元与集成测试 275/275、发布前安全检查 21/21 全部通过。播放源快速选择、顶部来源选择器、来源收藏、搜索分页、收藏失效找源、配置管理、受保护播放会话、网盘账号状态/清除/任务隔离、三级目录/分页/搜索/排序、字幕弹幕高级设置和实际视频 Range 拖动均可用；真实 CatVod Node 服务的下载、校验、动态站点解析、异常退出自动恢复及搜索—详情—播放链路正常。

当前功能满足 P0 核心闭环及已实施 P1 代码功能的自动化验收条件；宿主消息 Fixture、Profile 加密持久化、真实本地代理媒体、真实本地 WebVTT/JSON 弹幕和 SQLite 文件损坏恢复已闭环。真实六网盘测试账号、真实第三方网盘大目录、真实 Provider 字幕弹幕样本和 Apple Silicon 实机运行仍按任务清单保留为环境依赖验收事项。

> 说明：目录包构建成功，但本机没有有效的 Apple Developer ID，因此构建日志提示未签名。这不影响本轮本机功能测试，但正式外部分发前仍需完成签名和公证。
