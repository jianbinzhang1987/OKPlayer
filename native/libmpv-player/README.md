# FongMi Desktop libmpv Native Addon

该目录是高兼容播放器的原生深度内嵌子工程。

当前实现状态：

- 已建立 Node-API addon 入口；
- 已定义播放器控制接口与状态模型；
- 已预留 macOS / Windows / Linux 三端原生视图桥接文件；
- 默认实现为可编译接入骨架，不强制依赖本机已安装的 libmpv；
- 后续接入 libmpv render API 时，应在 `LibmpvPlayer` 内替换当前状态桩逻辑。

## 预期产物

```text
native/libmpv-player/build/Release/fongmi_libmpv_player.node
```

发布时建议复制到：

```text
resources/native/libmpv-player/<platform>-<arch>/fongmi_libmpv_player.node
resources/libmpv/<platform>-<arch>/*
```

其中 `resources/libmpv` 存放平台相关动态库，`resources/native` 存放 Node-API addon。

## 编译入口

```bash
cd native/libmpv-player
npm run build
```

真正启用 libmpv 时，需要补充：

1. libmpv 头文件与链接库路径；
2. macOS `.dylib` 的 rpath 与签名；
3. Windows `mpv-2.dll` / FFmpeg DLL 同目录分发；
4. Linux `libmpv.so` / AppImage AppDir 或 DEB 依赖策略；
5. render API 线程模型和 OpenGL/Metal/X11 绑定。
