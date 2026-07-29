# FongMi Desktop libmpv 原生深度内嵌渲染技术方案

> 文档状态：实施跟踪版
> 当前阶段：macOS x64 已完成真内嵌、自包含运行时、安装包自动启用、用户回退和 packaged E2E；Windows HWND/WGL 与 Linux X11/GLX 实现及三端 CI 编译入口已落地，等待对应 runner/目标机验证；正式 Developer ID/Windows 签名与公证仍待发布环境完成
> 适用工程：FongMi Desktop
> 目标平台：macOS、Windows、Linux
> 核心结论：在现有“统一播放器 + 播放决策层 + NativePlayerHost”的基础上，新增 `native/libmpv-player` 原生子工程，通过 Electron 主进程桥接 libmpv 原生视图，实现真正应用内嵌入式高兼容播放。正式用户链路只使用应用内标准播放器和 native-libmpv，MPV JSON IPC 仅保留为开发诊断能力。

---

## 1. 背景与目标

当前项目已经完成第一轮统一播放器改造：

- 标准播放继续使用 Web 播放器；
- 高兼容播放进入 `NativePlayerHost.vue`；
- 播放决策层可以在标准播放和高兼容播放之间切换；
- 高兼容播放已经复用现有 MPV JSON IPC；
- 播放、暂停、seek、倍速、音量、静音、上一集、下一集、选集、进度回传和外部兜底已经形成页面闭环。

第一轮高兼容播放最初仍由独立 MPV 窗口承载，Electron 播放页只是控制壳。本方案已在 macOS x64 上补齐这一关键差距：

> Electron 主进程通过 Node-API addon 创建 `NSOpenGLView` 子视图，libmpv OpenGL render API 将视频帧直接渲染到当前应用窗口，Vue 页面继续承载标题、选集、进度、音量、快捷键和错误恢复。

同一套受控接口现已扩展到 Windows HWND/WGL 与 Linux X11/GLX。后续重点转为目标系统编译和 E2E、arm64 实机、自包含运行时的三端依赖闭包、正式签名与发布。

---

## 2. 总体结论

不建议直接从当前 MPV JSON IPC 跳到“各平台完全不同的原生播放器 App”。推荐路线是：

```text
Electron 主应用
  ├─ Vue 播放页 / 控制栏 / 选集 / 历史 / 设置
  ├─ 主进程 NativePlayerBridge
  └─ native/libmpv-player 原生子工程
       ├─ N-API 绑定层
       ├─ 平台窗口 / 视图适配层
       ├─ libmpv 初始化与事件循环
       ├─ libmpv render context
       └─ 动态库加载与资源路径管理
```

即：

> UI 仍然由 Electron/Vue 负责，真正的视频画面由同一个应用进程内的原生视图承载，底层调用 libmpv 渲染。

当前 MPV JSON IPC 不删除，保留为：

1. native 子工程开发期的回退方案；
2. libmpv 加载失败时的兼容兜底；
3. 某些平台暂未完成原生视图绑定时的过渡能力；
4. 排查 libmpv 崩溃问题时的安全开关。

---

## 3. 技术路线选择

### 3.1 可选路线对比

| 路线 | 说明 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| 继续 MPV JSON IPC + 独立窗口 | 当前已有能力 | 成本最低，崩溃隔离好 | 不是真内嵌，窗口割裂 | 作为兜底保留 |
| 原生独立播放进程 + 贴合 Electron 窗口 | 独立进程创建无边框窗口，跟随主窗口移动 | 崩溃隔离好 | macOS 跨进程视图嵌入弱，焦点/层级/多屏问题多 | 不作为最终方案 |
| Electron Native Addon + libmpv 原生视图 | 在 Electron 进程内创建平台原生子视图承载 libmpv | 体验最接近真正内嵌，控制能力强 | native 工程、打包、签名复杂 | 推荐 |
| Electron Renderer 直接调用 native addon | Renderer 直接加载 .node | 调用链短 | 安全边界差，contextIsolation 复杂，崩溃影响页面 | 不推荐 |
| 纯 WebGL/Canvas 接管 libmpv 帧 | native 取帧后传给 Web 层绘制 | 页面集成好 | 性能差、同步复杂、硬解和字幕能力受损 | 不推荐 |

### 3.2 推荐路线

推荐采用：

```text
Electron 主进程 Native Addon + 平台原生视图 + libmpv render API
```

