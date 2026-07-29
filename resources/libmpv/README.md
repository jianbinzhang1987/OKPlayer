# libmpv Runtime Resources

源码仓库不提交 libmpv、FFmpeg 及其依赖二进制。正式运行时通过受控准备脚本生成到：

```text
build/native-runtime/libmpv/
  darwin-x64/
  darwin-arm64/
  win32-x64/
  linux-x64/
```

electron-builder 只会把当前目标平台目录复制到安装包：

```text
Resources/libmpv/<platform>-<arch>/
```

## 准备运行时

```bash
FONGMI_LIBMPV_SOURCE=/absolute/path/to/libmpv \
FONGMI_NATIVE_ARCH=x64 \
npm run prepare:libmpv-runtime
```

macOS 准备过程会：

1. 递归读取 `otool -L`；
2. 收集所有非系统 dylib；
3. 统一复制到同一目录；
4. 将 install name 和依赖改写为 `@loader_path`；
5. 检查依赖闭包；
6. 对每个 dylib 进行 ad-hoc 或 Developer ID 签名；
7. 写入带 SHA-256 的 `runtime-manifest.json`。

Windows 会通过 `dumpbin`、`llvm-objdump` 或 `objdump` 递归解析 DLL 依赖，只复制实际闭包并阻断缺失依赖；Linux 通过 `ldd` 递归解析依赖，使用 `patchelf` 将包内依赖统一到 `$ORIGIN`，同时在 manifest 中记录仍由系统提供的 ABI 库。依赖分布在多个目录时可设置：

```bash
FONGMI_LIBMPV_DEPENDENCY_DIRS=/absolute/deps1:/absolute/deps2
```

Windows 使用系统路径分隔符 `;`。非规范入口文件名会自动生成 `mpv-2.dll` 或 `libmpv.so.2` 等运行时可发现入口。

## 一键构建

```bash
FONGMI_LIBMPV_SOURCE=/absolute/path/to/libmpv npm run package:native:dir
```

正式发布：

```bash
FONGMI_LIBMPV_SOURCE=/absolute/path/to/libmpv npm run release:formal:native
```

正式发布还要求有效的 Developer ID / Windows 签名配置。`afterPack` 会生成 `native-runtime-manifest.json`，发布审计会验证架构、依赖、签名和动态库完整性。

所有第三方动态库必须使用固定来源、固定版本、SHA-256 校验，并同步更新 `THIRD_PARTY_NOTICES.md`。Windows CI 仅在同时提供固定 ZIP URL 和 SHA-256 时才执行原生运行时构建与 E2E，避免引入未经确认的第三方二进制。
