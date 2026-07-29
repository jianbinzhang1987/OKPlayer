import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const enabled = process.env.FONGMI_BUILD_NATIVE_LIBMPV === "1";
const projectDir = path.join(root, "native", "libmpv-player");
const buildOutput = path.join(projectDir, "build", "Release", "fongmi_libmpv_player.node");
const normalizedPlatform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const requestedArch = String(process.env.FONGMI_NATIVE_ARCH || process.arch).trim();
const normalizedArch = requestedArch === "arm64" ? "arm64" : "x64";
const distributionDir = path.join(root, "resources", "native", "libmpv-player", `${normalizedPlatform}-${normalizedArch}`);
const distributionOutput = path.join(distributionDir, "fongmi_libmpv_player.node");

if (!enabled) {
  console.log("Native libmpv build skipped. Set FONGMI_BUILD_NATIVE_LIBMPV=1 to build the optional Node-API addon.");
  process.exit(0);
}

if (!existsSync(projectDir)) throw new Error(`Native libmpv project is missing: ${projectDir}`);
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "--", `--arch=${normalizedArch}`], {
  cwd: projectDir,
  stdio: "inherit",
  env: process.env,
});
if (!existsSync(buildOutput)) throw new Error(`Native libmpv addon was not produced: ${buildOutput}`);
await mkdir(distributionDir, { recursive: true });
await copyFile(buildOutput, distributionOutput);
console.log(`Native libmpv addon copied to ${path.relative(root, distributionOutput)}`);
