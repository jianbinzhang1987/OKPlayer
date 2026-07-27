# 播放源管理与多仓配置 Playwright 实测报告

测试时间：2026-07-26

## 结论

本轮已完成播放源管理修复、多仓配置支持和打包应用验证。

### 本地稳定性用例

- 用例总数：15
- 通过：15
- 失败：0
- 页面脚本异常：0
- 控制台错误：0

### 核心单元与集成测试

- TypeScript 类型检查：通过
- Node 测试总数：104
- 通过：104
- 失败：0

### 真实多仓地址验证

测试地址：

```text
https://gitlab.com/noimank/tvbox/-/raw/main/tvboxmuti.json
```

Playwright 在独立用户目录中实测结果：

- 成功导入 5 个当次网络环境可访问的子配置。
- 无效或超时的下级线路没有阻断整个多仓导入。
- 导入后始终只有 1 个当前配置。
- 成功从“🚀3-小盒子4K”切换到“🚀4-健康家用”。
- 应用重启后仍保持“🚀4-健康家用”为当前配置。
- 子配置原始名称完整保留。
- 页面无 console error 和 pageerror。

由于多仓中的第三方地址可用性会随时间和网络环境变化，成功导入数量可能不同；验收重点是“部分成功可用、失败相互隔离、名称保留、可切换、可恢复”。

## 已修复问题

### 1. 多仓索引无法导入

原逻辑遇到根节点为 `urls` 的配置时直接报错，要求用户手动选择具体线路。

现已支持：

- 自动识别多仓索引。
- 递归展开嵌套仓库，最大深度 3。
- 最多导入 100 个子配置。
- 以 6 路并发加载下级配置，避免逐个串行等待。
- 同一 URL 自动去重。
- 部分下级配置失败时继续保留成功配置。
- 使用仓库条目名称保存子配置。
- 第一个成功配置自动成为当前配置。

### 2. 多配置存在相同 siteKey 时可能串源

全部配置搜索继续使用包含配置地址的独立来源引用。即使不同配置中存在相同 `siteKey`，搜索、详情和播放也会回到正确的所属配置。

新增测试已验证两个配置使用相同 `siteKey` 时仍能返回两份独立结果。

### 3. 重启后配置名称变成“默认配置”

恢复当前配置时，现在会先读取数据库中保存的名称，再重新加载配置，不再用默认名称覆盖。

### 4. 当前配置无法管理

当前配置卡片已增加：

- 重命名入口。
- 删除入口及二次确认。
- 删除当前配置后自动尝试切换到下一个可用配置。
- 没有剩余配置时才进入空状态。

### 5. 故障源被误报为正常

状态页面已经接入 Source Quality Audit：

- 检测首页、搜索、详情和播放链路。
- HTTP 503 等真实故障会标记为已屏蔽。
- “重新检测全部”会实际访问源接口，而不是只刷新本地元数据。
- 页面区分“可展示”和“已屏蔽/不兼容”。

## 自动化结果文件

本地播放源管理报告：

```text
artifacts/source-management-e2e/report.json
artifacts/source-management-e2e/report.md
```

真实多仓报告：

```text
artifacts/multi-warehouse-live-e2e/report.json
artifacts/multi-warehouse-live-e2e/report.md
```

真实多仓截图：

```text
artifacts/multi-warehouse-live-e2e/01-imported-warehouse.png
artifacts/multi-warehouse-live-e2e/02-after-switch.png
artifacts/multi-warehouse-live-e2e/03-after-restart.png
```

## 自动化命令

```bash
npm run typecheck
npm test
npm run package:dir
npm run e2e:sources
npm run e2e:sources:live
```

## 当前验收状态

- 播放源管理基础闭环：通过。
- 故障状态检测：通过。
- 当前配置重命名和删除：通过。
- 多仓导入和失败隔离：通过。
- 多配置切换和重启恢复：通过。
- 重复 siteKey 隔离：通过。
