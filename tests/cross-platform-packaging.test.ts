import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packagePath = new URL("../package.json", import.meta.url);
const builderPath = new URL("../electron-builder.yml", import.meta.url);
const repairPath = new URL("../scripts/repair-electron.mjs", import.meta.url);
const assetPath = new URL("../scripts/generate-release-assets.mjs", import.meta.url);
const mainPath = new URL("../src/desktop/main.ts", import.meta.url);
const mpvReadmePath = new URL("../resources/mpv/README.md", import.meta.url);
const workflowPath = new URL("../.github/workflows/desktop-cross-platform.yml", import.meta.url);

test("desktop packaging exposes native macOS Windows and Linux entry points", async () => {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    name?: string;
    productName?: string;
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.name, "fongmi-desktop");
  assert.equal(packageJson.productName, "FongMi Desktop");
  for (const script of ["package:mac", "package:win", "package:linux", "package:mac:dir", "package:win:dir", "package:linux:dir"]) {
    assert.equal(typeof packageJson.scripts?.[script], "string", `missing packaging script ${script}`);
  }
});

test("electron-builder contains native targets and preserves user data on Windows uninstall", async () => {
  const builder = await readFile(builderPath, "utf8");
  assert.match(builder, /appId:\s*com\.fongmi\.desktop/);
  assert.match(builder, /productName:\s*FongMi Desktop/);
  assert.match(builder, /win:[\s\S]*?target:[\s\S]*?nsis[\s\S]*?portable/);
  assert.match(builder, /linux:[\s\S]*?target:[\s\S]*?AppImage[\s\S]*?deb/);
  assert.match(builder, /deleteAppDataOnUninstall:\s*false/);
  assert.match(builder, /extraResources:[\s\S]*?resources\/mpv/);
});

test("Electron repair and asset scripts no longer assume macOS on every host", async () => {
  const [repair, assets] = await Promise.all([
    readFile(repairPath, "utf8"),
    readFile(assetPath, "utf8"),
  ]);
  assert.match(repair, /electron-v\$\{version\}-\$\{platform\}-\$\{arch\}\.zip/);
  assert.match(repair, /targetPlatform === "win32"/);
  assert.match(repair, /relativeExecutable:\s*"electron\.exe"/);
  assert.match(repair, /relativeExecutable:\s*"electron"/);
  assert.match(repair, /@electron-internal\/extract-zip/);
  assert.doesNotMatch(repair, /\/usr\/bin\/ditto/);
  assert.match(assets, /process\.platform !== "darwin"/);
  assert.match(assets, /reuse-prebuilt-assets/);
});

test("main process uses the cross-platform runtime, Electron networking and desktop database", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /createDesktopPlatformRuntime/);
  assert.match(main, /configureDesktopUserDataPath/);
  assert.match(main, /migrateLegacyUserData/);
  assert.match(main, /setConfigFetch\(\(input, init\) => net\.fetch/);
  assert.match(main, /path\.join\(userData, DATABASE_FILENAME\)/);
  assert.match(main, /platformRuntime\.getMpvExecutable\(\)/);
  assert.match(main, /platformRuntime\.getMpvIpcEndpoint\(\)/);
});

test("native CI matrix builds unpacked applications on all target operating systems", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  for (const marker of ["macos-14", "windows-2025", "ubuntu-24.04", "package:mac:dir", "package:win:dir", "package:linux:dir"]) {
    assert.ok(workflow.includes(marker), `missing native CI marker ${marker}`);
  }
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test("bundled mpv layout documents all initially supported desktop targets", async () => {
  const readme = await readFile(mpvReadmePath, "utf8");
  for (const marker of ["macos/", "windows/", "linux/", "mpv.exe", "FONGMI_MPV_PATH"]) {
    assert.ok(readme.includes(marker), `missing mpv runtime marker ${marker}`);
  }
});
