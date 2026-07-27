import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");
const electronExecutable = (await import("electron")).default;
if (typeof electronExecutable !== "string") throw new Error("未找到 Electron 可执行文件");

const artifactDirectory = path.join(root, "artifacts", "core-hardening-e2e");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-core-hardening-"));
const userDataDirectory = path.join(temporaryRoot, "profile");
const fixtureDirectory = path.join(temporaryRoot, "fixture");
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });
await fs.mkdir(fixtureDirectory, { recursive: true });
await generateMediaFixture(fixtureDirectory);
const fixture = await startFixtureServer(fixtureDirectory);
const vitePort = await freePort();
const viteUrl = `http://127.0.0.1:${vitePort}`;
const vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
  cwd: root,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += String(chunk); });
vite.stderr.on("data", (chunk) => { viteOutput += String(chunk); });
await waitForHttp(viteUrl, 30_000);

const results = [];
const consoleErrors = [];
const pageErrors = [];
const requestFailures = [];
let app;
let page;

function record(id, title, passed, details = "") {
  results.push({ id, title, passed: Boolean(passed), details });
}

async function clickNav(label) {
  await page.locator(".sidebar button").filter({ hasText: label }).first().click();
}

async function selectSetting(label, value) {
  const row = page.locator(".setting-row").filter({ hasText: label }).first();
  await row.locator("select").selectOption(String(value));
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(artifactDirectory, name), fullPage: true });
}

