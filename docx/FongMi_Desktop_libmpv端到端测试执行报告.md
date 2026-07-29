# FongMi Desktop libmpv 端到端测试执行报告

> 执行日期：2026-07-29
> 测试依据：`docx/FongMi_Desktop_libmpv原生内嵌端到端测试用例.md`
> 当前结论：macOS x64 已完成 libmpv 真内嵌、自包含运行时、无环境变量自动启用、用户关闭回退、安装包依赖闭包与端到端验证。Windows HWND/WGL 与 Linux X11/GLX 代码、依赖闭包审计和目标系统 CI 入口已完成；Linux CI 已配置真实 libmpv + Xvfb packaged E2E，Windows CI 支持通过“固定 ZIP URL + SHA-256”执行受控原生 E2E，但对应远程 runner 结果尚未产生，不能表述为三端最终验收通过。

---

## 1. 已完成的播放内核能力

### 1.1 libmpv Core 与 Render API

已动态解析并使用：

- `mpv_create`；
- `mpv_initialize`；
- `mpv_set_option_string`；
- `mpv_command`；
- 属性读写；
- `mpv_render_context_create`；
- `mpv_render_context_set_update_callback`；
- `mpv_render_context_update`；
- `mpv_render_context_render`；
- `mpv_render_context_report_swap`；
- `mpv_render_context_free`。

播放器初始化前设置 `vo=libmpv`，视频画面不再由独立 MPV 窗口承载。

### 1.2 macOS 原生视图

已实现：

- Electron `NSView*` 父视图绑定；
- `NSOpenGLView` 子视图；
- OpenGL 3.2 Core context；
- Retina backing scale；
- DOM 左上角到 Cocoa 坐标转换；
- GL 函数解析；
- libmpv update callback；
- 默认 framebuffer render；
- swap 上报；
- resize、detach 和安全释放。

### 1.3 Windows 原生视图代码

已实现：

- `WS_CHILD | WS_VISIBLE` 子 HWND；
- 独立消息/渲染线程；
- HDC、pixel format 和 WGL context；
- `wglGetProcAddress` / `opengl32` 函数解析；
- 自定义 redraw、resize 消息；
- libmpv render 与 `SwapBuffers`；
- detach 和线程清理。

当前状态：源码与 CI 编译步骤已落地，等待 Windows runner 编译结果和目标机 E2E。

### 1.4 Linux 原生视图代码

已实现：

- X11 child Window；
- GLX context；
- 独立渲染线程持有 Display、Window 和 GLXContext；
- update callback 仅唤醒条件变量；
- Expose、ConfigureNotify、move/resize；
- libmpv render 与 `glXSwapBuffers`；
- detach 和线程清理；
- 无 `DISPLAY` 时明确回退。

当前状态：源码与 CI 编译步骤已落地，等待 Linux runner 编译结果和 X11 目标机 E2E。Wayland 无 XWayland 时继续使用 MPV IPC。

---

## 2. 安全加载与回退

当前保护机制：

1. Renderer 不接触 native pointer，不直接加载 `.node`；
2. 主进程通过 `BrowserWindow.fromWebContents()` 与 `getNativeWindowHandle()` 获取平台句柄；
3. 首次 addon/libmpv 加载在隔离子进程执行；
4. 隔离预检默认 8 秒超时；
5. 只接受显式绝对路径或同一安装包 Resources 根目录；
6. 不按通用库名自动搜索系统/Homebrew libmpv；
7. 只有 `linkedLibmpv=true && renderApiAvailable=true && renderReady=true` 才启用 native；
8. 失败、超时、缺失、平台能力不足或用户关闭时回退 MPV IPC；
9. 成功加载的 libmpv 在进程生命周期内保持驻留，避免复杂依赖卸载顺序崩溃；
10. 设置页可关闭“原生高兼容内核”，重启后生效；
11. `FONGMI_ENABLE_NATIVE_LIBMPV=0` 可在启动前强制禁用。

---

## 3. 自包含运行时与打包

### 3.1 macOS 依赖准备

`prepare-libmpv-runtime.mjs` 已完成：

- 从固定 libmpv 绝对路径开始；
- 递归读取 `otool -L`；
- 收集全部非系统 dylib；
- 将 48 个 dylib 复制到同一目录；
- install name 与依赖统一改写为 `@loader_path`；
- 验证依赖闭包；
- 逐文件签名；
- 生成 SHA-256 `runtime-manifest.json`。

