import type { BrowserWindowConstructorOptions } from "electron";

export type DesktopPlatform = "mac" | "windows" | "linux";

export function normalizeDesktopPlatform(platform: NodeJS.Platform): DesktopPlatform {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "linux";
}

export function createMainWindowOptions(
  platform: NodeJS.Platform,
  preloadPath: string,
): BrowserWindowConstructorOptions {
  const mac = platform === "darwin";
  return {
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: "FongMi Desktop",
    backgroundColor: "#0b0d12",
    show: false,
    ...(mac ? { titleBarStyle: "hiddenInset" as const } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--fongmi-platform=${normalizeDesktopPlatform(platform)}`],
    },
  };
}
