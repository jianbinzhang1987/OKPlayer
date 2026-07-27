import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MpvRuntimeOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  tempDirectory?: string;
}

export function createMpvIpcEndpoint(options: MpvRuntimeOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  if (platform === "win32") return `\\\\.\\pipe\\fongmi-desktop-mpv-${pid}`;
  const tempDirectory = options.tempDirectory ?? os.tmpdir();
  return path.posix.join(tempDirectory.replace(/\\/g, "/"), `fongmi-desktop-mpv-${pid}.sock`);
}

export function isWindowsNamedPipe(value: string): boolean {
  return /^\\\\\.\\pipe\\/i.test(value);
}

export function resolveMpvExecutable(options: MpvRuntimeOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const arch = normalizeMpvArch(options.arch ?? process.arch);
  const env = options.env ?? process.env;
  const explicit = env.FONGMI_MPV_PATH?.trim();
  if (explicit) return explicit;

  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const bundled = resourcesPath
    ? path.join(resourcesPath, "mpv", platformDirectory(platform), arch, platform === "win32" ? "mpv.exe" : "mpv")
    : "";
  if (bundled && existsSync(bundled)) return bundled;

  return platform === "win32" ? "mpv.exe" : "mpv";
}

export function mpvResourceRelativePath(platform: NodeJS.Platform, arch: string): string {
  return path.join("mpv", platformDirectory(platform), normalizeMpvArch(arch), platform === "win32" ? "mpv.exe" : "mpv");
}

function platformDirectory(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

function normalizeMpvArch(arch: string): string {
  if (arch === "arm64") return "arm64";
  return "x64";
}
