import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { validateNativeRuntimeLicensing } from "./lib/native-runtime-license.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const releaseDirectory = path.join(root, "release");
const buildIcon = path.join(root, "build", "icon.icns");
const artifactDirectory = path.join(root, "artifacts", "release-audit");
const asarBinary = path.join(root, "node_modules", ".bin", "asar");
const requireSigned = process.env.REQUIRE_SIGNED === "1";
const requireNativeLibmpv = process.env.REQUIRE_NATIVE_LIBMPV === "1";

const allTargets = [
  { arch: "x64", appDirectory: "mac", expectedMachO: "x86_64" },
  { arch: "arm64", appDirectory: "mac-arm64", expectedMachO: "arm64" },
];
const requestedArchitectures = String(process.env.RELEASE_ARCHS || "x64,arm64")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const targets = allTargets.filter((target) => requestedArchitectures.includes(target.arch));
if (targets.length === 0) throw new Error(`没有可验证的发布架构：${requestedArchitectures.join(",")}`);

await mkdir(artifactDirectory, { recursive: true });
const buildIconHash = await sha256(buildIcon);
const results = [];
const checksumLines = [];

for (const target of targets) {
  const dmgPath = path.join(releaseDirectory, `FongMi Desktop-${version}-${target.arch}.dmg`);
  const appPath = path.join(releaseDirectory, target.appDirectory, "FongMi Desktop.app");
  const binaryPath = path.join(appPath, "Contents", "MacOS", "FongMi Desktop");
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const frameworkPlist = path.join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "Info.plist");
  const bundleIcon = path.join(appPath, "Contents", "Resources", "icon.icns");
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");

  const [dmgInfo, appInfo] = await Promise.all([
    stat(dmgPath).catch(() => undefined),
    stat(appPath).catch(() => undefined),
  ]);
  if (!dmgInfo || !appInfo) continue;

  execFileSync("hdiutil", ["verify", dmgPath], { stdio: "ignore" });
  const dmgSha256 = await sha256(dmgPath);
  checksumLines.push(`${dmgSha256}  ${path.basename(dmgPath)}`);

  const architecture = execFileSync("file", [binaryPath], { encoding: "utf8" }).trim();
  if (!architecture.includes(target.expectedMachO)) {
    throw new Error(`${target.arch} 二进制架构不正确：${architecture}`);
  }

  const bundleIdentifier = plistValue(plistPath, "CFBundleIdentifier");
  const bundleVersion = plistValue(plistPath, "CFBundleShortVersionString");
  const displayName = plistValue(plistPath, "CFBundleDisplayName");
  const minimumSystemVersion = plistValue(plistPath, "LSMinimumSystemVersion");
  const iconFile = plistValue(plistPath, "CFBundleIconFile");
  const electronVersion = plistValue(frameworkPlist, "CFBundleVersion");
  if (bundleIdentifier !== "com.fongmi.desktop") throw new Error(`${target.arch} Bundle ID 不正确`);
  if (bundleVersion !== version) throw new Error(`${target.arch} 版本号不正确`);
  if (displayName !== "FongMi Desktop") throw new Error(`${target.arch} 应用显示名称不正确`);
  if (iconFile !== "icon.icns") throw new Error(`${target.arch} 未使用正式应用图标`);
  if (electronVersion !== "43.2.0") throw new Error(`${target.arch} Electron Framework 版本不正确`);

  const bundleIconHash = await sha256(bundleIcon);
  if (bundleIconHash !== buildIconHash) throw new Error(`${target.arch} 应用图标与构建资源不一致`);

  const asarEntries = execFileSync(asarBinary, ["list", asarPath], { encoding: "utf8" });
  const hlsChunks = asarEntries.split("\n").filter((entry) => /\/dist\/renderer\/assets\/hls-.+\.js$/.test(entry));
  if (hlsChunks.length !== 1) throw new Error(`${target.arch} 应用包中本地 HLS.js 分块数量异常：${hlsChunks.length}`);
  const hlsChunk = hlsChunks[0];
  const artPlayerChunks = asarEntries.split("\n").filter((entry) => /\/dist\/renderer\/assets\/ArtPlayerHost-.+\.js$/.test(entry));
  if (artPlayerChunks.length !== 1) throw new Error(`${target.arch} 应用包中 ArtPlayer 按需分块数量异常：${artPlayerChunks.length}`);
  const artPlayerChunk = artPlayerChunks[0];
  if (!asarEntries.split("\n").includes("/THIRD_PARTY_NOTICES.md")) throw new Error(`${target.arch} 应用包缺少第三方许可证声明`);
  const rendererHtml = asar.extractFile(asarPath, "dist/renderer/index.html").toString("utf8");
  if (/cdn\.jsdelivr/i.test(rendererHtml)) throw new Error(`${target.arch} 应用包仍包含 HLS CDN 引用`);
  if (!/script-src 'self'/.test(rendererHtml)) throw new Error(`${target.arch} 应用包 CSP 未限制为本地脚本`);

  const signing = assessSigning(appPath);
  const nativeRuntime = await assessNativeRuntime(appPath, target.expectedMachO, requireNativeLibmpv);
  const mounted = await inspectDmg(dmgPath, target.expectedMachO);

  results.push({
    arch: target.arch,
    dmg: path.relative(root, dmgPath),
    dmgBytes: dmgInfo.size,
    dmgSha256,
    application: path.relative(root, appPath),
    architecture,
    bundleIdentifier,
    displayName,
    version: bundleVersion,
    electronVersion,
    minimumSystemVersion,
    iconSha256: bundleIconHash,
    hlsChunk,
    artPlayerChunk,
    thirdPartyNotices: true,
    localScriptsOnly: true,
    mounted,
    signing,
    nativeRuntime,
  });
}

