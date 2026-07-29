import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateNativeRuntimeLicensing } from "./lib/native-runtime-license.mjs";

const root = process.cwd();
const target = process.argv.includes("--release") ? "release" : "dir";
const requestedArch = String(process.env.FONGMI_NATIVE_ARCH || process.arch).trim();
const targetArch = requestedArch === "arm64" ? "arm64" : "x64";
const source = String(process.env.FONGMI_LIBMPV_SOURCE || process.env.FONGMI_LIBMPV_LIBRARY || "").trim();
if (!source || !path.isAbsolute(source) || !existsSync(source)) {
  throw new Error("原生发布包要求 FONGMI_LIBMPV_SOURCE 指向存在的 libmpv 绝对路径");
}

const packageScript = selectPackageScript(process.platform, targetArch, target);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = {
  ...process.env,
  FONGMI_BUILD_NATIVE_LIBMPV: "1",
  FONGMI_LIBMPV_SOURCE: source,
  FONGMI_NATIVE_ARCH: targetArch,
};

run(npm, ["run", "build:native:libmpv"], environment);
run(npm, ["run", "prepare:libmpv-runtime"], environment);
await validatePreparedRuntimeLicensing(targetArch, target);
run(npm, ["run", packageScript], environment);

console.log(JSON.stringify({
  status: "passed",
  platform: process.platform,
  arch: targetArch,
  target,
  source,
  packageScript,
  stagingDirectory: path.join(root, "build", "native-runtime", "libmpv"),
}, null, 2));

async function validatePreparedRuntimeLicensing(arch, mode) {
  const platformName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const manifestPath = path.join(root, "build", "native-runtime", "libmpv", `${platformName}-${arch}`, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const validation = validateNativeRuntimeLicensing(manifest.licensing);
  const formal = mode === "release";
  if (formal && !validation.valid && process.env.FONGMI_ALLOW_UNVERIFIED_LICENSES !== "1") {
    throw new Error(`正式 native 发布缺少已核验的许可证元数据：\n${validation.issues.join("\n")}`);
  }
  if (!validation.valid) {
    console.warn(`Native runtime licensing remains unverified for this test package:\n${validation.issues.join("\n")}`);
  }
}

function selectPackageScript(platform, arch, mode) {
  if (platform === "darwin") {
    if (arch === "arm64") return mode === "release" ? "package:mac:arm64" : "package:mac:dir:arm64";
    return mode === "release" ? "package:mac" : "package:mac:dir";
  }
  if (platform === "win32") return mode === "release" ? "package:win" : "package:win:dir";
  return mode === "release" ? "package:linux" : "package:linux:dir";
}

function run(command, args, env) {
  execFileSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
