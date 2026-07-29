import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  getNativeLibmpvAvailability,
  hasExplicitNativeLibmpvPaths,
  hasPackagedNativeLibmpvRuntime,
  isNativeLibmpvAutoDiscoveryEnabled,
  isNativeLibmpvExplicitlyEnabled,
  platformResourceName,
  preflightNativeLibmpvAddon,
  resetNativeLibmpvAddonCacheForTests,
  resolveNativeLibmpvRuntimePaths,
} from "../src/desktop/native-libmpv-addon.ts";

const fixtureRoot = fileURLToPath(new URL("./fixtures/native-libmpv/", import.meta.url));
const addonPath = path.join(fixtureRoot, "fake-addon.node");
const libraryPath = path.join(
  fixtureRoot,
  process.platform === "darwin" ? "fake-libmpv.dylib" : process.platform === "win32" ? "fake-libmpv.dll" : "fake-libmpv.so",
);

const managedKeys = [
  "FONGMI_ENABLE_NATIVE_LIBMPV",
  "FONGMI_ENABLE_NATIVE_LIBMPV_AUTO_DISCOVERY",
  "FONGMI_LIBMPV_ADDON",
  "FONGMI_LIBMPV_LIBRARY",
  "FONGMI_LIBMPV_PROBE_SCRIPT",
  "FONGMI_LIBMPV_RESOURCE_ROOT",
] as const;

