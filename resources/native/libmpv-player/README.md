# Native libmpv Player Addon Layout

该目录用于保存三端 Node-API addon 编译产物：

```text
native/libmpv-player/
  darwin-x64/fongmi_libmpv_player.node
  darwin-arm64/fongmi_libmpv_player.node
  win32-x64/fongmi_libmpv_player.node
  linux-x64/fongmi_libmpv_player.node
```

## 构建

```bash
FONGMI_BUILD_NATIVE_LIBMPV=1 \
FONGMI_NATIVE_ARCH=x64 \
npm run build:native:libmpv
```

构建脚本会按当前操作系统和目标架构复制 addon。三端 CI 会在对应 runner 上实际编译，避免用 macOS 交叉生成 Windows/Linux 原生模块。

## 运行时启用规则

1. 安装包包含 `native-runtime-manifest.json`、匹配 addon 和匹配 libmpv 动态库时，应用会自动启用受控资源目录发现；
2. 首次加载仍在隔离子进程中执行，失败或超过 8 秒自动回退 MPV JSON IPC；
3. 只有 `linkedLibmpv=true`、`renderApiAvailable=true`、`renderReady=true` 才会启用 native 后端；
4. 用户可在设置页关闭“原生高兼容内核”，重启后强制回退 MPV IPC；
5. `FONGMI_ENABLE_NATIVE_LIBMPV=0` 可在启动前强制禁用；
6. 开发调试可显式设置 `FONGMI_LIBMPV_ADDON` 与 `FONGMI_LIBMPV_LIBRARY` 的绝对路径；
7. 未知、缺失或不匹配的 `.node` 文件不得由 Renderer 直接加载。

## 平台状态

- macOS：NSOpenGLView + libmpv OpenGL render API 已完成并通过真实视频 E2E；
- Windows：子 HWND + WGL 渲染线程已实现，等待 Windows runner 编译和目标机 E2E；
- Linux：X11 子窗口 + GLX 渲染线程已实现，Wayland 无 XWayland 时明确回退，等待 Linux runner 编译和目标机 E2E。
