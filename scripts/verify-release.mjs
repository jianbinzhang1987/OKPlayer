import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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

const targets = [
  { arch: "x64", appDirectory: "mac", expectedMachO: "x86_64" },
  { arch: "arm64", appDirectory: "mac-arm64", expectedMachO: "arm64" },
];

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
  });
}

if (results.length !== targets.length) {
  throw new Error(`发布包不完整：期望 ${targets.length} 个架构，实际找到 ${results.length} 个`);
}

const signedAll = results.every((item) => item.signing.signed);
const gatekeeperAcceptedAll = results.every((item) => item.signing.gatekeeperAccepted);
const passed = !requireSigned || (signedAll && gatekeeperAcceptedAll);
const report = {
  verifiedAt: new Date().toISOString(),
  version,
  requireSigned,
  signedAll,
  gatekeeperAcceptedAll,
  unsigned: !signedAll,
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
