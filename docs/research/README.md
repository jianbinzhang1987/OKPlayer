# TVBox / FongMi 桌面实现开源方案调研

更新时间：2026-07-26

## 调研目的

本调研用于指导当前 `FongMi macOS` 项目后续的源兼容能力建设，重点回答：

1. 是否有成熟方案可以在 macOS 上替代 Android Dex/JAR Spider；
2. 哪些项目适合直接借鉴客户端架构；
3. 哪些项目适合借鉴规则引擎、T4 服务和浏览器嗅探；
4. 当前项目下一阶段应该优先实现哪些适配器。

## 文件目录

| 文件 | 内容 |
|---|---|
| `01-zyfun.md` | Electron 桌面客户端与多类型适配器实现 |
| `02-tv-multiplatform.md` | Kotlin Compose 桌面端与桌面 Java Spider |
| `03-tvbox-swift.md` | SwiftUI 原生 macOS/iOS 客户端 |
| `04-catvodspider.md` | Android CatVod Spider 生态与迁移价值 |
| `05-hipy-server.md` | Python、FastAPI、Playwright、T4 服务化方案 |
| `06-lunatv.md` | Web 聚合播放器与 CMS API 路线 |
| `07-drpy-ecosystem.md` | drpy、T3/T4、规则运行时路线 |
| `08-comparison.md` | 横向对比与选型结论 |
| `09-roadmap.md` | 建议实施路线与跟进清单 |
| `10-embedded-player.md` | macOS 内置播放器架构、HLS 方案与 Electron 升级路线 |
| `SOURCES.md` | 官方仓库和核验信息 |

## 总体结论

当前最有参考价值的项目是 `zyfun`。它已经验证了 Electron 桌面客户端可以通过适配器体系支持 T1～T4、drpy、Python、CatVod 和网页嗅探等能力。

但不建议整体复制任何一个项目。更合理的路线是：

```text
现有 FongMi macOS
    ├── 保留 HttpSource：type=0/1/4
    ├── 完善 JsSpiderAdapter
    ├── 新增 DrpyAdapter
    ├── 新增 T4Adapter
    ├── 新增 BrowserSnifferAdapter
    ├── 可选 PythonProvider 子进程
    └── Android Dex/JAR 保持明确不兼容
```

对于包含 `classes.dex + Android ARM .so` 的 Spider，不建议继续尝试在 macOS 进程内直接执行。