核心原则：

1. Renderer 不直接加载 native addon；
2. Renderer 只通过 preload 暴露的受控 IPC 调用播放能力；
3. 主进程负责 native addon 生命周期和窗口绑定；
4. native addon 只暴露稳定、窄口径 API；
5. libmpv 渲染线程和控制线程严格隔离；
6. 保留现有 MPV JSON IPC 兜底。

---

## 4. 新增 native 子工程设计

### 4.1 子工程位置

建议新增：

```text
native/libmpv-player/
  ├─ package.json
  ├─ binding.gyp
  ├─ src/
  │   ├─ addon.cc
  │   ├─ native_player.cc
  │   ├─ native_player.h
  │   ├─ mpv_engine.cc
  │   ├─ mpv_engine.h
  │   ├─ ipc_event_queue.cc
  │   ├─ ipc_event_queue.h
  │   └─ platform/
  │       ├─ darwin/
  │       │   ├─ native_player_view.mm
  │       │   ├─ native_player_view.h
  │       │   └─ window_embedder.mm
  │       ├─ win32/
  │       │   ├─ native_player_window.cc
  │       │   ├─ native_player_window.h
  │       │   └─ window_embedder.cc
  │       └─ linux/
  │           ├─ native_player_window.cc
  │           ├─ native_player_window.h
  │           └─ window_embedder.cc
  ├─ include/
  │   └─ mpv/
  ├─ vendor/
  │   └─ README.md
  └─ README.md
```

### 4.2 技术栈选择

建议首期使用：

```text
C++ / Objective-C++ + Node-API / node-addon-api + libmpv
```

不建议首期直接使用 Rust 的原因：

- macOS 原生视图需要 Objective-C++/Cocoa 交互；
- Windows 需要 Win32 HWND、消息循环和 DPI 处理；
- Linux 需要 X11/Wayland 窗口绑定；
- C/C++ 与 libmpv C API、Electron native addon 生态更直接；
- 首期目标是降低跨语言边界，而不是引入更多编译链。

Rust/napi-rs 可以作为第二阶段重构方向，但不作为首期推荐。

### 4.3 native addon 暴露 API

主进程只需要稳定调用以下 API：

```ts
interface NativeLibmpvAddon {
  createPlayer(options: {
    windowHandle: Buffer | string;
    platform: "darwin" | "win32" | "linux";
    x: number;
    y: number;
    width: number;
    height: number;
    deviceScaleFactor: number;
    resourcesPath: string;
    mpvLibraryPath?: string;
  }): string;

  destroyPlayer(playerId: string): void;

  load(playerId: string, input: {
    url: string;
    headers?: Record<string, string>;
    startPosition?: number;
    subtitleUrl?: string;
  }): void;

  play(playerId: string): void;
  pause(playerId: string): void;
  stop(playerId: string): void;
  seek(playerId: string, seconds: number): void;
  setSpeed(playerId: string, speed: number): void;
  setVolume(playerId: string, volume: number): void;
  setMuted(playerId: string, muted: boolean): void;
  resize(playerId: string, rect: NativePlayerRect): void;
  setVisible(playerId: string, visible: boolean): void;
  setFullscreen(playerId: string, fullscreen: boolean): void;

  pollEvents(): NativePlayerEvent[];
}
```

事件模型：

```ts
type NativePlayerEvent =
  | { playerId: string; type: "ready" }
  | { playerId: string; type: "state"; state: NativePlaybackState }
  | { playerId: string; type: "ended" }
  | { playerId: string; type: "error"; code: string; message: string }
  | { playerId: string; type: "log"; level: string; message: string };
```

### 4.4 主进程桥接模块

建议新增：

```text
src/desktop/native-player/
  ├─ native-player-bridge.ts
  ├─ native-player-service.ts
  ├─ native-player-window-binding.ts
  ├─ native-player-events.ts
  ├─ native-player-types.ts
  └─ native-player-fallback.ts
```

职责划分：

| 模块 | 职责 |
|---|---|
| `native-player-bridge.ts` | 加载 native addon，处理 addon 不存在、ABI 不匹配和初始化失败 |
| `native-player-service.ts` | 统一管理 playerId、sessionId、播放状态和控制命令 |
| `native-player-window-binding.ts` | 获取 BrowserWindow native handle，计算播放区域坐标和 DPI |
| `native-player-events.ts` | 将 native 事件转为 Electron IPC 事件 |
| `native-player-fallback.ts` | native 失败时回退到现有 MPV JSON IPC |

