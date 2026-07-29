import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const files = [
  "native/libmpv-player/package.json",
  "native/libmpv-player/binding.gyp",
  "native/libmpv-player/src/addon.cc",
  "native/libmpv-player/src/libmpv_player.h",
  "native/libmpv-player/src/libmpv_player.cc",
  "native/libmpv-player/src/mpv_dynamic.h",
  "native/libmpv-player/src/mpv_dynamic.cc",
  "native/libmpv-player/src/mpv_render_abi.h",
  "native/libmpv-player/src/platform/native_view.h",
  "native/libmpv-player/src/platform/native_view.cc",
  "native/libmpv-player/src/platform/native_view_darwin.mm",
  "native/libmpv-player/src/platform/native_view_win.cc",
  "native/libmpv-player/src/platform/native_view_linux.cc",
  "resources/native/libmpv-player/README.md",
  "resources/libmpv/README.md",
];

test("native libmpv project layout is present and package-aware", async () => {
  const contents = await Promise.all(files.map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
  assert.equal(contents.length, files.length);

  const packageText = contents[0]!;
  const binding = contents[1]!;
  const addon = contents[2]!;
  const builder = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  const loader = await readFile(new URL("../src/desktop/native-libmpv-addon.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/desktop/renderer/App.vue", import.meta.url), "utf8");

  assert.ok(packageText.includes("@fongmi/native-libmpv-player"));
  assert.ok(binding.includes("fongmi_libmpv_player"));
  assert.ok(binding.includes("native_view_darwin.mm"));
  assert.ok(binding.includes("native_view_win.cc"));
  assert.ok(binding.includes("native_view_linux.cc"));
  for (const marker of ["node_api.h", "createPlayer", "getBuildInfo", "setVolume", "setMuted", "attachView", "resizeView", "detachView", "renderApiAvailable", "renderReady"]) {
    assert.ok(addon.includes(marker), `missing addon marker: ${marker}`);
  }
  for (const marker of ["resources/native", "resources/libmpv", "**/*.node", "**/*.dylib", "**/*.dll", "**/*.so*", "signExts"]) {
    assert.ok(builder.includes(marker), `missing packaging marker: ${marker}`);
  }
  assert.ok(main.includes("preflightNativeLibmpvAddon"));
  assert.ok(loader.includes("nativeLibmpvCandidatePaths"));
  assert.ok(loader.includes("FONGMI_LIBMPV_ADDON"));
  assert.ok(app.includes("libmpv 原生内嵌"));
  assert.ok(loader.includes("linkedLibmpv"));
  assert.ok(loader.includes("renderReady"));
  assert.ok(loader.includes("preflightNativeLibmpvAddon"));
  assert.ok(loader.includes("隔离预检"));
  assert.ok(loader.includes("hasExplicitNativeLibmpvPaths"));
  assert.ok(loader.includes("FONGMI_LIBMPV_LIBRARY"));

  const dynamicLoader = contents[6]!;
  const renderAbi = contents[7]!;
  const macView = contents[10]!;
  const windowsView = contents[11]!;
  const linuxView = contents[12]!;
  const preload = await readFile(new URL("../src/desktop/preload.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../src/desktop/register-ipc.ts", import.meta.url), "utf8");
  const nativeHost = await readFile(new URL("../src/desktop/renderer/components/NativePlayerHost.vue", import.meta.url), "utf8");
  const runtimePreparer = await readFile(new URL("../scripts/prepare-libmpv-runtime.mjs", import.meta.url), "utf8");
  const afterPack = await readFile(new URL("../scripts/after-pack-native-runtime.mjs", import.meta.url), "utf8");
  const packagedE2e = await readFile(new URL("../scripts/playwright-packaged-native-libmpv-e2e.mjs", import.meta.url), "utf8");
  const nativeBuilder = await readFile(new URL("../scripts/build-native-libmpv.mjs", import.meta.url), "utf8");
  const nativePackager = await readFile(new URL("../scripts/package-native-libmpv.mjs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/desktop-cross-platform.yml", import.meta.url), "utf8");
  assert.ok(dynamicLoader.includes("const char* loader_error = dlerror()"));
  assert.ok(dynamicLoader.includes("RTLD_DEEPBIND"));
  assert.ok(dynamicLoader.includes("Chromium's incompatible"));
  assert.ok(dynamicLoader.includes("selected.is_absolute()"));
  assert.ok(dynamicLoader.includes("Never search the process/global loader paths"));
  assert.doesNotMatch(dynamicLoader, /candidates\.emplace_back\("libmpv(?:\.2)?\.dylib"\)/);
  assert.ok(dynamicLoader.includes("Intentionally keep a successfully loaded libmpv resident"));
  for (const marker of ["mpv_render_context_create", "mpv_render_context_update", "mpv_render_context_render", "mpv_render_context_free"]) {
    assert.ok(dynamicLoader.includes(marker), `missing dynamic render symbol: ${marker}`);
  }
  for (const marker of ["MPV_RENDER_PARAM_OPENGL_INIT_PARAMS", "MPV_RENDER_PARAM_OPENGL_FBO", "MPV_RENDER_PARAM_FLIP_Y"]) {
    assert.ok(renderAbi.includes(marker), `missing render ABI marker: ${marker}`);
  }
  for (const marker of ["NSOpenGLView", "AttachNativeViewDarwin", "flushBuffer", "backingScaleFactor"]) {
    assert.ok(macView.includes(marker), `missing macOS native view marker: ${marker}`);
  }
  for (const marker of ["CreateWindowExW", "wglCreateContext", "SwapBuffers", "WindowsRenderThread"]) {
    assert.ok(windowsView.includes(marker), `missing Windows native view marker: ${marker}`);
  }
  for (const marker of ["XCreateWindow", "glXCreateContext", "glXSwapBuffers", "LinuxRenderThread"]) {
    assert.ok(linuxView.includes(marker), `missing Linux native view marker: ${marker}`);
  }
  for (const marker of ["attachNativePlayerView", "resizeNativePlayerView", "detachNativePlayerView"]) {
    assert.ok(preload.includes(marker), `missing preload native view marker: ${marker}`);
  }
  assert.ok(ipc.includes("PLAYER_NATIVE_ATTACH"));
  assert.ok(ipc.includes("getNativeWindowHandle"));
  assert.ok(ipc.includes("BrowserWindow.fromWebContents"));
  assert.ok(nativeHost.includes("ResizeObserver"));
  assert.ok(nativeHost.includes("attachNativeSurface"));
  for (const marker of [
    "prepareWindowsRuntime",
    "inspectWindowsDependencies",
    "prepareLinuxRuntime",
    "inspectLinuxDependencies",
    "FONGMI_LIBMPV_DEPENDENCY_DIRS",
    "ensureCanonicalEntryLibrary",
    "externalSystemDependencies",
    "hashStage",
  ]) {
    assert.ok(runtimePreparer.includes(marker), `missing runtime preparation marker: ${marker}`);
  }
  for (const marker of ["auditWindowsDependencies", "auditLinuxDependencies", "externalSystemDependencies", "after-pack-before-platform-signing", "sanitizeDependencyAudit"]) {
    assert.ok(afterPack.includes(marker), `missing afterPack audit marker: ${marker}`);
  }
  for (const marker of ["install_name_tool", "@loader_path", "runtime-manifest.json", "unresolvedDependencies"]) {
    assert.ok(runtimePreparer.includes(marker), `missing runtime preparation marker: ${marker}`);
  }
  for (const marker of ["afterPackNativeRuntime", "native-runtime-manifest.json", "codesign", "dependencyAudit"]) {
    assert.ok(afterPack.includes(marker), `missing afterPack marker: ${marker}`);
  }
  assert.ok(packagedE2e.includes("FONGMI_ENABLE_NATIVE_LIBMPV"));
  assert.ok(packagedE2e.includes("packagedLaunchArgs"));
  assert.ok(packagedE2e.includes('process.platform === "linux" ? ["--no-sandbox"] : []'));
  assert.ok(packagedE2e.includes("noDevelopmentPath"));
  assert.ok(packagedE2e.includes("manifestPathSanitized"));
  assert.ok(packagedE2e.includes("preparedManifestPathSanitized"));
  assert.ok(workflow.includes("Build native libmpv addon"));
  assert.ok(workflow.includes("libx11-dev"));
  assert.ok(nativeBuilder.includes('shell: process.platform === "win32"'));
  assert.ok(nativePackager.includes('shell: process.platform === "win32"'));
  assert.ok(loader.includes("process.env.FONGMI_LIBMPV_LIBRARY = libraryPath"));
  assert.ok(loader.includes("hasPackagedNativeLibmpvRuntime"));
});

test("native libmpv backend is opt-in and never requires the addon by default", async () => {
  const previousAddon = process.env.FONGMI_LIBMPV_ADDON;
  const previousLibrary = process.env.FONGMI_LIBMPV_LIBRARY;
  const previousEnabled = process.env.FONGMI_ENABLE_NATIVE_LIBMPV;
  delete process.env.FONGMI_LIBMPV_ADDON;
  delete process.env.FONGMI_LIBMPV_LIBRARY;
  delete process.env.FONGMI_ENABLE_NATIVE_LIBMPV;
  try {
    const module = await import("../src/desktop/native-libmpv-addon.ts");
    module.resetNativeLibmpvAddonCacheForTests();
    const availability = module.getNativeLibmpvAvailability();
    assert.equal(availability.available, false);
    assert.match(availability.reason ?? "", /libmpv|应用内高兼容播放暂不可用/);
  } finally {
    if (previousAddon === undefined) delete process.env.FONGMI_LIBMPV_ADDON;
    else process.env.FONGMI_LIBMPV_ADDON = previousAddon;
    if (previousLibrary === undefined) delete process.env.FONGMI_LIBMPV_LIBRARY;
    else process.env.FONGMI_LIBMPV_LIBRARY = previousLibrary;
    if (previousEnabled === undefined) delete process.env.FONGMI_ENABLE_NATIVE_LIBMPV;
    else process.env.FONGMI_ENABLE_NATIVE_LIBMPV = previousEnabled;
  }
});

test("native libmpv rejects missing or non-absolute managed paths before require", async () => {
  const previousAddon = process.env.FONGMI_LIBMPV_ADDON;
  const previousLibrary = process.env.FONGMI_LIBMPV_LIBRARY;
  const previousEnabled = process.env.FONGMI_ENABLE_NATIVE_LIBMPV;
  process.env.FONGMI_ENABLE_NATIVE_LIBMPV = "1";
  process.env.FONGMI_LIBMPV_ADDON = "relative/fongmi_libmpv_player.node";
  process.env.FONGMI_LIBMPV_LIBRARY = "relative/libmpv.dylib";
  try {
    const module = await import("../src/desktop/native-libmpv-addon.ts");
    module.resetNativeLibmpvAddonCacheForTests();
    assert.equal(module.hasExplicitNativeLibmpvPaths(), false);
    const availability = module.getNativeLibmpvAvailability();
    assert.equal(availability.available, false);
    assert.match(availability.reason ?? "", /绝对路径|MPV JSON IPC/);
  } finally {
    if (previousAddon === undefined) delete process.env.FONGMI_LIBMPV_ADDON;
    else process.env.FONGMI_LIBMPV_ADDON = previousAddon;
    if (previousLibrary === undefined) delete process.env.FONGMI_LIBMPV_LIBRARY;
    else process.env.FONGMI_LIBMPV_LIBRARY = previousLibrary;
    if (previousEnabled === undefined) delete process.env.FONGMI_ENABLE_NATIVE_LIBMPV;
    else process.env.FONGMI_ENABLE_NATIVE_LIBMPV = previousEnabled;
  }
});