if (results.length !== targets.length) {
  throw new Error(`发布包不完整：期望 ${targets.length} 个架构，实际找到 ${results.length} 个`);
}

const signedAll = results.every((item) => item.signing.signed);
const gatekeeperAcceptedAll = results.every((item) => item.signing.gatekeeperAccepted);
const nativeRuntimeReadyAll = results.every((item) => item.nativeRuntime.ready || !requireNativeLibmpv);
const passed = (!requireSigned || (signedAll && gatekeeperAcceptedAll)) && nativeRuntimeReadyAll;
const report = {
  verifiedAt: new Date().toISOString(),
  version,
  requireSigned,
  requireNativeLibmpv,
  signedAll,
  gatekeeperAcceptedAll,
  unsigned: !signedAll,
  nativeRuntimeReadyAll,
  targets: results,
  passed,
};

const reportFileName = requireSigned ? "release-report-signed.json" : "release-report.json";
await writeFile(path.join(releaseDirectory, "SHA256SUMS.txt"), `${checksumLines.sort().join("\n")}\n`, "utf8");
await writeFile(path.join(artifactDirectory, reportFileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

if (!passed) {
  console.error("正式发布校验失败：应用必须使用 Developer ID 签名，并通过 Gatekeeper 评估。测试包可使用 npm run release:verify。");
  process.exitCode = 1;
}

function plistValue(plistPath, key) {
  return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plistPath], { encoding: "utf8" }).trim();
}

function assessSigning(appPath) {
  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const details = run("codesign", ["-dv", "--verbose=4", appPath]);
  const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  return {
    signed: verify.ok,
    identity: extract(details.output, /^Authority=(.+)$/m),
    teamIdentifier: extract(details.output, /^TeamIdentifier=(.+)$/m),
    hardenedRuntime: /flags=.*runtime/m.test(details.output),
    gatekeeperAccepted: gatekeeper.ok,
    gatekeeperSource: extract(gatekeeper.output, /^source=(.+)$/m),
    notarized: /Notarized Developer ID/i.test(gatekeeper.output),
    verifyMessage: verify.output.trim() || null,
    gatekeeperMessage: gatekeeper.output.trim() || null,
  };
}

