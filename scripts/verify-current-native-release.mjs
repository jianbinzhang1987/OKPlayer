import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateNativeRuntimeLicensing } from "./lib/native-runtime-license.mjs";

const root = process.cwd();
const requestedArch = String(process.env.FONGMI_NATIVE_ARCH || process.arch).trim();
const arch = requestedArch === "arm64" ? "arm64" : "x64";

if (process.platform === "darwin") {
  execFileSync(process.execPath, ["scripts/verify-release.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      RELEASE_ARCHS: arch,
      REQUIRE_SIGNED: "1",
      REQUIRE_NATIVE_LIBMPV: "1",
    },
  });
} else {
  await verifyCurrentDesktopRelease();
}

async function verifyCurrentDesktopRelease() {
  const platformName = process.platform === "win32" ? "win32" : "linux";
  const unpackedDirectory = path.join(root, "release", process.platform === "win32" ? "win-unpacked" : "linux-unpacked");
  const resourcesDirectory = path.join(unpackedDirectory, "resources");
  const executable = path.join(unpackedDirectory, process.platform === "win32" ? "FongMi Desktop.exe" : "fongmi-desktop");
  const manifestPath = path.join(resourcesDirectory, "native-runtime-manifest.json");
  for (const required of [unpackedDirectory, resourcesDirectory, executable, manifestPath]) {
    if (!existsSync(required)) throw new Error(`发布验收缺少文件：${required}`);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.platform !== process.platform) throw new Error(`native manifest 平台错误：${manifest.platform}`);
  if (manifest.arch !== arch) throw new Error(`native manifest 架构错误：${manifest.arch}`);
  if (!Array.isArray(manifest.files) || manifest.files.length < 2) throw new Error("native manifest 文件数量不足");
  if (manifest.dependencyAudit?.unresolved?.length > 0) {
    throw new Error(`native 运行时仍有未解析依赖：${JSON.stringify(manifest.dependencyAudit.unresolved)}`);
  }
  const licensingValidation = validateNativeRuntimeLicensing(manifest.licensing);
  if (!licensingValidation.valid && process.env.FONGMI_ALLOW_UNVERIFIED_LICENSES !== "1") {
    throw new Error(`正式发布的 native runtime 许可证元数据不完整：\n${licensingValidation.issues.join("\n")}`);
  }

  const verifyManifestHashes = manifest.hashStage === "final" || process.platform === "linux";
  const verifiedFiles = [];
  for (const entry of manifest.files) {
    const file = path.join(resourcesDirectory, entry.path);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`native manifest 文件缺失：${entry.path}`);
    const digest = await sha256(file);
    const hashMatches = digest === entry.sha256;
    if (verifyManifestHashes && !hashMatches) throw new Error(`native 文件 SHA-256 不一致：${entry.path}`);
    verifiedFiles.push({
      file,
      relativePath: entry.path,
      bytes: info.size,
      manifestSha256: entry.sha256,
      finalSha256: digest,
      hashMatches,
    });
  }

  const platformResource = `${platformName}-${arch}`;
  const addon = path.join(resourcesDirectory, "native", "libmpv-player", platformResource, "fongmi_libmpv_player.node");
  const libraryCandidates = process.platform === "win32"
    ? ["mpv-2.dll", "libmpv-2.dll", "libmpv.dll"]
    : ["libmpv.so.2", "libmpv.so"];
  const libraryDirectory = path.join(resourcesDirectory, "libmpv", platformResource);
  const library = libraryCandidates.map((name) => path.join(libraryDirectory, name)).find(existsSync);
  if (!existsSync(addon)) throw new Error(`发布包缺少 native addon：${addon}`);
  if (!library) throw new Error(`发布包缺少规范 libmpv 入口：${libraryDirectory}`);

  const signatureAudit = process.platform === "win32"
    ? await verifyWindowsSignatures(executable, verifiedFiles.map((entry) => entry.file))
    : { required: false, checked: 0, invalid: [] };
  const dependencyAudit = process.platform === "linux"
    ? verifyLinuxDependencies(library, libraryDirectory)
    : manifest.dependencyAudit;
  if (dependencyAudit.unresolved.length > 0) {
    throw new Error(`目标包依赖验收失败：${JSON.stringify(dependencyAudit.unresolved)}`);
  }

  const releaseArtifacts = await findReleaseArtifacts(process.platform);
  if (releaseArtifacts.length === 0) {
    throw new Error(process.platform === "win32" ? "缺少 Windows NSIS/portable 发布文件" : "缺少 Linux AppImage/DEB 发布文件");
  }

  const report = {
    verifiedAt: new Date().toISOString(),
    platform: process.platform,
    arch,
    unpackedDirectory,
    executable,
    addon,
    library,
    manifestFiles: manifest.files.length,
    manifestHashStage: manifest.hashStage ?? "legacy-unspecified",
    verifyManifestHashes,
    licensing: manifest.licensing,
    licensingValidation,
    nativeFiles: verifiedFiles.map(({ file, ...entry }) => ({ ...entry, path: path.relative(root, file) })),
    dependencyAudit,
    signatureAudit,
    releaseArtifacts: await Promise.all(releaseArtifacts.map(async (file) => ({
      path: path.relative(root, file),
      bytes: (await stat(file)).size,
      sha256: await sha256(file),
    }))),
    passed: true,
  };
  const artifactDirectory = path.join(root, "artifacts", "release-audit");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    path.join(artifactDirectory, `native-current-${platformName}-${arch}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
}

async function verifyWindowsSignatures(executable, nativeFiles) {
  const required = process.env.REQUIRE_SIGNED !== "0";
  const files = [executable, ...nativeFiles];
  const invalid = [];
  for (const file of files) {
    const escaped = file.replace(/'/g, "''");
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()`,
    ], { encoding: "utf8" }).trim();
    if (output !== "Valid") invalid.push({ file, status: output || "Unknown" });
  }
  if (required && invalid.length > 0) {
    throw new Error(`Windows 发布文件签名无效：${invalid.map((item) => `${item.file}=${item.status}`).join(", ")}`);
  }
  return { required, checked: files.length, invalid };
}