---

## 4.5 当前已落地实现

本轮已完成以下工程落地：

1. 新增 `native/libmpv-player` 子工程；
2. 新增 `binding.gyp`，支持 macOS / Windows / Linux 分平台编译入口；
3. 新增 Node-API addon 入口 `src/addon.cc`；
4. 新增 native 播放器状态骨架 `LibmpvPlayer`；
5. 三端平台视图桥接文件已建立：macOS 使用 `NSOpenGLView`，Windows 使用子 HWND + WGL 消息线程，Linux 使用 X11 子窗口 + GLX 渲染线程；Wayland 无 XWayland 时明确回退；
6. 新增 `src/desktop/native-libmpv-addon.ts`，用于主进程检测和加载 `.node` 插件；
7. 主进程 `appInfo` 已暴露 `nativeLibmpv` 可用状态；
8. 设置页“播放器运行内核”区域已显示 libmpv 原生内嵌状态；
9. `electron-builder.yml` 已加入 `resources/native` 与 `resources/libmpv` 分发目录；
10. `electron-builder.yml` 已加入 `.node` / `.dll` / `.dylib` / `.so` 的 `asarUnpack` 策略；
11. 新增 `scripts/build-native-libmpv.mjs`，支持通过 `FONGMI_BUILD_NATIVE_LIBMPV=1` 构建并复制 addon；
12. 新增 `scripts/verify-native-libmpv-layout.mjs` 与 `native-libmpv-layout.test.ts`，避免 native 布局被破坏；
13. `PlayerService` 已抽象为统一 `PlaybackController` 接口，为 MPV IPC 与 native-libmpv 后端切换预留统一控制入口；
14. 主进程已具备 native-libmpv 可用时自动选择 `NativeLibmpvController`、否则回落 MPV IPC 的后端选择逻辑；
15. 新增测试确保 native 后端默认不加载 `.node`，避免实验插件影响稳定播放器；
16. 新增 `mpv_dynamic.h/.cc`，通过 `dlopen` / `LoadLibrary` 动态查找 libmpv，不依赖编译期系统头文件；
17. `LibmpvPlayer` 已接入动态加载层和真实 render API：包括 `mpv_create`、`mpv_initialize`、`mpv_command`、属性读写、`mpv_render_context_create/update/render/report_swap/free`；
18. 开发环境支持 `FONGMI_ENABLE_NATIVE_LIBMPV=1`、`FONGMI_LIBMPV_ADDON`、`FONGMI_LIBMPV_LIBRARY` 显式验证；完整安装包存在 manifest、匹配 addon 和匹配动态库时无需环境变量自动启用；
19. `FONGMI_ENABLE_NATIVE_LIBMPV=0` 或设置页“原生高兼容内核=关闭”可强制回退 MPV IPC，设置变更重启生效；
20. 自动发现仅扫描同一受控 Resources 根目录，显式路径优先；所有首次加载仍经过隔离预检和 8 秒超时；
21. 新增最小 `mpv_render_abi.h`，动态解析 libmpv render 符号，不将开发机头文件编译进运行时接口；
22. macOS 已实现 `NSOpenGLView` 子视图、Retina backing scale、DOM/Cocoa 坐标转换、GL 函数解析、帧更新回调、resize、detach 和安全释放；
23. Electron 主进程通过 `BrowserWindow.fromWebContents()` 与 `getNativeWindowHandle()` 获取父 `NSView*`，Renderer 仅上报播放区域，不接触原生指针；
24. `NativePlayerHost.vue` 已通过 `ResizeObserver` 挂载和同步原生播放区域，原生视图成功后隐藏原控制占位卡片；
25. `NativeLibmpvController` 已增加 500ms 状态轮询，持续同步 position、duration、pause、volume、mute 和 eof；
26. native E2E 会生成 5 秒测试视频，真实验证 NSView 挂载、播放、seek、暂停、恢复、进度增长和卸载；
27. 新增 `prepare-libmpv-runtime.mjs`：macOS 递归收集 48 个非系统 dylib、改写 `@loader_path`、生成 SHA-256 manifest 并签名；
28. 新增 `after-pack-native-runtime.mjs`：打包后检查依赖闭包、架构、逐文件签名并生成 `native-runtime-manifest.json`；
29. 自包含 macOS 包已验证 49 个 native 文件、0 个未解析依赖、无 `/usr/local` 或 `/opt/homebrew` 运行时依赖；
30. packaged E2E 已验证无环境变量自动启用、包内真实渲染、设置关闭后重启回退 MPV IPC；
31. `verify-release.mjs` 已增加 native manifest、架构、依赖闭包、签名和 Developer ID 强制校验；
32. Windows/Linux native addon 编译已纳入 GitHub Actions，Linux runner 安装 X11/OpenGL 开发依赖。

