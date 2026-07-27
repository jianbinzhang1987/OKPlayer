import path from "node:path";

export const DESKTOP_PRODUCT_NAME = "FongMi Desktop";

export function resolvePackagedExecutable({
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  explicit = process.env.FONGMI_PACKAGED_EXECUTABLE,
} = {}) {
  if (explicit?.trim()) return path.resolve(explicit.trim());
  if (platform === "darwin") {
    const directory = arch === "arm64" ? "mac-arm64" : "mac";
    return path.join(root, "release", directory, `${DESKTOP_PRODUCT_NAME}.app`, "Contents", "MacOS", DESKTOP_PRODUCT_NAME);
  }
  if (platform === "win32") {
    return path.join(root, "release", "win-unpacked", `${DESKTOP_PRODUCT_NAME}.exe`);
  }
  return path.join(root, "release", "linux-unpacked", "fongmi-desktop");
}

export function resolvePackagedApplicationDirectory({
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const executable = resolvePackagedExecutable({ root, platform, arch });
  if (platform === "darwin") return path.resolve(executable, "../../..");
  return path.dirname(executable);
}
