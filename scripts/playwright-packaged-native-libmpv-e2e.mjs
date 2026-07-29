import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root });
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const artifactDirectory = path.join(root, "artifacts", "packaged-native-libmpv-e2e");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-packaged-native-profile-"));
const mediaDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-packaged-native-media-"));
const mediaPath = path.join(mediaDirectory, "packaged-native.mp4");
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });
createMediaFixture(mediaPath);

const resourcesDirectory = packagedResourcesDirectory(executablePath);
const runtimeManifestPath = path.join(resourcesDirectory, "native-runtime-manifest.json");
const runtimeManifestText = await fs.readFile(runtimeManifestPath, "utf8");
const runtimeManifest = JSON.parse(runtimeManifestText);
const platformName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
const archName = process.arch === "arm64" ? "arm64" : "x64";
const preparedRuntimeManifestPath = path.join(resourcesDirectory, "libmpv", `${platformName}-${archName}`, "runtime-manifest.json");
const preparedRuntimeManifestText = await fs.readFile(preparedRuntimeManifestPath, "utf8");
const packagedLibrary = path.join(
  resourcesDirectory,
  "libmpv",
  `${platformName}-${archName}`,
  process.platform === "darwin" ? "libmpv.2.dylib" : process.platform === "win32" ? "mpv-2.dll" : "libmpv.so.2",
);
const packagedAddon = path.join(resourcesDirectory, "native", "libmpv-player", `${platformName}-${archName}`, "fongmi_libmpv_player.node");

let app;
const consoleErrors = [];
const pageErrors = [];
let result;
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`],
    cwd: root,
    env: packagedEnvironment(),
    timeout: 40_000,
  });
  const page = await app.firstWindow({ timeout: 40_000 });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 25_000 });
  const info = await page.evaluate(() => window.tvApi.getInfo());
  const render = await runRenderTest(page, mediaPath);
  await page.screenshot({ path: path.join(artifactDirectory, "packaged-native-render.png"), fullPage: true });
  await page.evaluate(async () => {
    await window.tvApi.detachNativePlayerView?.();
    await window.tvApi.stop?.();
    await window.tvApi.setSetting("nativeLibmpvEnabled", false);
    document.querySelector("#packaged-native-surface")?.remove();
  });
  await app.close();
  app = undefined;

  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`],
    cwd: root,
    env: packagedEnvironment(),
    timeout: 40_000,
  });
  const fallbackPage = await app.firstWindow({ timeout: 40_000 });
  await fallbackPage.waitForLoadState("domcontentloaded");
  await fallbackPage.locator(".app-shell").waitFor({ state: "visible", timeout: 25_000 });
  const fallbackInfo = await fallbackPage.evaluate(() => window.tvApi.getInfo());
  await fallbackPage.screenshot({ path: path.join(artifactDirectory, "packaged-native-disabled-after-restart.png"), fullPage: true });

  const dependencyOutput = inspectPackagedLibraryDependencies(packagedLibrary);
  const noDevelopmentPath = !containsDevelopmentPath(dependencyOutput)
    && !containsDevelopmentPath(runtimeManifestText)
    && !containsDevelopmentPath(preparedRuntimeManifestText);
  const libraryInsidePackage = info?.nativeLibmpv?.buildInfo?.libmpvPath === packagedLibrary;
  const manifestFiles = Array.isArray(runtimeManifest.files) ? runtimeManifest.files.length : 0;
  const runtimeNoticePath = path.join(resourcesDirectory, "libmpv", `${platformName}-${archName}`, "NATIVE_RUNTIME_NOTICES.md");
  const runtimeNoticePresent = existsSync(runtimeNoticePath);
  const licensingPresent = runtimeManifest.licensing?.libmpv?.bundled === true;
  const signingValid = process.platform === "darwin"
    ? runtimeManifest.signing?.signedFiles === manifestFiles
    : ["electron-builder", "not-applicable"].includes(runtimeManifest.signing?.mode);
  const manifestValid = manifestFiles >= 2
    && runtimeManifest.dependencyAudit?.unresolved?.length === 0
    && signingValid;

  result = {
    testedAt: new Date().toISOString(),
    executablePath,
    resourcesDirectory,
    packagedAddon,
    packagedLibrary,
    backend: info?.playerBackend,
    nativeAvailability: info?.nativeLibmpv,
    render,
    restartFallback: {
      backend: fallbackInfo?.playerBackend,
      preferenceEnabled: fallbackInfo?.nativeLibmpvPreferenceEnabled,
      nativeAvailability: fallbackInfo?.nativeLibmpv,
    },
    runtimeManifest: {
      files: manifestFiles,
      dependencyAudit: runtimeManifest.dependencyAudit,
      signing: runtimeManifest.signing,
      licensing: runtimeManifest.licensing,
      runtimeNoticePath,
      runtimeNoticePresent,
      manifestPathSanitized: !containsDevelopmentPath(runtimeManifestText),
      preparedManifestPathSanitized: !containsDevelopmentPath(preparedRuntimeManifestText),
    },
    noDevelopmentPath,
    libraryInsidePackage,
    consoleErrors,
    pageErrors,
  };
  result.passed = info?.playerBackend === "native-libmpv"
    && info?.nativeLibmpv?.available === true
    && libraryInsidePackage
    && noDevelopmentPath
    && manifestValid
    && licensingPresent
    && runtimeNoticePresent
    && render.passed
    && fallbackInfo?.playerBackend === "mpv-ipc"
    && fallbackInfo?.nativeLibmpvPreferenceEnabled === false
    && fallbackInfo?.nativeLibmpv?.available === false
    && consoleErrors.length === 0
    && pageErrors.length === 0;
} catch (error) {
  result = {
    testedAt: new Date().toISOString(),
    executablePath,
    passed: false,
    error: error instanceof Error ? error.message : String(error),
    consoleErrors,
    pageErrors,
  };
} finally {
  await app?.close().catch(() => undefined);
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(mediaDirectory, { recursive: true, force: true });
}

