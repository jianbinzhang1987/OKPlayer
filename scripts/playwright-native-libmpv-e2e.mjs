import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const artifactDirectory = path.join(root, "artifacts", "native-libmpv-e2e");
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });

const fixtureRoot = path.join(root, "tests", "fixtures", "native-libmpv");
const fakeAddon = path.join(fixtureRoot, "fake-addon.node");
const fakeLibrary = path.join(
  fixtureRoot,
  process.platform === "darwin" ? "fake-libmpv.dylib" : process.platform === "win32" ? "fake-libmpv.dll" : "fake-libmpv.so",
);
const platformName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
const archName = process.arch === "arm64" ? "arm64" : "x64";
const builtAddon = path.join(root, "native", "libmpv-player", "build", "Release", "fongmi_libmpv_player.node");
const distributedAddon = path.join(root, "resources", "native", "libmpv-player", `${platformName}-${archName}`, "fongmi_libmpv_player.node");
const actualAddon = process.env.FONGMI_NATIVE_E2E_ADDON
  || (existsSync(builtAddon) ? builtAddon : distributedAddon);
const actualLibrary = process.env.FONGMI_NATIVE_E2E_LIBRARY || findActualLibrary();
const mediaFixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-native-media-"));
const mediaFixturePath = path.join(mediaFixtureDirectory, "native-test.mp4");
if (existsSync(actualAddon) && actualLibrary && existsSync(actualLibrary)) createNativeMediaFixture(mediaFixturePath);

const scenarios = [
  {
    id: "NLV-011",
    title: "未发现 native 运行时时应用明确标记高兼容播放不可用",
    env: {},
    expectedBackend: "unavailable",
    expectedReason: /未发现|libmpv|MPV JSON IPC/,
  },
  {
    id: "NLV-006",
    title: "隔离探针失败时应用拒绝外置 MPV 窗口兜底",
    env: {
      FONGMI_ENABLE_NATIVE_LIBMPV: "1",
      FONGMI_LIBMPV_ADDON: fakeAddon,
      FONGMI_LIBMPV_LIBRARY: fakeLibrary,
      FONGMI_LIBMPV_PROBE_SCRIPT: path.join(fixtureRoot, "probe-failure.cjs"),
    },
    expectedBackend: "unavailable",
    expectedReason: /模拟 native addon 加载失败/,
  },
  {
    id: "NLV-012",
    title: "隔离探针挂起时应用超时后继续启动并禁用高兼容播放",
    env: {
      FONGMI_ENABLE_NATIVE_LIBMPV: "1",
      FONGMI_LIBMPV_ADDON: fakeAddon,
      FONGMI_LIBMPV_LIBRARY: fakeLibrary,
      FONGMI_LIBMPV_PROBE_SCRIPT: path.join(fixtureRoot, "probe-hang.cjs"),
    },
    expectedBackend: "unavailable",
    expectedReason: /隔离预检超过/,
    launchTimeoutMs: 35_000,
  },
];

if (existsSync(actualAddon) && actualLibrary && existsSync(actualLibrary)) {
  scenarios.push({
    id: "NLV-013",
    title: "实际 addon 与实际 libmpv 隔离探测后应用可启动",
    env: {
      FONGMI_ENABLE_NATIVE_LIBMPV: "1",
      FONGMI_LIBMPV_ADDON: actualAddon,
      FONGMI_LIBMPV_LIBRARY: actualLibrary,
    },
    expectedBackend: process.platform === "darwin" ? "native-libmpv" : "mpv-ipc",
    expectedReason: undefined,
    launchTimeoutMs: 35_000,
    actual: true,
    renderTestUrl: mediaFixturePath,
  });
  scenarios.push({
    id: "NLV-021",
    title: "原生视图运行期失败时明确拒绝外置 MPV 窗口兜底",
    env: {
      FONGMI_ENABLE_NATIVE_LIBMPV: "1",
      FONGMI_LIBMPV_ADDON: actualAddon,
      FONGMI_LIBMPV_LIBRARY: actualLibrary,
      FONGMI_NATIVE_VIEW_FORCE_FAILURE: "1",
    },
    expectedBackend: "native-libmpv",
    expectedReason: undefined,
    launchTimeoutMs: 35_000,
    fallbackRenderTestUrl: mediaFixturePath,
  });
}

const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario));
}

const summary = {
  executedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  actualAddon,
  actualLibrary: actualLibrary || null,
  passed: results.filter((item) => item.passed).length,
  failed: results.filter((item) => !item.passed).length,
  results,
};
await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(summary), "utf8");
await fs.rm(mediaFixtureDirectory, { recursive: true, force: true });
console.log(JSON.stringify(summary, null, 2));
if (summary.failed > 0) process.exitCode = 1;

