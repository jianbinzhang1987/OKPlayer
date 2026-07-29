# FongMi Desktop libmpv 原生内嵌端到端测试用例

> 文档状态：执行版
> 测试对象：native libmpv addon、隔离预检、macOS NSView/OpenGL 真内嵌、主进程后端选择、应用启动与播放器回归
> 测试平台：当前 macOS x64 开发机；Windows / Linux 在对应 CI 或实体环境复用相同用例
> 测试原则：native 组件的失败、超时和崩溃不得阻塞 Electron 主进程；正式用户播放链路不得打开独立 MPV 窗口，应返回应用内错误恢复流程。

---

## 1. 测试前置条件

1. 已完成 `npm run build:desktop` 和 `npm run build:renderer`；
2. native addon 已编译到 `resources/native/libmpv-player/<platform>-<arch>/fongmi_libmpv_player.node`；
3. 测试使用独立用户目录，不修改正式用户数据；
4. 默认不设置 `FONGMI_ENABLE_NATIVE_LIBMPV`；
5. 实验 native 测试必须同时指定：
   - `FONGMI_ENABLE_NATIVE_LIBMPV=1`；
   - `FONGMI_LIBMPV_ADDON=<绝对 .node 路径>`；
   - `FONGMI_LIBMPV_LIBRARY=<绝对 libmpv 动态库路径>`；
6. 单个 native 预检最长等待 8 秒，超时必须回退。

---

## 2. 测试数据

| 数据 | 用途 |
|---|---|
| fake-addon.node | 验证路径校验与模拟探针，不执行 native 代码 |
| fake-libmpv.dylib / dll / so | 验证路径校验与模拟探针 |
| probe-success.cjs | 模拟隔离探针成功 |
| probe-failure.cjs | 模拟隔离探针明确失败 |
| probe-hang.cjs | 模拟 native 加载永久挂起 |
| 实际 fongmi_libmpv_player.node | 验证真实 addon 加载 |
| 经确认的 libmpv 动态库绝对路径 | 验证真实 libmpv 动态加载和 render API |
| ffmpeg 生成的 5 秒 MP4 | 验证 NSView 挂载、真实渲染、seek、暂停、恢复和状态增长 |
| 普通 MP4 / HLS 测试源 | 验证播放器原有链路不受影响 |

---

## 3. 功能与安全测试用例

### NLV-001 默认关闭 native 后端

**步骤**

1. 清除全部 `FONGMI_*LIBMPV*` 环境变量；
2. 启动应用；
3. 读取 `appInfo.playerBackend` 和 `appInfo.nativeLibmpv`。

**预期**

- 应用正常启动；
- `playerBackend=mpv-ipc`；
- `nativeLibmpv.available=false`；
- 页面提示 native libmpv 处于实验阶段且未启用；
- 不加载任何 `.node` 文件。

### NLV-002 仅开启开关但未提供路径

**步骤**

1. 设置 `FONGMI_ENABLE_NATIVE_LIBMPV=1`；
2. 不设置 addon 和动态库路径；
3. 启动应用。

**预期**

- 应用正常启动；
- 后端保持 `mpv-ipc`；
- 明确提示必须同时提供 addon 和 libmpv 绝对路径；
- 主进程不执行 `require(.node)`。

### NLV-003 相对路径被拒绝

**步骤**

1. 开启 native；
2. 将 addon 或动态库设置为相对路径；
3. 启动应用。

**预期**

- 路径校验失败；
- 不启动隔离探针；
- 应用正常回退 MPV IPC。

### NLV-004 错误扩展名和不存在路径被拒绝

**步骤**

1. 分别设置不存在路径、非 `.node` addon、非当前平台动态库扩展名；
2. 启动应用。

**预期**

- 均在加载前被拒绝；
- 不触发 native 代码；
- 应用保持可用。

### NLV-005 隔离探针成功

**步骤**

1. 指定存在的模拟 addon 和动态库文件；
2. 将探针脚本指定为 `probe-success.cjs`；
3. 调用 `preflightNativeLibmpvAddon()`。

**预期**

- 返回 `available=true`；
- 返回 `linkedLibmpv=true`、`renderReady=true` 的 buildInfo；
- 预检只在子进程中执行；
- 主进程随后才有资格加载 addon。

### NLV-006 隔离探针明确失败

**步骤**