function verifyLinuxDependencies(library, libraryDirectory) {
  const output = execFileSync("ldd", [library], {
    encoding: "utf8",
    env: { ...process.env, LD_LIBRARY_PATH: libraryDirectory },
  });
  const unresolved = [];
  const externalSystemDependencies = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("linux-vdso.so")) continue;
    const missing = /^([^\s]+)\s+=>\s+not found$/.exec(line);
    if (missing) {
      unresolved.push({ file: library, dependency: missing[1] });
      continue;
    }
    const resolved = /^([^\s]+)\s+=>\s+(\/[^\s]+)\s+\(/.exec(line);
    if (!resolved) continue;
    if (resolved[2].startsWith(`${libraryDirectory}${path.sep}`)) continue;
    if (isLinuxSystemPath(resolved[2])) externalSystemDependencies.push(resolved[1]);
    else unresolved.push({ file: library, dependency: resolved[2] });
  }
  return {
    checked: 1,
    unresolved,
    externalSystemDependencies: [...new Set(externalSystemDependencies)].sort(),
  };
}

function isLinuxSystemPath(file) {
  const normalized = path.resolve(file);
  return normalized.startsWith("/lib/")
    || normalized.startsWith("/lib64/")
    || normalized.startsWith("/usr/lib/")
    || normalized.startsWith("/usr/lib64/");
}

async function findReleaseArtifacts(platform) {
  const releaseDirectory = path.join(root, "release");
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(releaseDirectory, entry.name))
    .filter((file) => platform === "win32"
      ? /\.(exe|msi)$/i.test(file)
      : /\.(AppImage|deb)$/i.test(file));
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}