await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(result), "utf8");
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;

async function runRenderTest(page, input) {
  return page.evaluate(async (media) => {
    const surface = document.createElement("div");
    surface.id = "packaged-native-surface";
    Object.assign(surface.style, {
      position: "fixed",
      left: "120px",
      top: "100px",
      width: "640px",
      height: "360px",
      background: "#000",
      zIndex: "9999",
    });
    document.body.append(surface);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bounds = surface.getBoundingClientRect();
    const rect = { x: Math.round(bounds.left), y: Math.round(bounds.top), width: Math.round(bounds.width), height: Math.round(bounds.height) };
    const states = [];
    const removeState = window.tvApi.onPlayerState?.((state) => states.push(state));
    try {
      const attach = await window.tvApi.attachNativePlayerView(rect);
      const open = await window.tvApi.openPlayer(media);
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await window.tvApi.seek?.(1);
      await window.tvApi.pause?.();
      await window.tvApi.play?.();
      await new Promise((resolve) => setTimeout(resolve, 800));
      const lastState = states.at(-1);
      return {
        passed: attach?.ok === true
          && attach?.backend === "native-libmpv"
          && open?.backend === "native-libmpv"
          && Number(lastState?.duration) >= 4.9
          && Number(lastState?.position) > 1,
        attach,
        open,
        stateCount: states.length,
        lastState,
      };
    } finally {
      removeState?.();
    }
  }, input);
}

function containsDevelopmentPath(value) {
  return /(?:\/Users\/|\/home\/[^/]+\/|\/usr\/local\/|\/opt\/homebrew\/|\/opt\/libmpv\/|[A-Za-z]:\\Users\\)/i.test(String(value || ""));
}

function packagedEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "FONGMI_ENABLE_NATIVE_LIBMPV",
    "FONGMI_ENABLE_NATIVE_LIBMPV_AUTO_DISCOVERY",
    "FONGMI_LIBMPV_ADDON",
    "FONGMI_LIBMPV_LIBRARY",
    "FONGMI_LIBMPV_RESOURCE_ROOT",
    "FONGMI_LIBMPV_PROBE_SCRIPT",
  ]) delete env[key];
  return { ...env, FONGMI_E2E_DISABLE_CATVOD: "1" };
}

function packagedResourcesDirectory(executable) {
  if (process.platform === "darwin") return path.resolve(executable, "..", "..", "Resources");
  return path.resolve(executable, "..", "resources");
}

function inspectPackagedLibraryDependencies(library) {
  if (process.platform === "darwin") {
    return execFileSync("otool", ["-L", library], { encoding: "utf8" })
      .split("\n")
      .slice(1)
      .join("\n");
  }
  if (process.platform === "linux") {
    return execFileSync("ldd", [library], {
      encoding: "utf8",
      env: { ...process.env, LD_LIBRARY_PATH: path.dirname(library) },
    });
  }
  return "Windows dependencies are enforced by native-runtime-manifest.json";
}

function createMediaFixture(outputPath) {
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=5",
    "-f", "lavfi", "-i", "sine=frequency=659:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-movflags", "+faststart", "-shortest", "-y", outputPath,
  ]);
}

function renderMarkdown(report) {
  return `# Packaged native libmpv E2E\n\n- 时间：${report.testedAt}\n- 结果：${report.passed ? "通过" : "失败"}\n- 后端：${report.backend ?? "-"}\n- 动态库：${report.packagedLibrary ?? "-"}\n- 文件数：${report.runtimeManifest?.files ?? 0}\n- 运行时许可证声明：${report.runtimeManifest?.licensing ? "已包含" : "缺失"}\n- 运行时 Notice：${report.runtimeManifest?.runtimeNoticePresent ?? false}\n- 无开发机绝对依赖：${report.noDevelopmentPath ?? false}\n- 错误：${report.error ?? "无"}\n`;
}

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE_PATH,
    "playwright",
    path.join(os.homedir(), "Desktop/code/laifu/人力助手/绩效相关/code/PerformanceWorkbench/node_modules/playwright/index.js"),
    path.join(os.homedir(), "Desktop/code/github/eigent-0.0.80/node_modules/playwright/index.js"),
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`未找到可用的 Playwright。\n${failures.join("\n")}`);
}
