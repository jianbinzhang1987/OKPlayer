# Prepared libmpv Runtime

该目录是发布构建暂存区。实际动态库由以下命令生成：

```bash
FONGMI_LIBMPV_SOURCE=/absolute/path/to/libmpv npm run prepare:libmpv-runtime
```

生成的二进制与 `runtime-manifest.json` 已被 `.gitignore` 排除，不应提交到源码仓库。electron-builder 会把这里的运行时复制到安装包 `Resources/libmpv/`。
