import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { protectLocalKeyFile } from "../src/desktop/catvod-profile-encryption.ts";
import {
  APP_ID,
  DATABASE_FILENAME,
  PRODUCT_NAME,
  createDesktopPlatformRuntime,
} from "../src/desktop/platform/platform-runtime.ts";
import {
  createMpvIpcEndpoint,
  isWindowsNamedPipe,
  mpvResourceRelativePath,
  resolveMpvExecutable,
} from "../src/desktop/platform/player-runtime.ts";
import {
  configureDesktopUserDataPath,
  hasExplicitUserDataDirectory,
  migrateLegacyUserData,
} from "../src/desktop/platform/user-data-migration.ts";
import { createMainWindowOptions, normalizeDesktopPlatform } from "../src/desktop/platform/window-options.ts";
import { resolvePackagedExecutable } from "../scripts/lib/packaged-executable.mjs";

test("desktop identity and platform names are no longer macOS-only", () => {
  assert.equal(PRODUCT_NAME, "FongMi Desktop");
  assert.equal(APP_ID, "com.fongmi.desktop");
  assert.equal(DATABASE_FILENAME, "fongmi-desktop.sqlite");
  assert.equal(normalizeDesktopPlatform("darwin"), "mac");
  assert.equal(normalizeDesktopPlatform("win32"), "windows");
  assert.equal(normalizeDesktopPlatform("linux"), "linux");
});

test("main window keeps hiddenInset only on macOS", () => {
  const mac = createMainWindowOptions("darwin", "/app/preload.cjs");
  const windows = createMainWindowOptions("win32", "C:\\app\\preload.cjs");
  const linux = createMainWindowOptions("linux", "/app/preload.cjs");

  assert.equal(mac.titleBarStyle, "hiddenInset");
  assert.equal(mac.autoHideMenuBar, undefined);
  assert.equal(windows.titleBarStyle, undefined);
  assert.equal(windows.autoHideMenuBar, true);
  assert.equal(linux.titleBarStyle, undefined);
  assert.equal(linux.autoHideMenuBar, true);
  assert.ok(mac.webPreferences?.additionalArguments?.includes("--fongmi-platform=mac"));
  assert.ok(windows.webPreferences?.additionalArguments?.includes("--fongmi-platform=windows"));
});

test("platform runtime exposes matching player and UI capabilities", () => {
  const mac = createDesktopPlatformRuntime("darwin");
  const windows = createDesktopPlatformRuntime("win32");
  assert.equal(mac.usesMacTrafficLights, true);
  assert.equal(mac.supportsExternalIina, true);
  assert.equal(windows.usesMacTrafficLights, false);
  assert.equal(windows.supportsExternalIina, false);
  assert.ok(isWindowsNamedPipe(windows.getMpvIpcEndpoint()));
});

test("mpv endpoints and resource paths are platform-specific", async () => {
  assert.equal(createMpvIpcEndpoint({ platform: "win32", pid: 42 }), "\\\\.\\pipe\\fongmi-desktop-mpv-42");
  assert.equal(createMpvIpcEndpoint({ platform: "linux", pid: 42, tempDirectory: "/tmp" }), "/tmp/fongmi-desktop-mpv-42.sock");
  assert.equal(mpvResourceRelativePath("win32", "x64"), path.join("mpv", "windows", "x64", "mpv.exe"));
  assert.equal(mpvResourceRelativePath("darwin", "arm64"), path.join("mpv", "macos", "arm64", "mpv"));

  const directory = await mkdtemp(path.join(os.tmpdir(), "fongmi-mpv-runtime-"));
  try {
    const bundled = path.join(directory, "mpv", "linux", "x64", "mpv");
    await mkdir(path.dirname(bundled), { recursive: true });
    await writeFile(bundled, "binary");
    assert.equal(resolveMpvExecutable({ platform: "linux", arch: "x64", resourcesPath: directory, env: {} }), bundled);
    assert.equal(resolveMpvExecutable({ platform: "win32", resourcesPath: directory, env: { FONGMI_MPV_PATH: "D:\\tools\\mpv.exe" } }), "D:\\tools\\mpv.exe");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy macOS data is copied without overwriting new desktop data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fongmi-user-data-"));
  try {
    const appData = path.join(root, "AppData");
    const legacy = path.join(appData, "FongMi macOS");
    const target = path.join(appData, PRODUCT_NAME);
    await mkdir(path.join(legacy, "catvod-node"), { recursive: true });
    await writeFile(path.join(legacy, "tv-macos.sqlite"), "legacy-db");
    await writeFile(path.join(legacy, "catvod-node", "manifest.json"), "legacy-runtime");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "existing.txt"), "keep");

    const report = await migrateLegacyUserData(target, [legacy]);
    assert.equal(await readFile(path.join(target, DATABASE_FILENAME), "utf8"), "legacy-db");
    assert.equal(await readFile(path.join(target, "catvod-node", "manifest.json"), "utf8"), "legacy-runtime");
    assert.equal(await readFile(path.join(target, "existing.txt"), "utf8"), "keep");
    assert.equal(report.databaseMigrated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user data path configuration respects explicit isolated profiles", () => {
  let name = "";
  let userData = "/old/default";
  const app = {
    getPath: (key: "appData" | "userData") => key === "appData" ? "/home/user/AppData" : userData,
    setPath: (_key: "userData", value: string) => { userData = value; },
    setName: (value: string) => { name = value; },
  };

  assert.equal(hasExplicitUserDataDirectory(["electron", "--user-data-dir=/tmp/test"]), true);
  const isolated = configureDesktopUserDataPath(app, ["electron", "--user-data-dir=/tmp/test"]);
  assert.equal(isolated.userDataPath, "/old/default");
  assert.equal(name, PRODUCT_NAME);

  const normal = configureDesktopUserDataPath(app, ["electron"]);
  assert.equal(normal.userDataPath, path.join("/home/user/AppData", PRODUCT_NAME));
  assert.equal(userData, normal.userDataPath);
  assert.ok(normal.legacyPaths.includes(path.join("/home/user/AppData", "FongMi macOS")));
});

test("Windows local key protection does not pretend chmod is an ACL", () => {
  assert.doesNotThrow(() => protectLocalKeyFile("C:\\missing\\key", "win32"));
});

test("packaged executable resolver covers all desktop platforms", () => {
  const root = "/project";
  assert.equal(resolvePackagedExecutable({ root, platform: "darwin", arch: "x64" }), path.join(root, "release", "mac", "FongMi Desktop.app", "Contents", "MacOS", "FongMi Desktop"));
  assert.equal(resolvePackagedExecutable({ root, platform: "win32", arch: "x64" }), path.join(root, "release", "win-unpacked", "FongMi Desktop.exe"));
  assert.equal(resolvePackagedExecutable({ root, platform: "linux", arch: "x64" }), path.join(root, "release", "linux-unpacked", "fongmi-desktop"));
});
