# macOS 发布流程

## 当前发布基线

- 应用名称：`FongMi Desktop`
- Bundle ID：`com.fongmi.desktop`
- 最低系统版本：macOS 12.0
- Electron：43.2.0
- 架构：Intel x64、Apple Silicon arm64
- 应用图标：`build/icon.icns`
- DMG 背景：`build/dmg-background.png`
- 播放引擎：原生 `<video>`、本地打包 HLS.js 1.6.16、mpv 兼容降级

## 构建准备

```bash
cd /Users/adolf/Desktop/code/TV/mac
npm ci
npm run verify:electron
npm run typecheck
npm test
```

## 生成发布资源

```bash
npm run assets:build
```

该命令使用 macOS 自带的 `sips`、`qlmanage` 和 `iconutil`，根据 SVG 源文件生成：

```text
build/icon.png
build/icon.icns
build/dmg-background.png
```

不依赖 ImageMagick，也不需要手工维护多套图标尺寸。

## 构建安装包

Intel Mac：

```bash
npm run package:dmg
```

Apple Silicon Mac：

```bash
npm run package:dmg:arm64
```

同时构建两种架构：

```bash
npm run package:dmg:all
```

输出文件：

```text
release/FongMi Desktop-<version>-x64.dmg
release/FongMi Desktop-<version>-arm64.dmg
```

## 发布包验证

```bash
npm run release:verify
```

验证项目包括：

- DMG 校验和；
- Mach-O 二进制架构；
- Bundle ID、版本号、最低系统版本；
- 应用内图标与构建图标校验和一致；
- `app.asar` 中存在本地 HLS.js 分块；
- x64 与 arm64 发布物是否完整。

验证报告输出到：

```text
artifacts/release-audit/release-report.json
```

打包应用窗口验收：

```bash
PLAYWRIGHT_MODULE_PATH=<playwright/index.js> node scripts/playwright-packaged-audit.mjs
```

结果输出到：

```text
artifacts/release-audit/packaged-home.png
artifacts/release-audit/report.json
```

## 当前签名状态

当前测试包未使用有效的 Apple Developer ID Application 证书，适合内部开发和测试，不应作为正式外部分发版本。

正式发布前仍需完成：

1. 配置有效的 Developer ID Application 证书；
2. 为主应用及辅助进程完成代码签名；
3. 提交 Apple 公证并执行 stapling；
4. 在一台未安装开发环境的 Mac 上进行 Gatekeeper 安装测试；
5. 配置正式升级地址和自动更新签名。

在签名和公证完成前，发布校验报告会明确记录：

```json
{
  "unsigned": true
}
```
