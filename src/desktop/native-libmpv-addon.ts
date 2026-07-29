import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface NativeLibmpvBuildInfo {
  name?: string;
  api?: string;
  platform?: string;
  linkedLibmpv?: boolean;
  renderReady?: boolean;
  renderApiAvailable?: boolean;
  libmpvPath?: string;
  libmpvError?: string;
  clientApiVersion?: number;
}

export interface NativeLibmpvPlayerState {
  position: number;
  duration: number;
  speed: number;
  volume: number;
  paused: boolean;
  muted: boolean;
  stopped: boolean;
}

export interface NativeLibmpvViewResult {
  ok: boolean;
  viewHandle: bigint;
  message: string;
}

export interface NativeLibmpvPlayerHandle {
  load(url: string, headers?: Record<string, string>): void;
  play(): void;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setSpeed(speed: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  attachView(parentHandle: bigint, x: number, y: number, width: number, height: number): NativeLibmpvViewResult;
  resizeView(x: number, y: number, width: number, height: number): void;
  detachView(): void;
  isViewAttached(): boolean;
  getState(): NativeLibmpvPlayerState;
  destroy(): void;
}

export interface NativeLibmpvAddon {
  getBuildInfo(): NativeLibmpvBuildInfo;
  createPlayer(): NativeLibmpvPlayerHandle;
}

export interface NativeLibmpvRuntimePaths {
  addonPath: string;
  libraryPath: string;
  source: "explicit" | "managed";
}

export interface NativeLibmpvAvailability {
  available: boolean;
  addonPath?: string;
  libraryPath?: string;
  buildInfo?: NativeLibmpvBuildInfo;
  reason?: string;
}

const requireNative = createRequire(import.meta.url);
const ADDON_FILENAME = "fongmi_libmpv_player.node";

let cachedAvailability: NativeLibmpvAvailability | undefined;
let cachedAddon: NativeLibmpvAddon | undefined;
let cachedPreflight: Promise<NativeLibmpvAvailability> | undefined;

export function hasPackagedNativeLibmpvRuntime(): boolean {
  const platformName = platformResourceName();
  const libraryNames = process.platform === "darwin"
    ? ["libmpv.2.dylib", "libmpv.dylib"]
    : process.platform === "win32"
      ? ["mpv-2.dll", "libmpv-2.dll", "libmpv.dll"]
      : ["libmpv.so.2", "libmpv.so"];
  const roots = [...new Set([
    process.env.FONGMI_LIBMPV_RESOURCE_ROOT,
    process.resourcesPath,
  ].filter((item): item is string => Boolean(item)).map((item) => path.resolve(item)))];
  return roots.some((resourcesPath) => {
    if (!existsSync(path.join(resourcesPath, "native-runtime-manifest.json"))) return false;
    const addonPath = path.join(resourcesPath, "native", "libmpv-player", platformName, ADDON_FILENAME);
    const libraryDirectory = path.join(resourcesPath, "libmpv", platformName);
    return existsSync(addonPath) && libraryNames.some((name) => existsSync(path.join(libraryDirectory, name)));
  });
}

export function isNativeLibmpvExplicitlyEnabled(): boolean {
  if (process.env.FONGMI_ENABLE_NATIVE_LIBMPV === "0") return false;
  return process.env.FONGMI_ENABLE_NATIVE_LIBMPV === "1" || hasPackagedNativeLibmpvRuntime();
}

export function isNativeLibmpvAutoDiscoveryEnabled(): boolean {
  if (process.env.FONGMI_ENABLE_NATIVE_LIBMPV_AUTO_DISCOVERY === "0") return false;
  return process.env.FONGMI_ENABLE_NATIVE_LIBMPV_AUTO_DISCOVERY === "1" || hasPackagedNativeLibmpvRuntime();
}

function isValidNativeAddonPath(addonPath: string | undefined): addonPath is string {
  return Boolean(addonPath && path.isAbsolute(addonPath) && existsSync(addonPath) && path.extname(addonPath).toLowerCase() === ".node");
}

function isValidLibmpvLibraryPath(libraryPath: string | undefined): libraryPath is string {
  if (!libraryPath || !path.isAbsolute(libraryPath) || !existsSync(libraryPath)) return false;
  const libraryName = path.basename(libraryPath).toLowerCase();
  if (process.platform === "darwin") return libraryName.endsWith(".dylib");
  if (process.platform === "win32") return libraryName.endsWith(".dll");
  return libraryName.includes(".so");
}

export function hasExplicitNativeLibmpvPaths(): boolean {
  return isValidNativeAddonPath(process.env.FONGMI_LIBMPV_ADDON?.trim())
    && isValidLibmpvLibraryPath(process.env.FONGMI_LIBMPV_LIBRARY?.trim());
}

export function platformResourceName(platform = process.platform, arch = process.arch): string {
  const normalizedPlatform = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const normalizedArch = arch === "arm64" ? "arm64" : "x64";
  return `${normalizedPlatform}-${normalizedArch}`;
}

function nativeLibmpvManagedResourceRoots(currentDirectory = path.dirname(fileURLToPath(import.meta.url))): string[] {
  return [...new Set([
    process.env.FONGMI_LIBMPV_RESOURCE_ROOT,
    process.resourcesPath,
    path.join(currentDirectory, "..", "..", "resources"),
  ].filter((item): item is string => Boolean(item)).map((item) => path.resolve(item)))];
}

export function nativeLibmpvCandidatePaths(): string[] {
  const platformName = platformResourceName();
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.FONGMI_LIBMPV_ADDON];
  if (isNativeLibmpvAutoDiscoveryEnabled()) {
    for (const root of nativeLibmpvManagedResourceRoots(currentDirectory)) {
      candidates.push(
        path.join(root, "native", "libmpv-player", platformName, ADDON_FILENAME),
        path.join(root, "native", "libmpv-player", ADDON_FILENAME),
      );
    }
    candidates.push(path.join(currentDirectory, "..", "..", "native", "libmpv-player", "build", "Release", ADDON_FILENAME));
  }
  return [...new Set(candidates.filter((item): item is string => Boolean(item)))];
}