1. 使用 `probe-failure.cjs`；
2. 执行预检。

**预期**

- 返回 `available=false`；
- 原因包含探针返回的错误；
- 主进程不加载 addon；
- 使用 MPV IPC。

### NLV-007 隔离探针超时

**步骤**

1. 使用 `probe-hang.cjs`；
2. 将预检超时设置为 500ms；
3. 记录调用耗时。

**预期**

- 调用在合理误差内返回，不等待挂起子进程退出；
- 返回 `available=false`；
- 原因包含“隔离预检超过”；
- 父进程侧 stdout/stderr 管道被关闭；
- Electron 主进程继续启动。

### NLV-008 禁止自动加载系统 / Homebrew libmpv

**步骤**

1. 不设置 `FONGMI_LIBMPV_LIBRARY`；
2. 即使 `/usr/local/lib/libmpv*.dylib` 存在，也执行 addon buildInfo 探测。

**预期**

- `DefaultLibmpvCandidates()` 返回空；
- 不通过通用库名调用 `dlopen`；
- 不自动命中 Homebrew 或系统动态库。

### NLV-009 dlerror 单次读取回归

**步骤**

1. 指定不存在的绝对动态库路径；
2. 执行动态库加载。

**预期**

- 不发生段错误；
- 返回可读的 `dlopen` 错误；
- 不将空指针构造成 `std::string`。

### NLV-010 真实 addon + 真实 libmpv 隔离探测

**步骤**

1. 指定实际 `.node` 绝对路径；
2. 指定经过确认的实际 libmpv 绝对路径；
3. 在隔离探针中加载并读取 buildInfo；
4. 创建 player、读取初始状态并销毁。

**预期**

- 成功时：`linkedLibmpv=true`、`renderApiAvailable=true`、`renderReady=true`，返回 API 版本和实际库路径；
- 失败或超时时：主进程不受影响并回退 MPV IPC；
- 不允许直接在主进程中做首次未知 addon 探测。

### NLV-011 应用默认启动端到端

**步骤**

1. 使用独立用户目录启动 Electron；
2. 不开启 native；
3. 等待主窗口和 `.app-shell`；
4. 从 preload 读取 appInfo。

**预期**

- 主窗口在 25 秒内显示；
- `playerBackend=mpv-ipc`；
- 无页面异常和主进程崩溃。

### NLV-012 探针挂起时应用仍可启动

**步骤**

1. 开启 native并提供合法格式的模拟路径；
2. 指定 `probe-hang.cjs`；
3. 启动 Electron；
4. 等待窗口出现。

**预期**

- 预检超时后应用继续启动；
- `playerBackend=mpv-ipc`；
- 设置页显示预检超时原因；
- 主进程没有被挂起子进程阻塞。

### NLV-013 实际 native 环境启动

**步骤**

1. 指定实际 addon 和实际 libmpv；
2. 启动 Electron；
3. 查看 appInfo；
4. 关闭应用。

**预期**

- macOS 预检与 render 能力成功时 `playerBackend=native-libmpv`；
- 预检失败、超时或平台视图未完成时 `playerBackend=mpv-ipc`；
- 两种情况下应用都能正常启动和退出。

### NLV-014 标准播放器回归

**步骤**

1. 默认 MPV IPC 后端启动；
2. 播放 MP4；
3. 播放 HLS；
4. 验证暂停、seek、倍速、关闭。

**预期**

- 标准播放器能力不受 native 改动影响；
- 播放历史正常保存。

### NLV-015 高兼容播放器回归

**步骤**

1. 强制高兼容播放；
2. 验证 MPV IPC fallback；
3. 验证播放、暂停、seek、倍速、音量、静音、上一集、下一集和关闭。

**预期**

- native 不可用时完整使用 MPV IPC；
- NativePlayerHost 不出现假启用状态；
- 关闭页面后播放器进程停止。

### NLV-016 构建与打包资源

**步骤**

1. 执行类型检查、native 布局审计和桌面构建；
2. 检查 `dist/main/native-libmpv-probe.cjs`；
3. 检查 electron-builder 的 native/libmpv 资源和 asarUnpack。

**预期**

- 全部通过；
- 探针随主进程构建；
- `.node/.dylib/.dll/.so` 位于 asar 外；
- 缺少 native 资源不影响默认构建。

### NLV-017 macOS 原生视频渲染端到端

**步骤**