async function withEnvironment(values: Partial<Record<(typeof managedKeys)[number], string>>, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();
  for (const key of managedKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, values);
  resetNativeLibmpvAddonCacheForTests();
  try {
    await run();
  } finally {
    resetNativeLibmpvAddonCacheForTests();
    for (const key of managedKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("native libmpv remains disabled by default", async () => {
  await withEnvironment({}, () => {
    const availability = getNativeLibmpvAvailability();
    assert.equal(availability.available, false);
    assert.match(availability.reason ?? "", /libmpv|应用内高兼容播放暂不可用/);
  });
});

test("native libmpv requires existing absolute addon and library paths", async () => {
  await withEnvironment({
    FONGMI_ENABLE_NATIVE_LIBMPV: "1",
    FONGMI_LIBMPV_ADDON: "relative-addon.node",
    FONGMI_LIBMPV_LIBRARY: "relative-libmpv.dylib",
  }, () => {
    assert.equal(hasExplicitNativeLibmpvPaths(), false);
  });
});

test("packaged managed runtime auto-enables native discovery without environment enable flags", async () => {
  const resourceRoot = await mkdtemp(path.join(os.tmpdir(), "fongmi-libmpv-packaged-"));
  const platformName = platformResourceName();
  const managedAddon = path.join(resourceRoot, "native", "libmpv-player", platformName, "fongmi_libmpv_player.node");
  const managedLibrary = path.join(
    resourceRoot,
    "libmpv",
    platformName,
    process.platform === "darwin" ? "libmpv.2.dylib" : process.platform === "win32" ? "mpv-2.dll" : "libmpv.so.2",
  );
  await mkdir(path.dirname(managedAddon), { recursive: true });
  await mkdir(path.dirname(managedLibrary), { recursive: true });
  await copyFile(addonPath, managedAddon);
  await copyFile(libraryPath, managedLibrary);
  await writeFile(path.join(resourceRoot, "native-runtime-manifest.json"), "{}\n", "utf8");
  try {
    await withEnvironment({ FONGMI_LIBMPV_RESOURCE_ROOT: resourceRoot }, () => {
      assert.equal(hasPackagedNativeLibmpvRuntime(), true);
      assert.equal(isNativeLibmpvExplicitlyEnabled(), true);
      assert.equal(isNativeLibmpvAutoDiscoveryEnabled(), true);
      assert.equal(resolveNativeLibmpvRuntimePaths()?.source, "managed");
    });
  } finally {
    await rm(resourceRoot, { recursive: true, force: true });
  }
});

test("managed resource auto-discovery pairs addon and libmpv from one resource root", async () => {
  const resourceRoot = await mkdtemp(path.join(os.tmpdir(), "fongmi-libmpv-managed-"));
  const platformName = platformResourceName();
  const managedAddon = path.join(resourceRoot, "native", "libmpv-player", platformName, "fongmi_libmpv_player.node");
  const managedLibrary = path.join(
    resourceRoot,
    "libmpv",
    platformName,
    process.platform === "darwin" ? "libmpv.2.dylib" : process.platform === "win32" ? "mpv-2.dll" : "libmpv.so.2",
  );
  await mkdir(path.dirname(managedAddon), { recursive: true });
  await mkdir(path.dirname(managedLibrary), { recursive: true });
  await copyFile(addonPath, managedAddon);
  await copyFile(libraryPath, managedLibrary);
  try {
    await withEnvironment({
      FONGMI_ENABLE_NATIVE_LIBMPV: "1",
      FONGMI_ENABLE_NATIVE_LIBMPV_AUTO_DISCOVERY: "1",
      FONGMI_LIBMPV_RESOURCE_ROOT: resourceRoot,
      FONGMI_LIBMPV_PROBE_SCRIPT: path.join(fixtureRoot, "probe-success.cjs"),
    }, async () => {
      const paths = resolveNativeLibmpvRuntimePaths();
      assert.deepEqual(paths, { addonPath: managedAddon, libraryPath: managedLibrary, source: "managed" });
      const availability = await preflightNativeLibmpvAddon(2_000);
      assert.equal(availability.available, true);
      assert.equal(availability.addonPath, managedAddon);
      assert.equal(availability.libraryPath, managedLibrary);
    });
  } finally {
    await rm(resourceRoot, { recursive: true, force: true });
  }
});

test("isolated preflight accepts a successful probe result", async () => {
  await withEnvironment({
    FONGMI_ENABLE_NATIVE_LIBMPV: "1",
    FONGMI_LIBMPV_ADDON: addonPath,
    FONGMI_LIBMPV_LIBRARY: libraryPath,
    FONGMI_LIBMPV_PROBE_SCRIPT: path.join(fixtureRoot, "probe-success.cjs"),
  }, async () => {
    const availability = await preflightNativeLibmpvAddon(2_000);
    assert.equal(availability.available, true);
    assert.equal(availability.addonPath, addonPath);
    assert.equal(availability.buildInfo?.linkedLibmpv, true);
    assert.equal(availability.buildInfo?.renderReady, true);
  });
});

test("isolated preflight returns a controlled failure", async () => {
  await withEnvironment({
    FONGMI_ENABLE_NATIVE_LIBMPV: "1",
    FONGMI_LIBMPV_ADDON: addonPath,
    FONGMI_LIBMPV_LIBRARY: libraryPath,
    FONGMI_LIBMPV_PROBE_SCRIPT: path.join(fixtureRoot, "probe-failure.cjs"),
  }, async () => {
    const availability = await preflightNativeLibmpvAddon(2_000);
    assert.equal(availability.available, false);
    assert.match(availability.reason ?? "", /模拟 native addon 加载失败/);
  });
});

test("isolated preflight times out without blocking the caller", async () => {
  await withEnvironment({
    FONGMI_ENABLE_NATIVE_LIBMPV: "1",
    FONGMI_LIBMPV_ADDON: addonPath,
    FONGMI_LIBMPV_LIBRARY: libraryPath,
    FONGMI_LIBMPV_PROBE_SCRIPT: path.join(fixtureRoot, "probe-hang.cjs"),
  }, async () => {
    const startedAt = Date.now();
    const availability = await preflightNativeLibmpvAddon(300);
    const elapsed = Date.now() - startedAt;
    assert.equal(availability.available, false);
    assert.match(availability.reason ?? "", /隔离预检超过 300ms/);
    assert.ok(elapsed < 2_000, `preflight timeout took ${elapsed}ms`);
  });
});