async function assessNativeRuntime(appPath, expectedMachO, required) {
  const resourcesDirectory = path.join(appPath, "Contents", "Resources");
  const manifestPath = path.join(resourcesDirectory, "native-runtime-manifest.json");
  const manifest = await readFile(manifestPath, "utf8").then(JSON.parse, () => undefined);
  if (!manifest) {
    if (required) throw new Error(`缺少 native runtime manifest：${manifestPath}`);
    return { present: false, ready: false, required, files: [] };
  }

  const licensingValidation = validateNativeRuntimeLicensing(manifest.licensing);
  if (required && !licensingValidation.valid && process.env.FONGMI_ALLOW_UNVERIFIED_LICENSES !== "1") {
    throw new Error(`正式发布的 native runtime 许可证元数据不完整：\n${licensingValidation.issues.join("\n")}`);
  }

  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const files = [];
  for (const entry of entries) {
    const relativePath = String(entry.path ?? "");
    const filePath = path.join(resourcesDirectory, relativePath);
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`native runtime 文件不存在：${relativePath}`);
    const architecture = execFileSync("file", [filePath], { encoding: "utf8" }).trim();
    const architectureValid = architecture.includes(expectedMachO);
    if (!architectureValid) throw new Error(`native runtime 架构不正确：${relativePath} ${architecture}`);

    const dependencyAudit = relativePath.endsWith(".dylib") ? auditPackagedDarwinLibrary(filePath) : { unresolved: [] };
    if (dependencyAudit.unresolved.length > 0) {
      throw new Error(`native runtime 包含开发机或未闭合依赖：${relativePath}\n${dependencyAudit.unresolved.join("\n")}`);
    }

    const signatureVerify = run("codesign", ["--verify", "--strict", "--verbose=2", filePath]);
    const signatureDetails = run("codesign", ["-dv", "--verbose=4", filePath]);
    const developerIdSigned = /Authority=Developer ID Application:/m.test(signatureDetails.output);
    if (requireSigned && !developerIdSigned) {
      throw new Error(`正式发布的 native runtime 未使用 Developer ID 签名：${relativePath}`);
    }
    files.push({
      path: relativePath,
      bytes: info.size,
      architecture,
      architectureValid,
      signed: signatureVerify.ok,
      developerIdSigned,
      teamIdentifier: extract(signatureDetails.output, /^TeamIdentifier=(.+)$/m),
      dependencyAudit,
    });
  }

  const addonPresent = files.some((item) => item.path.endsWith("fongmi_libmpv_player.node"));
  const libmpvPresent = files.some((item) => /libmpv.*\.(?:dylib|dll)|libmpv\.so/i.test(item.path));
  const manifestClosed = manifest.dependencyAudit?.unresolved?.length === 0;
  const ready = addonPresent && libmpvPresent && manifestClosed && files.every((item) => item.architectureValid && item.signed);
  if (required && !ready) throw new Error("native libmpv 运行时未满足正式发布要求");
  return {
    present: true,
    ready,
    required,
    addonPresent,
    libmpvPresent,
    manifestClosed,
    signing: manifest.signing,
    licensing: manifest.licensing,
    licensingValidation,
    files,
  };
}