try {
  const rendererUrl = `${viteUrl}/?preview=1&fixture=${encodeURIComponent(fixture.baseUrl)}`;
  app = await electron.launch({
    executablePath: electronExecutable,
    args: [path.join(root, "dist", "main", "main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: {
      ...process.env,
      HOME: temporaryRoot,
      VITE_DEV_SERVER_URL: rendererUrl,
      FONGMI_E2E_DISABLE_CATVOD: "1",
      FONGMI_RENDERER_PREVIEW: "1",
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  page = await app.firstWindow({ timeout: 30_000 });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (failure !== "net::ERR_ABORTED") requestFailures.push(`${request.url()} ${failure}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });

  await clickNav("账号与网盘");
  await page.locator(".accounts-page").waitFor({ state: "visible", timeout: 10_000 });
  const accountCards = page.locator(".pan-account-card");
  await accountCards.first().waitFor({ state: "visible" });
  const initialAccountText = await accountCards.allTextContents();
  record(
    "CORE-E2E-001",
    "六网盘账号页区分已登录、失效、未登录和检查失败",
    await accountCards.count() === 6
      && initialAccountText.some((text) => text.includes("已登录"))
      && initialAccountText.some((text) => text.includes("登录已失效"))
      && initialAccountText.some((text) => text.includes("未登录"))
      && initialAccountText.some((text) => text.includes("状态检查失败")),
    JSON.stringify(initialAccountText),
  );

  const quarkCard = accountCards.filter({ hasText: "夸克网盘" });
  const pan189Card = accountCards.filter({ hasText: "天翼云盘" });
  await quarkCard.getByRole("button", { name: "清除凭据" }).click();
  await quarkCard.locator("em").filter({ hasText: "未登录" }).waitFor({ state: "visible", timeout: 5_000 });
  record(
    "CORE-E2E-002",
    "清除单网盘凭据不影响其他已登录网盘",
    (await quarkCard.textContent())?.includes("未登录") === true
      && (await pan189Card.textContent())?.includes("已登录") === true,
    JSON.stringify({ quark: await quarkCard.textContent(), pan189: await pan189Card.textContent() }),
  );

  const taskIsolation = await page.evaluate(async () => {
    const quark = await window.tvApi.startPanLogin("quark");
    const baidu = await window.tvApi.startPanLogin("baidu");
    await window.tvApi.cancelPanLogin(quark.taskId);
    const baiduResult = await window.tvApi.pollPanLogin("baidu", baidu.taskId);
    return { quarkTask: quark.taskId, baiduTask: baidu.taskId, baiduResult };
  });
  record(
    "CORE-E2E-003",
    "多网盘登录任务取消互不影响",
    taskIsolation.quarkTask !== taskIsolation.baiduTask && taskIsolation.baiduResult.status === "success",
    JSON.stringify(taskIsolation),
  );

  const ucCard = accountCards.filter({ hasText: "UC 网盘" });
  await ucCard.getByRole("button", { name: "扫码 TV Token" }).click();
  await page.locator(".pan-login-layer").waitFor({ state: "visible", timeout: 5_000 });
  await page.locator(".pan-login-layer").waitFor({ state: "detached", timeout: 8_000 });
  await ucCard.locator("em").filter({ hasText: "已登录" }).waitFor({ state: "visible", timeout: 5_000 });
  record(
    "CORE-E2E-004",
    "UC TV Token 登录成功后状态与凭据模式同步",
    (await ucCard.textContent())?.includes("已登录") === true && (await ucCard.textContent())?.includes("TV Token") === true,
    await ucCard.textContent() ?? "",
  );
  await screenshot("01-accounts.png");

  await clickNav("设置");
  await page.locator(".settings-page").waitFor({ state: "visible", timeout: 10_000 });
  await selectSetting("字幕大小", 1.2);
  await selectSetting("字幕时间偏移", 2);
  await selectSetting("字幕背景", 0.7);
  await selectSetting("弹幕透明度", 0.4);
  await selectSetting("弹幕字号", 1.2);
  await selectSetting("弹幕速度", 1.3);
  await selectSetting("同屏弹幕上限", 24);
  await page.locator(".setting-row-input input").fill("广告，剧透");
  await page.locator(".settings-footer .primary-button").click();
  await page.locator(".saved-indicator").waitFor({ state: "visible", timeout: 5_000 });
  const savedPresentation = await page.evaluate(async () => ({
    danmaku: await window.tvApi.getSetting("danmakuSettings", null),
    subtitle: await window.tvApi.getSetting("subtitleSettings", null),
  }));
  record(
    "CORE-E2E-005",
    "字幕弹幕高级设置保存并规范化",
    savedPresentation.danmaku?.opacity === 0.4
      && savedPresentation.danmaku?.maxActive === 24
      && JSON.stringify(savedPresentation.danmaku?.blockedWords) === JSON.stringify(["广告", "剧透"])
      && savedPresentation.subtitle?.fontScale === 1.2
      && savedPresentation.subtitle?.delaySeconds === 2,
    JSON.stringify(savedPresentation),
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 20_000 });
  await clickNav("设置");
  const reloadedBlockedWords = await page.locator(".setting-row-input input").inputValue();
  const reloadedOpacity = await page.locator(".setting-row").filter({ hasText: "弹幕透明度" }).locator("select").inputValue();
  record(
    "CORE-E2E-006",
    "字幕弹幕设置在 Renderer 重载后保持",
    reloadedBlockedWords.includes("广告") && reloadedBlockedWords.includes("剧透") && reloadedOpacity === "0.4",
    JSON.stringify({ reloadedBlockedWords, reloadedOpacity }),
  );

  await clickNav("内容来源");
  await page.locator(".quick-source-page").waitFor({ state: "visible", timeout: 10_000 });
  const panSource = page.locator(".quick-source-card").filter({ hasText: "预览网盘" }).first();
  await panSource.click();
  await page.waitForFunction(() => document.querySelector(".source-picker-trigger-copy strong")?.textContent?.includes("预览网盘"));
  await clickNav("片库");
  await page.locator(".library-page").waitFor({ state: "visible", timeout: 10_000 });
  const rootFolder = page.locator(".library-poster-card").filter({ hasText: "家庭影音" }).first();
  await rootFolder.click();
  await page.locator(".folder-breadcrumb").waitFor({ state: "visible", timeout: 10_000 });
  const familyText = await page.locator(".search-page").textContent();
  record(
    "CORE-E2E-007",
    "网盘目录区分文件夹、视频和字幕",
    familyText?.includes("2026 年") === true
      && familyText.includes("家庭录像 01.mp4")
      && familyText.includes("家庭录像 01.zh.vtt")
      && familyText.includes("字幕文件"),
    familyText?.replace(/\s+/g, " ").slice(0, 900) ?? "",
  );

  await page.getByPlaceholder("搜索当前目录").fill("家庭录像 01");
  const filteredCards = await page.locator(".search-result-card").count();
  await page.getByPlaceholder("搜索当前目录").fill("");
  await page.getByLabel("目录排序").selectOption("type");
  record("CORE-E2E-008", "当前目录搜索与排序不触发全局搜索", filteredCards === 2, JSON.stringify({ filteredCards }));

  const loadMoreFolder = page.locator(".search-load-more button").filter({ hasText: "加载更多目录内容" });
  await loadMoreFolder.click();
  await page.locator(".search-result-card").filter({ hasText: "家庭录像 03.mp4" }).waitFor({ state: "visible", timeout: 5_000 });
  record(
    "CORE-E2E-009",
    "网盘目录分页追加并保留面包屑",
    (await page.locator(".folder-breadcrumb").textContent())?.includes("家庭影音") === true
      && (await page.locator(".search-page").textContent())?.includes("家庭录像 03.mp4") === true,
    await page.locator(".folder-breadcrumb").textContent() ?? "",
  );

  await page.locator(".search-result-card").filter({ hasText: "2026 年" }).getByRole("button", { name: "打开目录" }).click();
  await page.locator(".search-result-card").filter({ hasText: "暑期旅行" }).getByRole("button", { name: "打开目录" }).click();
  const deepBreadcrumb = await page.locator(".folder-breadcrumb").textContent();
  record(
    "CORE-E2E-010",
    "三级网盘目录面包屑完整",
    ["家庭影音", "2026 年", "暑期旅行"].every((part) => deepBreadcrumb?.includes(part)),
    deepBreadcrumb ?? "",
  );

  await page.locator(".search-result-card").filter({ hasText: "连云港旅行.mp4" }).getByRole("button", { name: "打开文件" }).click();
  await page.locator(".detail-page").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: /立即播放/ }).click();
  await page.locator(".player-container").waitFor({ state: "visible", timeout: 15_000 });
  const video = page.locator(".video-stage video");
  await page.waitForFunction(() => {
    const element = document.querySelector(".video-stage video");
    return element instanceof HTMLVideoElement && element.readyState >= 1;
  }, undefined, { timeout: 20_000 });
  await page.locator(".danmaku-overlay").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".danmaku-item").first().waitFor({ state: "visible", timeout: 10_000 });
  const playerState = await page.evaluate(() => {
    const element = document.querySelector(".video-stage video");
    if (!(element instanceof HTMLVideoElement)) return null;
    const overlayText = document.querySelector(".danmaku-overlay")?.textContent ?? "";
    const firstDanmaku = document.querySelector(".danmaku-item");
    const player = document.querySelector(".embedded-player");
    return {
      duration: element.duration,
      trackCount: element.textTracks.length,
      overlayText,
      danmakuOpacity: firstDanmaku instanceof HTMLElement ? firstDanmaku.style.opacity : "",
      subtitleScale: player instanceof HTMLElement ? player.style.getPropertyValue("--subtitle-font-scale") : "",
      subtitleBackground: player instanceof HTMLElement ? player.style.getPropertyValue("--subtitle-background-opacity") : "",
    };
  });
  await video.evaluate((element) => {
    const media = element;
    media.currentTime = Math.min(6, Math.max(1, media.duration - 1));
    void media.play();
  });
  await page.waitForFunction(() => {
    const element = document.querySelector(".video-stage video");
    return element instanceof HTMLVideoElement && element.currentTime >= 4;
  }, undefined, { timeout: 10_000 });
  record(
    "CORE-E2E-011",
    "真实 Fixture 媒体可播放、拖动并加载字幕弹幕高级设置",
    Boolean(playerState)
      && Number(playerState?.duration) > 0
      && Number(playerState?.trackCount) >= 1
      && playerState?.overlayText.includes("正常弹幕") === true
      && !playerState?.overlayText.includes("广告")
      && playerState?.danmakuOpacity === "0.4"
      && playerState?.subtitleScale === "1.2"
      && playerState?.subtitleBackground === "0.7",
    JSON.stringify({ playerState, mediaRequests: fixture.observed }),
  );
  await screenshot("02-player.png");

  record(
    "CORE-E2E-012",
    "真实媒体请求完成并支持 Range",
    fixture.observed.some((entry) => entry.url === "/media.mp4")
      && fixture.observed.some((entry) => entry.range.startsWith("bytes=")),
    JSON.stringify(fixture.observed),
  );

  record(
    "CORE-E2E-013",
    "端到端运行无页面错误和控制台错误",
    consoleErrors.length === 0 && pageErrors.length === 0,
    JSON.stringify({ consoleErrors, pageErrors, requestFailures }),
  );
} catch (error) {
  record("CORE-E2E-FATAL", "端到端脚本完整执行", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
  vite.kill("SIGTERM");
  await fixture.close().catch(() => undefined);
}

const report = {
  generatedAt: new Date().toISOString(),
  results,
  summary: {
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
  },
  consoleErrors,
  pageErrors,
  requestFailures,
  fixtureRequests: fixture.observed,
  viteOutput: viteOutput.slice(-4_000),
};
await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
for (const result of results) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id} ${result.title}${result.details ? ` — ${result.details}` : ""}`);
await fs.rm(temporaryRoot, { recursive: true, force: true });
if (report.summary.failed > 0) process.exitCode = 1;

async function generateMediaFixture(directory) {
  const target = path.join(directory, "media.mp4");
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=0x24508a:s=640x360:r=25:d=12",
    "-f", "lavfi",
    "-i", "sine=frequency=440:duration=12",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    "-movflags", "+faststart",
    target,
  ], { stdio: "ignore" });
  await fs.writeFile(path.join(directory, "subtitle.vtt"), "WEBVTT\n\n00:00:00.200 --> 00:00:04.000\n端到端字幕\n\n00:00:05.000 --> 00:00:09.000\n拖动后字幕\n", "utf8");
  await fs.writeFile(path.join(directory, "danmaku.json"), JSON.stringify({ data: [
    { time: 0.2, text: "广告内容", mode: "scroll", color: "#ff0000" },
    { time: 0.3, text: "正常弹幕", mode: "scroll", color: "#ffffff" },
    { time: 1, text: "顶部弹幕", mode: "top", color: "#00ff00" },
    { time: 5, text: "拖动后弹幕", mode: "bottom", color: "#ffffff" },
  ] }), "utf8");
}

async function startFixtureServer(directory) {
  const observed = [];
  const server = http.createServer(async (request, response) => {
    const url = request.url ?? "/";
    observed.push({ url, method: request.method ?? "GET", range: String(request.headers.range ?? "") });
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("cache-control", "no-store");
    if (url === "/media.mp4") {
      const bytes = await fs.readFile(path.join(directory, "media.mp4"));
      sendRange(request, response, bytes, "video/mp4");
      return;
    }
    if (url === "/subtitle.vtt") {
      const bytes = await fs.readFile(path.join(directory, "subtitle.vtt"));
      response.writeHead(200, { "content-type": "text/vtt; charset=utf-8", "content-length": bytes.length });
      response.end(bytes);
      return;
    }
    if (url === "/danmaku.json") {
      const bytes = await fs.readFile(path.join(directory, "danmaku.json"));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length });
      response.end(bytes);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("媒体 Fixture 端口分配失败");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observed,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sendRange(request, response, bytes, contentType) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ""));
  if (request.method === "HEAD") {
    response.writeHead(200, { "content-type": contentType, "content-length": bytes.length, "accept-ranges": "bytes" });
    response.end();
    return;
  }
  if (!range) {
    response.writeHead(200, { "content-type": contentType, "content-length": bytes.length, "accept-ranges": "bytes" });
    response.end(bytes);
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
  const body = bytes.subarray(start, end + 1);
  response.writeHead(206, {
    "content-type": contentType,
    "content-length": body.length,
    "content-range": `bytes ${start}-${end}/${bytes.length}`,
    "accept-ranges": "bytes",
  });
  response.end(body);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Vite 端口分配失败");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite 启动超时：${url}`);
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