当前 macOS x64 自包含安装包已完成真实渲染验证，`linkedLibmpv=true`、`renderApiAvailable=true`、`renderReady=true`。包内 addon 和 libmpv 自动配对，首次加载经过隔离预检；缺失、失败、超时、用户关闭或平台能力不足时继续安全回退到 MPV JSON IPC。Windows/Linux 源码与 CI 编译入口已完成，但在对应 runner 产生实际结果前，不将其表述为目标机验收通过。

---

## 5. 三端窗口绑定方案

### 5.1 通用窗口绑定流程

```text
Renderer 播放页挂载
  ↓
Renderer 上报播放区域 rect
  ↓
Main 读取 BrowserWindow nativeWindowHandle
  ↓
Native addon 创建平台原生子视图 / 子窗口
  ↓
libmpv 绑定原生渲染目标
  ↓
Renderer 控制栏继续覆盖在 Electron 页面层
```

关键点：

1. 播放区域 rect 由 Renderer 上报；
2. 主进程负责坐标转换；
3. native 层只负责视频画面区域；
4. 控制栏、选集、错误提示仍由 Vue 渲染；
5. 窗口 resize、全屏、DPI 变化时同步调用 `resize()`。

### 5.2 macOS 方案

推荐实现：

```text
BrowserWindow NSWindow
  └─ contentView
      └─ NativePlayerView / NSView
          └─ libmpv render context
```

技术点：

- native addon 通过 Electron 提供的 native handle 关联到 `NSWindow`；
- 创建 `NSView` 作为视频承载层；
- 将 `NSView` 插入 Electron BrowserWindow 的 contentView；
- 根据 Renderer 上报的播放区域调整 frame；
- 注意 Retina 缩放，rect 需要处理 backing scale factor；
- 全屏切换时监听 BrowserWindow 事件并重新布局；
- 退出播放页时销毁 NSView 和 libmpv context。

macOS 首期建议选择 OpenGL 渲染路径作为可行性验证：

```text
NSView / NSOpenGLContext
  ↓
libmpv render API
```

注意：OpenGL 在 macOS 已不属于长期理想方向，但作为首期验证成本最低。后续可评估 Metal/ANGLE/Vulkan/libplacebo 路径。

### 5.3 Windows 方案

当前已实现：

```text
BrowserWindow HWND
  └─ Child HWND: NativePlayerWindow
      └─ libmpv render context
```

技术点：

- 主进程获取 Electron BrowserWindow 对应的 HWND；
- native addon 创建 `WS_CHILD | WS_VISIBLE` 子窗口并直接以 Electron HWND 为 parent；
- 独立消息/渲染线程持有 HWND、HDC 和 WGL context；
- libmpv update callback 只投递自定义消息，所有 render 调用保持在同一 WGL context；
- 使用 `SetWindowPos` 响应 Renderer 的区域变化；
- 处理焦点、快捷键、鼠标穿透与控制栏层级；
- 注意 Windows 缩放比例和多显示器坐标。

Windows 目标机仍需优先验证：

1. 普通窗口播放；
2. 最大化播放；
3. 全屏播放；
4. 多显示器拖动；
5. 125% / 150% 缩放。

### 5.4 Linux 方案

Linux 已按 X11 与 Wayland 两条线处理。

当前策略：

```text
Linux 首期官方验证：X11
Linux Wayland：先降级到 MPV JSON IPC 或独立窗口兜底
```

X11 方案：

```text
Electron X11 Window
  └─ Child X11 Window
      └─ libmpv render context
```

技术点：

- 获取 Electron BrowserWindow 对应 X11 window id；
- 创建 X11 child window 和 GLX context；
- 独立渲染线程持有 Display、Window 和 GLXContext；
- update callback 只唤醒条件变量，render/update/swap 保持同一线程与 context；
- 支持移动、缩放、Expose 和 ConfigureNotify；
- 适配 AppImage / DEB 的动态库路径。