1. 使用 ffmpeg 生成 640×360、5 秒、含音频的 MP4；
2. 开启 native，并指定实际 addon 与 `/usr/local/lib/libmpv.2.dylib`；
3. 在页面创建 640×360 的播放区域并上报 rect；
4. 主进程获取 BrowserWindow 的原生 `NSView*`；
5. 挂载 `NSOpenGLView`，创建 libmpv OpenGL render context；
6. 播放测试 MP4，等待状态回传；
7. 执行 seek 到 1 秒、暂停、恢复；
8. 验证 position 继续增长、duration=5；
9. 截图，随后 detach、stop 并关闭应用。

**预期**

- `playerBackend=native-libmpv`；
- `linkedLibmpv=true`、`renderApiAvailable=true`、`renderReady=true`；
- 原生视图返回“macOS libmpv OpenGL 视图已挂载”；
- open 返回 `backend=native-libmpv`；
- duration 为 5 秒，position 在恢复后继续增长；
- 状态事件持续回传；
- 无 console error、page error、崩溃或残留播放；
- detach 后原生子视图被释放。

### NLV-018 macOS 自包含安装包自动发现

**步骤**

1. 使用固定 libmpv 源执行 `package:native:dir`；
2. 检查安装包内 addon、libmpv 和全部依赖；
3. 清除所有 native 启用、addon 和 library 环境变量；
4. 启动 packaged app；
5. 执行 NLV-017 的真实播放流程；
6. 检查 `native-runtime-manifest.json`、依赖和签名。

**预期**

- 无环境变量时自动启用 `native-libmpv`；
- 实际加载路径位于 `.app/Contents/Resources`；
- 运行时不包含 `/usr/local` 或 `/opt/homebrew` 依赖；
- 48 个 dylib 依赖闭包无未解析项；
- addon 和 dylib 全部完成签名校验；
- 真实播放和状态回传通过。

### NLV-019 用户关闭并重启回退

**步骤**

1. 在自包含安装包首次启动后保存 `nativeLibmpvEnabled=false`；
2. 关闭并使用同一用户目录重新启动；
3. 读取 appInfo 和播放器后端。

**预期**

- `nativeLibmpvPreferenceEnabled=false`；
- `playerBackend=mpv-ipc`；
- native availability 明确提示用户关闭；
- 不加载 addon 和 libmpv；
- 重新启用后需重启生效。

### NLV-020 Windows/Linux 目标系统编译与渲染

**步骤**

1. Windows runner 编译 `native_view_win.cc`，Linux runner 安装 X11/OpenGL 开发包后编译 `native_view_linux.cc`；
2. Windows 使用固定 libmpv DLL 运行 packaged E2E；
3. Linux X11 使用固定 libmpv `.so` 运行 packaged E2E；
4. Linux Wayland 无 XWayland 时验证 MPV IPC 回退。

**预期**

- Windows addon 编译通过，子 HWND/WGL 挂载、播放和 resize 通过；
- Linux addon 编译通过，X11/GLX 挂载、播放和 resize 通过；
- render 回调始终在对应 GL context 所在线程；
- Wayland 不错误报告 `renderReady=true`；
- 当前在目标 runner 结果产生前标记为“代码已实现、目标机待验收”。

---

## 4. 验收标准

满足以下条件才可认为本轮修复通过：

1. `dlerror()` 空指针导致的段错误已消除；
2. 不再自动搜索系统或 Homebrew libmpv；
3. 主进程首次加载 native addon 前必须完成隔离预检；
4. 探针失败或超时后应用仍能正常启动；
5. 默认 MPV IPC 播放链路全部回归通过；
6. 类型检查、相关单元测试、端到端测试和全量测试通过；
7. 实际 native 环境测试结果必须记录为成功、失败或环境受限，不允许无依据宣称成功；
8. macOS 必须真实完成 NSView 挂载、render context 创建、视频播放、进度增长、seek、暂停、恢复和安全卸载；
9. macOS 自包含安装包必须不依赖开发机绝对路径，并支持无环境变量自动启用；
10. 用户关闭原生内核后，重启必须回退 MPV IPC；
11. Windows/Linux 源码必须进入目标系统 CI 编译，目标机 E2E 未完成前不能宣称三端验收通过；
12. Wayland 无 XWayland 时必须明确回退，不能错误报告 `renderReady=true`。
