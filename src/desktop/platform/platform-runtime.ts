import type { BrowserWindowConstructorOptions } from "electron";
import { createMpvIpcEndpoint, resolveMpvExecutable } from "./player-runtime.ts";
import { createMainWindowOptions, normalizeDesktopPlatform, type DesktopPlatform } from "./window-options.ts";

export const PRODUCT_NAME = "FongMi Desktop";
export const PACKAGE_NAME = "fongmi-desktop";
export const APP_ID = "com.fongmi.desktop";
export const DATABASE_FILENAME = "fongmi-desktop.sqlite";
export const LEGACY_PRODUCT_NAMES = ["FongMi macOS", "fongmi-macos"] as const;
export const LEGACY_DATABASE_FILENAMES = ["tv-macos.sqlite"] as const;

export interface DesktopPlatformRuntime {
  platform: DesktopPlatform;
  nodePlatform: NodeJS.Platform;
  usesMacTrafficLights: boolean;
  createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions;
  getMpvExecutable(): string;
  getMpvIpcEndpoint(): string;
  supportsExternalIina: boolean;
}

export function createDesktopPlatformRuntime(
  nodePlatform: NodeJS.Platform = process.platform,
): DesktopPlatformRuntime {
  return {
    platform: normalizeDesktopPlatform(nodePlatform),
    nodePlatform,
    usesMacTrafficLights: nodePlatform === "darwin",
    createWindowOptions: (preloadPath) => createMainWindowOptions(nodePlatform, preloadPath),
    getMpvExecutable: () => resolveMpvExecutable({ platform: nodePlatform }),
    getMpvIpcEndpoint: () => createMpvIpcEndpoint({ platform: nodePlatform }),
    supportsExternalIina: nodePlatform === "darwin",
  };
}