Wayland 风险：

- Wayland 原则上不鼓励随意嵌入其他进程/窗口；
- Electron 在 Wayland 下窗口句柄和子窗口策略更复杂；
- 首期不建议承诺 Wayland 真内嵌；
- 检测到 Wayland 时可提示“高兼容播放将使用兼容窗口模式”。

---

## 6. libmpv 生命周期设计

### 6.1 初始化流程

```text
createPlayer
  ↓
创建平台原生视图 / 子窗口
  ↓
mpv_create
  ↓
mpv_set_option_string
  ↓
mpv_initialize
  ↓
创建 render context
  ↓
注册事件回调
  ↓
返回 playerId
```

建议设置：

```text
terminal=no
idle=yes
keep-open=yes
hwdec=auto-safe
vo=gpu / gpu-next 根据平台验证
```

### 6.2 播放流程

```text
load(session)
  ↓
设置 http-header-fields
  ↓
设置字幕 / 音轨 / 其他参数
  ↓
loadfile replace
  ↓
开始事件回传
```

### 6.3 事件回传

native 层需要监听并回传：

```text
time-pos
-duration
pause
volume
mute
speed
idle-active
eof-reached
core-idle
file-loaded
end-file
log-message
```

上层统一转换为：

```text
loading | playing | paused | buffering | ended | error
```

### 6.4 销毁流程

```text
stop / close playback
  ↓
mpv_command stop
  ↓
mpv_render_context_free
  ↓
mpv_destroy
  ↓
销毁平台原生视图 / 子窗口
  ↓
移除事件监听
```

必须保证：

1. 播放页关闭后没有残留窗口；
2. session 关闭后 Header 被清理；
3. native 层崩溃不导致主流程不可恢复；
4. 下一次播放可以重新创建 player。

---

## 7. 动态库分发方案

### 7.1 资源目录结构

当前项目已经通过 `extraResources` 分发 `resources/mpv`。建议扩展为：

```text
resources/
  mpv/
    darwin-arm64/
      libmpv.dylib
      lib/*.dylib
      licenses/
    darwin-x64/
      libmpv.dylib
      lib/*.dylib
      licenses/
    win32-x64/
      libmpv-2.dll
      mpv-2.dll 或 libmpv.dll
      *.dll
      licenses/
    linux-x64/
      libmpv.so
      lib/*.so*
      licenses/
```

native addon 输出建议：

```text
resources/native/
  darwin-arm64/libmpv_player.node
  darwin-x64/libmpv_player.node
  win32-x64/libmpv_player.node
  linux-x64/libmpv_player.node
```

### 7.2 electron-builder 配置调整

现有配置：

```yaml
extraResources:
  - from: resources/mpv
    to: mpv
```

建议调整为：

```yaml
extraResources:
  - from: resources/mpv
    to: mpv
    filter:
      - "**/*"
  - from: resources/native
    to: native
    filter:
      - "**/*"
asarUnpack:
  - "**/*.node"
  - "**/*.dylib"
  - "**/*.dll"
  - "**/*.so*"
```

说明：

- native `.node` 不能放在 asar 内直接加载；
- 动态库也不应藏在 asar 内；
- 统一通过 `process.resourcesPath` 解析运行期路径；
- 开发环境走 `native/libmpv-player/build/Release`；
- 打包环境走 `resources/native/<platform-arch>`。

### 7.3 动态库加载路径

运行时路径解析：

```ts
const platformArch = `${process.platform}-${process.arch}`;
const resourcesPath = app.isPackaged
  ? process.resourcesPath
  : path.resolve(projectRoot, "resources");

const addonPath = path.join(resourcesPath, "native", platformArch, "libmpv_player.node");
const mpvPath = path.join(resourcesPath, "mpv", platformArch);
```

平台差异：

| 平台 | 动态库路径处理 |
|---|---|
| macOS | 使用 `@rpath` / `@loader_path`，确保 `.node` 能找到同目录或 mpv 目录下的 dylib |
| Windows | 将 libmpv 相关 DLL 放在 `.node` 同目录或启动时加入 DLL search path |
| Linux | 使用 `$ORIGIN` / rpath，或在启动前设置受控 `LD_LIBRARY_PATH` |

---

## 8. 打包、签名与公证方案