### 3.2 electron-builder 集成

已实现：

- 平台专属 staging 目录；
- 只复制当前平台/架构运行时；
- `.node/.dylib/.dll/.so` 保持在 asar 外；
- Windows 通过 `dumpbin/llvm-objdump/objdump` 递归计算 DLL 依赖闭包；
- Linux 通过 `ldd` 递归解析依赖，使用 `patchelf` 设置 `$ORIGIN`；
- Linux manifest 单独记录允许依赖的系统 ABI 库；
- 非规范入口名自动生成 `mpv-2.dll`、`libmpv.so.2` 等规范入口副本；
- `afterPack` 对三端执行包内依赖审计；
- 架构检查；
- macOS dylib 与 `.node` 逐个签名；
- Windows `signExts` 明确包含 `.dll` 和 `.node`；
- `native-runtime-manifest.json`；
- 正式发布审计检查 Developer ID、依赖闭包、架构和 native 文件完整性。

### 3.3 自动启用

安装包同时存在以下内容时，无需用户设置环境变量：

```text
Resources/native-runtime-manifest.json
Resources/native/libmpv-player/<platform>-<arch>/fongmi_libmpv_player.node
Resources/libmpv/<platform>-<arch>/libmpv...
```

应用会自动执行隔离预检，成功后启用 native；用户仍可在设置页关闭。

---

## 4. 实际测试环境

| 项目 | 实际值 |
|---|---|
| 平台 | macOS x64 |
| Electron | 43.2.0 |
| Node-API addon | `fongmi_libmpv_player.node` |
| libmpv 来源 | `/usr/local/lib/libmpv.2.dylib` |
| packaged libmpv | `.app/Contents/Resources/libmpv/darwin-x64/libmpv.2.dylib` |
| libmpv API version | 131077 |
| 测试视频 | ffmpeg 生成 640×360、5 秒 MP4 |
| native 文件数量 | 49：1 个 addon + 48 个 dylib |

IINA 内置 libmpv 依赖应用私有 `@rpath` FFmpeg 库，不适合作为独立 Electron 运行时；当前验证使用固定 Homebrew libmpv 作为源，再生成完全自包含的发布目录。

---

## 5. 测试结果

### 5.1 类型、构建和专项测试

| 项目 | 结果 |
|---|---|
| TypeScript 类型检查 | 通过 |
| Node/脚本语法检查 | 通过 |
| macOS Node-API/Objective-C++ 编译 | 通过 |
| native 布局与架构断言 | 通过 |
| native 预检、自动发现与设置测试 | 通过 |
| Renderer 构建 | 通过 |
| 主进程构建 | 通过 |

native、发布预检与许可证专项测试最新批次：12/12 通过。此前已完成的 native/fallback 专项批次为 22/22 通过。期间发现并修复了结构测试中 `afterPack` 变量重复声明问题；修复后类型检查与专项测试重新通过。

### 5.2 开发态 native E2E

结果：5/5 通过。

覆盖：

- 默认关闭/无完整运行时回退；
- 探针明确失败；
- 探针挂起 8 秒超时；
- 实际 addon + 实际 libmpv + NSView render；
- 原生视图运行期挂载失败后，同一播放会话自动切换 MPV IPC 并继续打开媒体。

真实视频结果：

```text
linkedLibmpv=true
renderApiAvailable=true
renderReady=true
backend=native-libmpv
duration=5
position>1
consoleErrors=0
pageErrors=0
```

### 5.3 自包含 packaged E2E

结果：通过。

验证内容：

- 未传 native enable、addon、library 绝对路径；
- 安装包自动发现并启用 native；
- 实际加载路径位于 `.app/Contents/Resources`；
- 真实视频挂载、播放、seek、暂停、恢复成功；
- duration=5；
- position=1.54；
- 状态事件 56 次；
- 48 个 dylib 依赖检查 unresolved=0；
- 49 个 native 文件完成签名检查；
- 不包含 `/usr/local` 或 `/opt/homebrew` 运行时依赖；
- 根 `native-runtime-manifest.json` 不再记录 `resourcesDirectory` 绝对路径；
- prepared runtime manifest 只记录源文件名与 SHA-256，不记录开发机源路径；
- 依赖审计中的文件定位统一使用相对 `Resources` 路径；
- `manifestPathSanitized=true`；
- `preparedManifestPathSanitized=true`；
- consoleErrors=0；
- pageErrors=0。