async function runScenario(scenario) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), `fongmi-native-${scenario.id.toLowerCase()}-`));
  let app;
  const startedAt = Date.now();
  const consoleErrors = [];
  const pageErrors = [];
  try {
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [path.join(root, "dist", "main", "main.js"), `--user-data-dir=${profile}`],
      cwd: root,
      env: scenarioEnvironment(scenario.env),
      timeout: scenario.launchTimeoutMs ?? 25_000,
    });
    const page = await app.firstWindow({ timeout: scenario.launchTimeoutMs ?? 25_000 });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 20_000 });
    const info = await page.evaluate(() => window.tvApi.getInfo());
    const reason = info?.nativeLibmpv?.reason ?? "";
    const backendMatches = scenario.expectedBackend ? info?.playerBackend === scenario.expectedBackend : ["mpv-ipc", "native-libmpv"].includes(info?.playerBackend);
    const reasonMatches = scenario.expectedReason ? scenario.expectedReason.test(reason) : true;
    const renderTest = scenario.renderTestUrl && info?.playerBackend === "native-libmpv"
      ? await runNativeRenderTest(page, scenario.renderTestUrl)
      : undefined;
    const fallbackRenderTest = scenario.fallbackRenderTestUrl && info?.playerBackend === "native-libmpv"
      ? await runNativeFallbackTest(page, scenario.fallbackRenderTestUrl)
      : undefined;
    await page.screenshot({ path: path.join(artifactDirectory, `${scenario.id}.png`), fullPage: true });
    if (renderTest || fallbackRenderTest) {
      await page.evaluate(async () => {
        await window.tvApi.detachNativePlayerView?.();
        await window.tvApi.stop?.();
        document.querySelector("#native-libmpv-e2e-surface")?.remove();
      });
    }
    return {
      id: scenario.id,
      title: scenario.title,
      passed: backendMatches
        && reasonMatches
        && (renderTest?.passed ?? true)
        && (fallbackRenderTest?.passed ?? true)
        && pageErrors.length === 0,
      elapsedMs: Date.now() - startedAt,
      backend: info?.playerBackend,
      nativeAvailability: info?.nativeLibmpv,
      consoleErrors,
      pageErrors,
      actual: scenario.actual === true,
      renderTest,
      fallbackRenderTest,
    };
  } catch (error) {
    return {
      id: scenario.id,
      title: scenario.title,
      passed: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      consoleErrors,
      pageErrors,
      actual: scenario.actual === true,
    };
  } finally {
    await app?.close().catch(() => undefined);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runNativeRenderTest(page, mediaPath) {
  return page.evaluate(async (input) => {
    const surface = document.createElement("div");
    surface.id = "native-libmpv-e2e-surface";
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
    const rect = {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    const states = [];
    const removeState = window.tvApi.onPlayerState?.((state) => states.push(state));
    try {
      const attach = await window.tvApi.attachNativePlayerView(rect);
      const open = await window.tvApi.openPlayer(input);
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await window.tvApi.seek?.(1);
      await window.tvApi.pause?.();
      await window.tvApi.play?.();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return {
        passed: attach?.ok === true && attach?.backend === "native-libmpv" && open?.backend === "native-libmpv",
        attach,
        open,
        stateCount: states.length,
        lastState: states.at(-1),
      };
    } finally {
      removeState?.();
    }
  }, mediaPath);
}

async function runNativeFallbackTest(page, mediaPath) {
  return page.evaluate(async (input) => {
    const surface = document.createElement("div");
    surface.id = "native-libmpv-e2e-surface";
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
    const rect = {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    const states = [];
    const removeState = window.tvApi.onPlayerState?.((state) => states.push(state));
    try {
      const attach = await window.tvApi.attachNativePlayerView(rect);
      const open = await window.tvApi.openPlayer(input);
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const infoAfterFallback = await window.tvApi.getInfo();
      return {
        passed: attach?.ok === false
          && attach?.backend === "native-libmpv"
          && attach?.fallback !== true
          && String(attach?.message ?? "").includes("已禁用 MPV IPC 外置窗口兜底")
          && open?.backend === "native-libmpv"
          && infoAfterFallback?.playerBackend === "native-libmpv",
        attach,
        open,
        infoAfterFallback,
        stateCount: states.length,
        lastState: states.at(-1),
      };
    } finally {
      removeState?.();
    }
  }, mediaPath);
}

function createNativeMediaFixture(outputPath) {
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=5",
    "-f", "lavfi", "-i", "sine=frequency=523:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-movflags", "+faststart", "-shortest", "-y", outputPath,
  ]);
}

function scenarioEnvironment(overrides) {
  const result = { ...process.env };
  for (const key of [
    "FONGMI_ENABLE_NATIVE_LIBMPV",
    "FONGMI_ENABLE_NATIVE_LIBMPV_AUTO_DISCOVERY",
    "FONGMI_LIBMPV_ADDON",
    "FONGMI_LIBMPV_LIBRARY",
    "FONGMI_LIBMPV_PROBE_SCRIPT",
    "FONGMI_NATIVE_VIEW_FORCE_FAILURE",
  ]) delete result[key];
  Object.assign(result, overrides, { FONGMI_E2E_DISABLE_CATVOD: "1" });
  return result;
}

function findActualLibrary() {
  const candidates = process.platform === "darwin"
    ? [
      path.join(root, "resources", "libmpv", "darwin", archName, "libmpv.2.dylib"),
      "/usr/local/lib/libmpv.2.dylib",
      "/Applications/IINA.app/Contents/Frameworks/libmpv.2.dylib",
    ]
    : process.platform === "win32"
      ? [path.join(root, "resources", "libmpv", "win32", archName, "mpv-2.dll")]
      : [path.join(root, "resources", "libmpv", "linux", archName, "libmpv.so.2"), "/usr/lib/x86_64-linux-gnu/libmpv.so.2"];
  return candidates.find((candidate) => existsSync(candidate));
}

function renderMarkdown(report) {
  const rows = report.results.map((item) => `| ${item.id} | ${item.passed ? "通过" : "失败"} | ${item.backend ?? "-"} | ${item.elapsedMs}ms | ${(item.nativeAvailability?.reason ?? item.error ?? "").replace(/\|/g, "\\|")} |`);
  return `# libmpv 原生内嵌端到端测试报告\n\n- 时间：${report.executedAt}\n- 平台：${report.platform}/${report.arch}\n- 通过：${report.passed}\n- 失败：${report.failed}\n- 实际 addon：${report.actualAddon}\n- 实际 libmpv：${report.actualLibrary ?? "未发现"}\n\n| 用例 | 结果 | 最终后端 | 耗时 | 说明 |\n|---|---|---|---:|---|\n${rows.join("\n")}\n`;
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