### 8.1 macOS

当前配置已经启用：

```yaml
hardenedRuntime: true
entitlements: build/entitlements.mac.plist
entitlementsInherit: build/entitlements.mac.inherit.plist
```

引入 libmpv 后需要重点处理：

1. `.app/Contents/Resources/native/**.node` 签名；
2. `.app/Contents/Resources/mpv/**/*.dylib` 签名；
3. 所有 dylib 的 rpath 合法；
4. 不允许未签名 dylib 被加载；
5. 公证前执行 deep 签名校验；
6. 若启用 hardened runtime，确保 native addon 和 dylib 权限满足运行要求。

建议新增脚本：

```text
scripts/sign-native-libraries.mjs
scripts/verify-native-libraries.mjs
scripts/verify-libmpv-runtime.mjs
```

macOS 验证命令建议包括：

```text
codesign --verify --deep --strict FongMi\ Desktop.app
spctl --assess --type execute FongMi\ Desktop.app
otool -L libmpv_player.node
otool -L libmpv.dylib
```

### 8.2 Windows

需要处理：

1. `.node` 文件签名；
2. libmpv DLL 和依赖 DLL 签名；
3. NSIS 安装包签名；
4. Portable EXE 签名；
5. 防止杀软误报；
6. 校验 DLL 缺失时的错误提示。

建议新增：

```text
scripts/verify-windows-native-runtime.mjs
```

校验内容：

- `.node` 是否存在；
- `libmpv-*.dll` 是否存在；
- 依赖 DLL 是否完整；
- 打包后能否加载 native addon；
- 能否创建空 player；
- 能否播放本地测试媒体。

### 8.3 Linux

Linux 不做传统签名，但需要处理依赖完整性。

重点：

1. AppImage 内置 libmpv 依赖；
2. DEB 方案可选择内置或声明依赖；
3. X11 首期优先验证；
4. Wayland 降级策略明确；
5. glibc 版本兼容；
6. VAAPI / Vulkan / OpenGL 驱动差异。

建议首期：

```text
AppImage：尽量内置 libmpv 及必要依赖
DEB：优先声明系统依赖，必要时提供内置 fallback
```

---

## 9. 许可证与合规处理

libmpv 相关许可证需要单独处理。

建议原则：

1. 优先使用 LGPL 构建的 mpv/libmpv；
2. 若使用 GPL 构建，则必须评估整个应用分发合规影响；
3. 保留所有第三方 license 文件；
4. 在 `THIRD_PARTY_NOTICES.md` 中新增 libmpv、FFmpeg、依赖库声明；
5. 构建产物保留版本、commit、构建参数、license 清单；
6. 发布前由 `release:preflight` 校验 license 文件存在。

推荐新增：

```text
resources/mpv/<platform-arch>/licenses/
THIRD_PARTY_NOTICES.md
scripts/verify-third-party-notices.mjs
```

---

## 10. 与现有播放体系的集成

### 10.1 播放决策层调整

当前播放引擎：

```ts
engine: "web" | "mpv"
```

建议演进为：

```ts
type PlaybackEngine =
  | "web"
  | "native-libmpv"
  | "mpv-ipc"
  | "external";
```

其中：

| engine | 含义 |
|---|---|
| `web` | 标准 Web 播放 |
| `native-libmpv` | 真正原生内嵌 libmpv |
| `mpv-ipc` | 现有 MPV JSON IPC 兼容兜底 |
| `external` | 外部播放器兜底 |

### 10.2 NativePlayerHost 调整

当前 `NativePlayerHost.vue` 负责高兼容播放控制。后续不需要推翻，只需要替换底层调用：

```text
当前：fallbackPlayback(sessionId) -> MPV JSON IPC
后续：nativePlayer.open(sessionId) -> libmpv native addon
失败：fallbackPlayback(sessionId) -> MPV JSON IPC
极端失败：openExternalPlayback(sessionId)
```

### 10.3 主进程 IPC 增加

建议新增 IPC：

```text
native-player:create
native-player:load
native-player:play
native-player:pause
native-player:stop
native-player:seek
native-player:speed
native-player:volume
native-player:mute
native-player:resize
native-player:destroy
native-player:event
native-player:capabilities
```

### 10.4 降级链路

最终降级链路：

```text
标准播放失败
  ↓
native-libmpv
  ↓
mpv-ipc
  ↓
external player
```