### 5.4 用户关闭回退

在第一次 packaged native 播放成功后写入：

```text
nativeLibmpvEnabled=false
```

使用同一用户目录重启：

```text
playerBackend=mpv-ipc
nativeLibmpvPreferenceEnabled=false
nativeLibmpv.available=false
```

结果：通过。

### 5.5 标准播放器回归

播放器 E2E：8/8 通过。

覆盖：

- 设置保存；
- 配置导入；
- ArtPlayer MP4；
- 全屏；
- ArtPlayer HLS；
- 稳定播放器；
- 重启持久化；
- 无页面脚本错误。

### 5.6 全量测试

结果：302/302 通过，0 失败。

覆盖配置、搜索、详情、历史、收藏、CatVod、网盘、媒体协议、嗅探、Web 播放、MPV IPC、高兼容播放器、native 预检、自动发现和设置持久化。

---

## 6. 签名和发布状态

### 已完成

- dylib 与 addon 的 ad-hoc 签名链路；
- Developer ID 身份参数入口；
- afterPack 签名与校验；
- release verify 的 native 强制门槛；
- 当前架构和双架构发布审计模式；
- `release:formal:native` 工作流。

### 当前环境限制

开发机没有有效的 `Developer ID Application` 证书，因此本次 unpacked 应用本体未做正式 Developer ID 签名，也未执行 Apple notarization。

正式发布仍需：

- 有效 Developer ID Application；
- Apple notarization 凭据；
- Windows 代码签名证书；
- 对应平台固定 libmpv 发布源和许可证清单。

---

## 7. Windows/Linux 验收状态

### 已完成

- Windows HWND/WGL 源码；
- Linux X11/GLX 源码；
- binding.gyp 平台链接参数；
- 目标架构参数；
- GitHub Actions 三端 native addon 编译步骤；
- Linux 安装 libmpv、X11/OpenGL、patchelf、ffmpeg 与 Xvfb；
- Linux runner 构建真实 native-libmpv 安装包并执行 packaged E2E；
- Windows workflow_dispatch 支持固定 ZIP URL + SHA-256 校验后构建 native 包；
- Windows 可选原生 E2E 不接受未经哈希确认的动态库；
- 三端运行时依赖闭包及 afterPack 审计；
- 静态架构断言。

### 尚待外部目标环境结果

- Windows runner 实际编译日志；
- Windows 实体/虚拟机 native render E2E；
- Linux runner 实际编译日志；
- Linux X11 native render E2E 的远程执行结果；
- Linux Wayland/XWayland 行为验证；
- macOS arm64 addon、libmpv 和 packaged E2E。

当前代码仓库有 GitHub remote 和 workflow，但本地改动尚未提交/推送；未在用户未授权的情况下主动推送远程分支。因此三端 CI 结果应在变更提交后产生。

---

## 8. 一键命令

开发态验证：

```bash
npm run validate:native:libmpv
```

自包含 macOS x64 验证：

```bash
FONGMI_LIBMPV_SOURCE=/absolute/path/to/libmpv.2.dylib \
FONGMI_NATIVE_ARCH=x64 \
npm run validate:native:packaged
```

原生正式发布：

```bash
FONGMI_LIBMPV_SOURCE=/absolute/path/to/libmpv.2.dylib \
FONGMI_NATIVE_ARCH=x64 \
npm run release:formal:native
```

---

## 9. 最终结论

> macOS x64 的 libmpv 原生深度内嵌已经完成从播放内核、原生视图、运行时依赖、安装包自动发现、用户回退、许可证声明、manifest 路径脱敏到 packaged E2E 的完整闭环。macOS arm64 addon 已完成交叉编译和架构验证，但 arm64 自包含 libmpv 运行时与实体机 E2E 仍待完成。Windows/Linux 已完成实现、依赖闭包与 CI 编译/E2E 入口，但必须等待目标系统结果后才能完成三端最终验收。当前剩余工作主要是目标平台验证、正式证书签名、公证和最终许可证版本声明。