function auditPackagedDarwinLibrary(filePath) {
  const unresolved = execFileSync("otool", ["-L", filePath], { encoding: "utf8" })
    .split("\n").slice(1)
    .map((line) => /^\s*(.+?)\s+\(compatibility version/.exec(line)?.[1])
    .filter(Boolean)
    .filter((dependency) => !dependency.startsWith("/System/Library/") && !dependency.startsWith("/usr/lib/"))
    .filter((dependency) => {
      if (!dependency.startsWith("@loader_path/")) return true;
      const target = path.resolve(path.dirname(filePath), dependency.slice("@loader_path/".length));
      return !existsSync(target);
    });
  return { unresolved };
}

async function inspectDmg(dmgPath, expectedMachO) {
  const mountPoint = await mkdtemp(path.join(os.tmpdir(), "fongmi-release-verify-"));
  try {
    execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath], { stdio: "ignore" });
    const applicationLink = path.join(mountPoint, "Applications");
    const applicationLinkInfo = await lstat(applicationLink);
    if (!applicationLinkInfo.isSymbolicLink()) throw new Error("DMG 缺少 Applications 符号链接");
    const applicationLinkTarget = await readlink(applicationLink);
    if (applicationLinkTarget !== "/Applications") throw new Error(`Applications 链接错误：${applicationLinkTarget}`);

    const appPath = path.join(mountPoint, "FongMi Desktop.app");
    const binaryPath = path.join(appPath, "Contents", "MacOS", "FongMi Desktop");
    const frameworkPlist = path.join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "Info.plist");
    const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
    const architecture = execFileSync("file", [binaryPath], { encoding: "utf8" }).trim();
    if (!architecture.includes(expectedMachO)) throw new Error(`DMG 内应用架构不正确：${architecture}`);
    const electronVersion = plistValue(frameworkPlist, "CFBundleVersion");
    if (electronVersion !== "43.2.0") throw new Error(`DMG 内 Electron Framework 版本不正确：${electronVersion}`);
    const mountedEntries = asar.listPackage(asarPath);
    const mountedHlsChunks = mountedEntries.filter((entry) => /dist\/renderer\/assets\/hls-.+\.js$/.test(entry));
    if (mountedHlsChunks.length !== 1) throw new Error(`DMG 内 HLS.js 分块数量异常：${mountedHlsChunks.length}`);
    const mountedArtPlayerChunks = mountedEntries.filter((entry) => /dist\/renderer\/assets\/ArtPlayerHost-.+\.js$/.test(entry));
    if (mountedArtPlayerChunks.length !== 1) throw new Error(`DMG 内 ArtPlayer 按需分块数量异常：${mountedArtPlayerChunks.length}`);
    if (!mountedEntries.includes("THIRD_PARTY_NOTICES.md") && !mountedEntries.includes("/THIRD_PARTY_NOTICES.md")) throw new Error("DMG 内应用缺少第三方许可证声明");
    const mountedHtml = asar.extractFile(asarPath, "dist/renderer/index.html").toString("utf8");
    if (/cdn\.jsdelivr/i.test(mountedHtml)) throw new Error("DMG 内应用仍包含 HLS CDN 引用");
    if (!/script-src 'self'/.test(mountedHtml)) throw new Error("DMG 内应用 CSP 未限制为本地脚本");
    const nativeRuntime = await assessNativeRuntime(appPath, expectedMachO, requireNativeLibmpv);

    await Promise.all([
      stat(path.join(mountPoint, ".DS_Store")),
      stat(path.join(mountPoint, ".background.png")),
      stat(path.join(mountPoint, ".VolumeIcon.icns")),
    ]);
    const backgroundInfo = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path.join(mountPoint, ".background.png")], { encoding: "utf8" });
    const width = Number(extract(backgroundInfo, /pixelWidth: (\d+)/)?.trim());
    const height = Number(extract(backgroundInfo, /pixelHeight: (\d+)/)?.trim());
    if (width !== 660 || height !== 400) throw new Error(`DMG 背景尺寸不正确：${width}×${height}`);

    return {
      applicationsLink: applicationLinkTarget,
      background: `${width}x${height}`,
      dsStore: true,
      volumeIcon: true,
      architecture,
      electronVersion,
      hlsChunk: mountedHlsChunks[0],
      artPlayerChunk: mountedArtPlayerChunks[0],
      thirdPartyNotices: true,
      localScriptsOnly: true,
      nativeRuntime,
    };
  } finally {
    run("hdiutil", ["detach", mountPoint, "-quiet"]);
    await rm(mountPoint, { recursive: true, force: true });
  }
}

function extract(value, pattern) {
  return pattern.exec(value)?.[1] ?? null;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

async function sha256(filePath) {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}