---

## 11. 开发任务拆分

虽然产品目标是一步到位，但 native 工程必须按工程模块拆解。

### 11.1 任务一：native 技术预研

目标：确认三端最小窗口绑定可行。

交付：

- macOS：NSView 创建与销毁；
- Windows：Child HWND 创建与 resize；
- Linux：X11 child window 创建与 resize；
- native addon 能被 Electron 主进程加载；
- 不接 libmpv，先显示纯色测试视图。

验收：

```text
Electron 播放页中出现平台原生测试区域，并能跟随窗口 resize。
```

### 11.2 任务二：libmpv 最小播放

目标：native 视图接入 libmpv 并播放测试 URL。

交付：

- `createPlayer`；
- `load`；
- `play/pause/stop`；
- `seek`；
- `destroy`；
- 基础状态回传。

验收：

```text
测试 MP4/HLS 能在应用播放页原生区域中显示画面。
```

### 11.3 任务三：接入现有 PlaybackSessionStore

目标：复用 `fongmi-media://` 受控媒体协议和 Header 保护机制。

交付：

- native-libmpv 播放 session URL；
- Header 仍留在主进程；
- HLS 子资源仍走受控协议；
- protected pan media 不暴露凭据。

验收：

```text
受保护媒体可以原生播放，播放 URL 中不出现 Cookie、Token、Referer 等敏感信息。
```

### 11.4 任务四：播放控制完整化

目标：高兼容原生播放能力与现有 `NativePlayerHost` 对齐。

交付：

- 进度；
- 时长；
- 暂停；
- 音量；
- 静音；
- 倍速；
- 播放结束；
- 错误回传；
- 快捷键；
- 选集切换；
- 自动下一集。

验收：

```text
Web 播放和 native-libmpv 播放在控制体验上基本一致。
```

### 11.5 任务五：三端打包与签名

目标：完成 native addon 和 libmpv 动态库的发布链路。

交付：

- macOS x64/arm64；
- Windows x64；
- Linux x64；
- electron-builder 配置；
- native library 校验脚本；
- 签名和公证验证脚本；
- license 清单。

验收：

```text
三端打包产物启动后可以加载 native addon，并完成 libmpv 播放冒烟测试。
```

---

## 12. 测试方案

### 12.1 单元测试

新增测试：

```text
tests/native-player-bridge.test.ts
tests/native-player-paths.test.ts
tests/native-player-capabilities.test.ts
tests/native-player-fallback.test.ts
```

覆盖：

- native addon 路径解析；
- 平台能力检测；
- native 不存在时回退 MPV JSON IPC；
- sessionId 与 playerId 绑定；
- Header 不泄漏。

### 12.2 集成测试

新增：

```text
scripts/run-native-libmpv-smoke.mjs
scripts/playwright-native-player-e2e.mjs
```

覆盖：

- 启动应用；
- 打开测试媒体；
- 创建 native player；
- 播放 5 秒；
- seek；
- 改变音量；
- 切换全屏；
- 关闭播放页；
- 验证没有残留 native 窗口。

### 12.3 打包后测试

扩展现有：

```text
scripts/verify-cross-platform-unpacked.mjs
scripts/verify-release.mjs
```

新增校验：

- `.node` 是否存在；
- libmpv 动态库是否存在；
- license 是否存在；
- macOS 是否签名；
- Windows DLL 是否齐全；
- Linux AppImage 是否可加载 libmpv；
- native addon 是否能被 Electron 主进程 require。

---

## 13. 风险与控制措施

| 风险 | 影响 | 控制措施 |
|---|---|---|
| native addon ABI 与 Electron 不匹配 | 应用启动或播放失败 | 使用 Node-API 稳定 ABI，打包前执行 native addon 加载测试 |
| libmpv 动态库缺失 | 高兼容播放失败 | 启动时能力检测，失败自动回退 MPV JSON IPC |
| macOS 签名/公证失败 | 无法发布正式包 | afterPack/afterSign 增加 native 库签名和校验脚本 |
| 三端窗口嵌入差异 | UI 不一致 | macOS 优先闭环，Windows 第二，Linux X11 第三，Wayland 降级 |
| libmpv 渲染线程死锁 | 播放卡死 | 严格区分 render thread 与控制 API，事件队列异步转发 |
| 控制栏被原生视图遮挡 | 用户无法操作 | 原生视图只占视频画面区域，控制栏保留在 Electron 层或调整 z-order 策略 |
| Header 泄露 | 安全问题 | 始终通过 `fongmi-media://` 受控协议，不把敏感 Header 交给外部进程 |
| GPL/LGPL 合规风险 | 发布风险 | 优先 LGPL 构建，保留 license 和构建参数，发布前校验 |
| Wayland 嵌入不可控 | Linux 体验不一致 | 首期官方支持 X11，Wayland 降级兼容窗口模式 |