export function nativeLibmpvLibraryCandidatePaths(): string[] {
  const platformName = platformResourceName();
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const libraryNames = process.platform === "darwin"
    ? ["libmpv.2.dylib", "libmpv.dylib"]
    : process.platform === "win32"
      ? ["mpv-2.dll", "libmpv-2.dll", "libmpv.dll"]
      : ["libmpv.so.2", "libmpv.so"];
  const roots = [
    process.env.FONGMI_LIBMPV_LIBRARY ? path.dirname(process.env.FONGMI_LIBMPV_LIBRARY) : undefined,
    ...(isNativeLibmpvAutoDiscoveryEnabled()
      ? nativeLibmpvManagedResourceRoots(currentDirectory).map((root) => path.join(root, "libmpv", platformName))
      : []),
  ].filter((item): item is string => Boolean(item));
  const candidates = [process.env.FONGMI_LIBMPV_LIBRARY, ...roots.flatMap((root) => libraryNames.map((name) => path.join(root, name)))];
  return [...new Set(candidates.filter((item): item is string => Boolean(item)))];
}

export function resolveNativeLibmpvRuntimePaths(): NativeLibmpvRuntimePaths | undefined {
  const explicitAddon = process.env.FONGMI_LIBMPV_ADDON?.trim();
  const explicitLibrary = process.env.FONGMI_LIBMPV_LIBRARY?.trim();
  if (isValidNativeAddonPath(explicitAddon) && isValidLibmpvLibraryPath(explicitLibrary)) {
    return { addonPath: explicitAddon, libraryPath: explicitLibrary, source: "explicit" };
  }
  if (!isNativeLibmpvAutoDiscoveryEnabled()) return undefined;
  const addonPath = nativeLibmpvCandidatePaths().find((candidate) => isValidNativeAddonPath(candidate));
  const libraryPath = nativeLibmpvLibraryCandidatePaths().find((candidate) => isValidLibmpvLibraryPath(candidate));
  return addonPath && libraryPath ? { addonPath, libraryPath, source: "managed" } : undefined;
}

function disabledAvailability(): NativeLibmpvAvailability {
  if (!isNativeLibmpvExplicitlyEnabled()) {
    return {
      available: false,
      reason: process.env.FONGMI_ENABLE_NATIVE_LIBMPV === "0"
        ? "原生高兼容内核已被用户或环境设置关闭；重新开启后需重启应用。"
        : "当前未发现可自动启用的完整 libmpv 运行时，应用内高兼容播放暂不可用。",
    };
  }
  if (!resolveNativeLibmpvRuntimePaths()) {
    return {
      available: false,
      reason: isNativeLibmpvAutoDiscoveryEnabled()
        ? "未在安装包资源目录找到匹配的 native addon 与 libmpv 运行时，应用内高兼容播放暂不可用。"
        : "libmpv 后端要求同时提供绝对路径，或开启受控资源目录自动发现；当前应用内高兼容播放暂不可用。",
    };
  }
  return {
    available: false,
    reason: "libmpv 原生插件尚未通过隔离预检，应用内高兼容播放暂不可用。",
  };
}