---

## 14. 建议实施顺序

虽然用户体验目标是一步到位，但 native 实施必须按工程检查点推进：

```text
1. native 子工程骨架
2. 三端原生测试视图
3. libmpv 最小播放
4. 接入 PlaybackSessionStore
5. 替换 NativePlayerHost 底层调用
6. 播放控制完整化
7. 打包资源与动态库分发
8. macOS 签名和公证
9. Windows/Linux 打包验证
10. 全量测试与发布前检查
```

这里的“分步”不是产品分阶段交付，而是研发内部验收顺序。最终用户看到的仍然是一次性升级后的统一播放器。

---

## 15. 目录和配置改造清单

建议新增或调整：

```text
native/libmpv-player/
resources/native/
resources/mpv/<platform-arch>/
src/desktop/native-player/
scripts/build-native-libmpv.mjs
scripts/verify-native-libraries.mjs
scripts/sign-native-libraries.mjs
scripts/run-native-libmpv-smoke.mjs
scripts/playwright-native-player-e2e.mjs
```

建议调整：

```text
package.json
  scripts:
    native:build
    native:build:mac
    native:build:win
    native:build:linux
    smoke:native-player

electron-builder.yml
  extraResources:
    resources/mpv
    resources/native
  asarUnpack:
    **/*.node
    **/*.dylib
    **/*.dll
    **/*.so*
```

建议扩展：

```text
THIRD_PARTY_NOTICES.md
release:preflight
release:verify
verify-cross-platform-unpacked
```

---

## 16. 最终目标形态

完成后，高兼容播放链路应变为：

```text
用户点击播放
  ↓
PlaybackEngineSelector 判断需要高兼容播放
  ↓
NativePlayerHost 挂载
  ↓
Main NativePlayerService 创建 native-libmpv player
  ↓
原生视频视图嵌入 Electron 播放页
  ↓
libmpv 渲染画面
  ↓
Vue 控制栏统一控制播放
```

最终用户感知：

> 视频始终在 FongMi Desktop 播放页中播放，复杂源也不会跳出应用；标准播放和高兼容播放只是底层内核不同，用户不需要理解 ArtPlayer、MPV、libmpv 等技术差异。

---

## 17. 当前建议结论

建议正式将 libmpv 原生深度内嵌作为下一阶段播放器专项，采用以下策略：

1. 保留现有 MPV JSON IPC 作为安全兜底；
2. 新增 `native/libmpv-player` 子工程；
3. 首期使用 C++/Objective-C++ + Node-API；
4. macOS 优先完成真内嵌验证；
5. Windows 第二，Linux X11 第三；
6. Wayland 首期不承诺真内嵌，先保留降级；
7. 动态库由准备脚本生成到 `build/native-runtime/libmpv/<platform-arch>`，打包后进入 `Resources/libmpv/<platform-arch>`；
8. native addon 统一放入 `resources/native/<platform-arch>`；
9. 打包、签名、公证、license 校验必须作为 release preflight 的一部分；
10. 待 native-libmpv 稳定后，再把当前 `NativePlayerHost` 的底层从 MPV JSON IPC 切换到 native-libmpv。

一句话总结：

> libmpv 深度内嵌不应另做一个独立播放器，而应作为 FongMi Desktop 当前统一播放器体系的下一层 native 渲染内核；Electron 继续负责产品体验，native 子工程只负责视频视图、libmpv 渲染和平台窗口绑定。

---

## 18. 参考资料

- mpv libmpv embedding / client API 文档；
- Electron Native Code and Electron 文档；
- electron-builder Application Contents / extraResources / asarUnpack 文档；
- electron-builder Build Lifecycle / signing / notarization 文档；
- 当前工程 `electron-builder.yml`；
- 当前工程 `src/core/mpv-controller.ts`；
- 当前工程 `src/desktop/renderer/components/NativePlayerHost.vue`。