function probeScriptPath(): string {
  if (process.env.FONGMI_LIBMPV_PROBE_SCRIPT) return process.env.FONGMI_LIBMPV_PROBE_SCRIPT;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "native-libmpv-probe.cjs");
}

export function preflightNativeLibmpvAddon(timeoutMs = 8_000): Promise<NativeLibmpvAvailability> {
  if (cachedAvailability) return Promise.resolve(cachedAvailability);
  if (cachedPreflight) return cachedPreflight;
  const initial = disabledAvailability();
  const runtimePaths = resolveNativeLibmpvRuntimePaths();
  if (!isNativeLibmpvExplicitlyEnabled() || !runtimePaths) {
    cachedAvailability = initial;
    return Promise.resolve(initial);
  }

  const preflight = new Promise<NativeLibmpvAvailability>((resolve) => {
    const { addonPath, libraryPath } = runtimePaths;
    const scriptPath = probeScriptPath();
    if (!existsSync(scriptPath)) {
      cachedAvailability = { available: false, reason: `缺少 libmpv 隔离探针：${scriptPath}` };
      resolve(cachedAvailability);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(process.execPath, [scriptPath, addonPath, libraryPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: process.versions.electron ? "1" : process.env.ELECTRON_RUN_AS_NODE,
        FONGMI_LIBMPV_LIBRARY: libraryPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (availability: NativeLibmpvAvailability) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      cachedAvailability = availability;
      resolve(availability);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish({ available: false, reason: `libmpv 隔离预检启动失败：${error.message}` }));
    child.once("close", (code) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try {
        const payload = line ? JSON.parse(line) as { ok?: boolean; error?: string; buildInfo?: NativeLibmpvBuildInfo } : undefined;
        if (code === 0
          && payload?.ok === true
          && payload.buildInfo?.linkedLibmpv === true
          && payload.buildInfo.renderReady === true) {
          finish({ available: true, addonPath, libraryPath, buildInfo: payload.buildInfo });
          return;
        }
        finish({
          available: false,
          addonPath,
          libraryPath,
          buildInfo: payload?.buildInfo,
          reason: payload?.error
            || (payload?.buildInfo?.linkedLibmpv === true && payload.buildInfo.renderReady !== true
              ? "libmpv core 已加载，但原生视图与 render API 尚未就绪，应用内高兼容播放暂不可用。"
              : stderr.trim() || `libmpv 隔离预检失败，退出码 ${code ?? "unknown"}`),
        });
      } catch (error) {
        finish({ available: false, addonPath, libraryPath, reason: `libmpv 隔离预检输出无效：${error instanceof Error ? error.message : String(error)}` });
      }
    });

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ available: false, addonPath, libraryPath, reason: `libmpv 隔离预检超过 ${timeoutMs}ms，应用内高兼容播放暂不可用。` });
    }, timeoutMs);
  }).finally(() => {
    cachedPreflight = undefined;
  });
  cachedPreflight = preflight;
  return preflight;
}

export function loadNativeLibmpvAddon(): NativeLibmpvAddon | undefined {
  if (cachedAvailability?.available !== true) return undefined;
  if (cachedAddon) return cachedAddon;
  const candidate = cachedAvailability.addonPath;
  const libraryPath = cachedAvailability.libraryPath;
  if (!candidate || !existsSync(candidate) || !libraryPath || !existsSync(libraryPath)) return undefined;
  process.env.FONGMI_LIBMPV_LIBRARY = libraryPath;
  const addon = requireNative(candidate) as NativeLibmpvAddon;
  if (typeof addon?.createPlayer !== "function" || typeof addon?.getBuildInfo !== "function") return undefined;
  cachedAddon = addon;
  return addon;
}

export function getNativeLibmpvAvailability(): NativeLibmpvAvailability {
  return cachedAvailability ?? disabledAvailability();
}

export function createNativeLibmpvPlayer(): NativeLibmpvPlayerHandle | undefined {
  if (!isNativeLibmpvExplicitlyEnabled() || !resolveNativeLibmpvRuntimePaths()) return undefined;
  return loadNativeLibmpvAddon()?.createPlayer();
}

export function resetNativeLibmpvAddonCacheForTests(): void {
  cachedAvailability = undefined;
  cachedAddon = undefined;
  cachedPreflight = undefined;
}
