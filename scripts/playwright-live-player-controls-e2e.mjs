import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const artifactDirectory = path.join(root, "artifacts", "live-player-controls-e2e");
const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-live-controls-profile-"));
const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-live-controls-fixture-"));
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });

const fixture = await startFixtureServer(fixtureDirectory);
const addonCandidates = [
  path.join(root, "native", "libmpv-player", "build", "Release", "fongmi_libmpv_player.node"),
  path.join(root, "resources", "native", "libmpv-player", `darwin-${process.arch}`, "fongmi_libmpv_player.node"),
];
const addonPath = (await Promise.all(addonCandidates.map(async (candidate) => await exists(candidate) ? candidate : ""))).find(Boolean) ?? addonCandidates[0];
const libraryPath = "/usr/local/lib/libmpv.2.dylib";
const nativeAvailable = await exists(addonPath) && await exists(libraryPath);
const results = [];
const pageErrors = [];
const consoleErrors = [];
let app;
let page;

function addResult(id, title, passed, details = "") {
  results.push({ id, title, passed, details });
}

async function waitForAppFullscreen(expected, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await app.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows()[0]?.isFullScreen()));
    if (current === expected) return;
    await page.waitForTimeout(120);
  }
  throw new Error(`等待窗口${expected ? "进入" : "退出"}全屏超时`);
}

async function closeElectronApp() {
  if (!app) return;
  const closed = await Promise.race([
    app.close().then(() => true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 8_000)),
  ]);
  if (!closed) app.process()?.kill("SIGKILL");
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(artifactDirectory, name), fullPage: true });
}

try {
  app = await electron.launch({
    executablePath: electronExecutable,
    args: [path.join(root, "dist", "main", "main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    timeout: 35_000,
    env: {
      ...process.env,
      FONGMI_E2E_DISABLE_CATVOD: "1",
      FONGMI_ENABLE_NATIVE_LIBMPV: nativeAvailable ? "1" : "0",
      ...(nativeAvailable ? {
        FONGMI_LIBMPV_ADDON: addonPath,
        FONGMI_LIBMPV_LIBRARY: libraryPath,
      } : {}),
    },
  });

  page = await app.firstWindow({ timeout: 35_000 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 25_000 });

  await page.evaluate(({ url, name }) => window.tvApi.loadLiveConfig(url, name), {
    url: fixture.configUrl,
    name: "直播播放器控件 E2E",
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 25_000 });
  const liveNav = page.locator(".sidebar button").filter({ hasText: "直播" }).first();
  await liveNav.click();
  await page.locator(".live-page").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".live-channel-card").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector(".live-channel-card")?.textContent?.includes("正在播"), undefined, { timeout: 20_000 });

  const channelCards = page.locator(".live-channel-card");
  const initialCount = await channelCards.count();
  const firstCard = channelCards.filter({ hasText: "新闻一台" }).first();
  const firstLineSelect = firstCard.locator('select[aria-label="选择直播线路"]');
  addResult("LIVE-001", "直播页加载频道、当前节目与多线路入口", initialCount === 2 && await firstCard.getByText("正在播").isVisible() && await firstLineSelect.isVisible(), `频道数=${initialCount}`);
  await screenshot("01-live-page.png");

  await firstCard.locator(".live-channel-main").click();
  await page.locator(".native-player-host").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector(".native-player-topbar em")?.textContent?.includes("播放中"), undefined, { timeout: 20_000 });
  const nativeControls = page.locator(".native-player-controls");
  const liveShell = await page.evaluate(() => ({
    title: document.querySelector(".native-player-title strong")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    small: document.querySelector(".native-player-title small")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    controls: document.querySelector(".native-player-controls")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    hasLineSelect: Boolean(document.querySelector(".native-live-line-select")),
    selectedLine: document.querySelector(".native-live-line-select option:checked")?.textContent?.trim() ?? "",
    hasGuide: [...document.querySelectorAll(".native-player-controls button")].some((button) => button.textContent?.includes("节目单")),
    hasFullscreen: [...document.querySelectorAll(".native-player-controls button")].some((button) => button.textContent?.includes("全屏")),
    hasMute: [...document.querySelectorAll(".native-player-controls button")].some((button) => /音量|静音/.test(button.textContent ?? "")),
    hasVolume: Boolean(document.querySelector(".native-volume")),
    hasSpeed: Boolean(document.querySelector(".native-speed")),
    hasEpisodes: Boolean(document.querySelector(".native-episode-drawer")),
  }));
  addResult(
    "LIVE-002",
    "播放器展示直播专用控件并隐藏点播控件",
    liveShell.title.includes("新闻一台")
      && liveShell.title.includes("当前新闻")
      && liveShell.small.includes("LIVE")
      && liveShell.controls.includes("上个频道")
      && liveShell.controls.includes("下个频道")
      && liveShell.controls.includes("刷新直播")
      && liveShell.controls.includes("回看 5 分")
      && liveShell.hasLineSelect
      && !liveShell.selectedLine.includes("待检测")
      && liveShell.hasGuide
      && liveShell.hasFullscreen
      && liveShell.hasMute
      && liveShell.hasVolume
      && !liveShell.hasSpeed
      && !liveShell.hasEpisodes,
    JSON.stringify(liveShell),
  );
  await screenshot("02-live-player-controls.png");

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1080, 680);
  });
  await page.waitForTimeout(350);
  const compactLayout = await page.evaluate(() => {
    const controls = document.querySelector(".native-player-controls");
    const visibleItems = [...document.querySelectorAll(".native-player-controls > *")].filter((item) => {
      const style = getComputedStyle(item);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    const items = visibleItems.map((item) => {
      const rect = item.getBoundingClientRect();
      return {
        text: item.textContent?.replace(/\s+/g, " ").trim() || item.getAttribute("aria-label") || item.className,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        visible: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      controlsHeight: Math.round(controls?.getBoundingClientRect().height ?? 0),
      rowCount: new Set(items.map((item) => item.top)).size,
      hidden: items.filter((item) => !item.visible),
      itemCount: items.length,
    };
  });
  addResult("LIVE-003", "最小窗口下所有直播控件均在可视区域", compactLayout.itemCount >= 10 && compactLayout.hidden.length === 0, JSON.stringify(compactLayout));
  await screenshot("03-compact-live-controls.png");

  const pauseButton = nativeControls.getByRole("button", { name: /暂停/ }).first();
  await pauseButton.click();
  await page.waitForFunction(() => document.querySelector(".native-player-topbar em")?.textContent?.includes("已暂停"), undefined, { timeout: 10_000 });
  const paused = await page.locator(".native-player-topbar em").textContent();
  await nativeControls.getByRole("button", { name: /播放/ }).first().click();
  await page.waitForFunction(() => document.querySelector(".native-player-topbar em")?.textContent?.includes("播放中"), undefined, { timeout: 10_000 });
  addResult("LIVE-004", "播放与暂停控制可用", Boolean(paused?.includes("已暂停")));

  const muteButton = nativeControls.locator('button[title^="静音切换"]');
  await muteButton.click();
  await page.waitForFunction(() => [...document.querySelectorAll(".native-player-controls button")].some((button) => button.textContent?.trim() === "静音"), undefined, { timeout: 5_000 });
  await page.keyboard.press("m");
  await page.waitForFunction(() => [...document.querySelectorAll(".native-player-controls button")].some((button) => button.textContent?.trim() === "音量"), undefined, { timeout: 5_000 });
  const volumeSlider = page.locator(".native-volume");
  await volumeSlider.evaluate((element) => {
    const input = element;
    input.value = "35";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const volumeValue = await volumeSlider.inputValue();
  addResult("LIVE-005", "静音快捷键与音量滑块可用", volumeValue === "35", `音量=${volumeValue}`);

  const fullscreenButton = nativeControls.locator('button[title^="进入全屏"]');
  await fullscreenButton.click();
  await waitForAppFullscreen(true);
  await nativeControls.locator('button[title^="退出全屏"]').waitFor({ state: "visible", timeout: 8_000 });
  const enteredFullscreen = await app.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows()[0]?.isFullScreen()));
  await nativeControls.locator('button[title^="退出全屏"]').click();
  await waitForAppFullscreen(false);
  const playerStillOpen = await page.locator(".native-player-host").isVisible();
  addResult("LIVE-006", "全屏按钮可进入退出且不关闭播放器", enteredFullscreen && playerStillOpen);

  const playerLineSelect = page.locator(".native-live-line-select");
  const lineOptions = await playerLineSelect.locator("option").count();
  if (lineOptions > 1) {
    await playerLineSelect.selectOption({ index: 1 });
    await page.locator(".native-player-host").waitFor({ state: "visible", timeout: 20_000 });
  }
  const selectedLineText = await page.locator(".native-live-line-select option:checked").textContent();
  addResult("LIVE-007", "播放器内线路切换可用", lineOptions > 1 && Boolean(selectedLineText?.includes("备用线路")), selectedLineText ?? "");

  await nativeControls.getByRole("button", { name: /下个频道/ }).click();
  try {
    await page.waitForFunction(() => {
      const title = document.querySelector(".native-player-title strong")?.textContent ?? "";
      return title.includes("新闻二台") && title.includes("当前新闻 2");
    }, undefined, { timeout: 20_000 });
  } catch (error) {
    const technicalToggle = page.getByRole("button", { name: "技术详情", exact: true });
    if (await technicalToggle.count()) await technicalToggle.click({ force: true });
    const state = await page.evaluate(() => ({
      playerTitle: document.querySelector(".native-player-title strong")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      messages: [...document.querySelectorAll(".message-bar,.status-message,.error-message,.error-banner")].map((item) => item.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean),
      technical: document.querySelector(".error-message pre")?.textContent?.trim() ?? "",
      bodyTail: document.body.innerText.replace(/\s+/g, " ").slice(-1600),
    }));
    throw new Error(`切换频道超时：${JSON.stringify(state)}；${error instanceof Error ? error.message : String(error)}`);
  }
  const switchedChannelTitle = await page.locator(".native-player-title strong").textContent();
  addResult("LIVE-008", "上下频道切换可用并同步当前节目", Boolean(switchedChannelTitle?.includes("新闻二台") && switchedChannelTitle.includes("当前新闻 2")), switchedChannelTitle ?? "");

  await nativeControls.getByRole("button", { name: /刷新直播/ }).click();
  await page.locator(".native-player-host").waitFor({ state: "visible", timeout: 20_000 });
  addResult("LIVE-009", "刷新当前直播连接后播放器保持可用", await page.locator(".native-player-host").isVisible());

  await nativeControls.getByRole("button", { name: "回看 5 分", exact: true }).click();
  await page.getByRole("button", { name: /回到直播/ }).waitFor({ state: "visible", timeout: 20_000 });
  const replayState = await page.evaluate(() => ({
    heading: document.querySelector(".native-player-title strong")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    hasProgress: Boolean(document.querySelector(".native-progress")),
    hasGuide: [...document.querySelectorAll(".native-player-controls button")].some((button) => button.textContent?.includes("节目单")),
    hasGoLive: [...document.querySelectorAll(".native-player-controls button")].some((button) => button.textContent?.includes("回到直播")),
  }));
  addResult("LIVE-010", "直播时移显示进度、节目单与回到直播", replayState.hasProgress && replayState.hasGuide && replayState.hasGoLive, JSON.stringify(replayState));
  await screenshot("04-timeshift-player.png");

  await page.getByRole("button", { name: /回到直播/ }).click();
  await page.getByRole("button", { name: "回看 5 分", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  addResult("LIVE-011", "回到直播点可恢复实时直播", await page.getByRole("button", { name: "回看 5 分", exact: true }).isVisible());

  await page.getByRole("button", { name: "节目单", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await page.getByRole("button", { name: "节目单", exact: true }).click();
  await page.locator(".live-epg-drawer").waitFor({ state: "visible", timeout: 15_000 });
  const guideState = await page.evaluate(() => ({
    heading: document.querySelector(".live-epg-drawer header strong")?.textContent?.trim() ?? "",
    dates: [...document.querySelectorAll(".live-epg-dates button")].map((button) => button.textContent?.trim()),
    playerClosed: !document.querySelector(".player-container"),
  }));
  addResult(
    "LIVE-012",
    "实时直播播放器可直接打开对应频道节目单",
    guideState.playerClosed && guideState.heading.includes("新闻二台") && guideState.dates.includes("今天") && guideState.dates.includes("明天"),
    JSON.stringify(guideState),
  );
  await screenshot("05-realtime-programme-guide.png");

  addResult("LIVE-013", "端到端流程无页面脚本错误", pageErrors.length === 0 && consoleErrors.length === 0, JSON.stringify({ pageErrors, consoleErrors: consoleErrors.slice(-10) }));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  results.push({ id: "HARNESS", title: "直播播放器端到端执行过程", passed: false, details: message });
  if (page) await screenshot("99-failure.png").catch(() => undefined);
} finally {
  await closeElectronApp();
  await fixture.close().catch(() => undefined);
  await Promise.all([
    fs.rm(userDataDirectory, { recursive: true, force: true }),
    fs.rm(fixtureDirectory, { recursive: true, force: true }),
  ]);
}

const failed = results.filter((result) => !result.passed);
const report = {
  testedAt: new Date().toISOString(),
  nativeAvailable,
  summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
  runtime: { pageErrors, consoleErrors: consoleErrors.slice(-20), hits: fixture.hits },
};
await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(report), "utf8");
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;

async function startFixtureServer(directory) {
  const videoPath = path.join(directory, "live.mp4");
  execFileSync("ffmpeg", [
    "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-movflags", "+faststart", "-shortest", "-y", videoPath,
  ]);
  const video = await fs.readFile(videoPath);
  const hits = { config: 0, epg: 0, video: 0 };
  let origin = "";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    if (url.pathname === "/config.json") {
      hits.config += 1;
      return sendJson(response, liveConfig(origin));
    }
    if (url.pathname === "/epg.xml") {
      hits.epg += 1;
      const body = Buffer.from(epgXml(), "utf8");
      response.writeHead(200, { "content-type": "application/xml; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
      response.end(body);
      return;
    }
    if (url.pathname === "/live.mp4") {
      hits.video += 1;
      return sendMedia(request, response, video, "video/mp4");
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("直播播放器测试服务启动失败");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    configUrl: `${origin}/config.json`,
    hits,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function liveConfig(origin) {
  const catchup = { type: "custom", source: `${origin}/live.mp4?utc={utc}&duration={duration}` };
  return {
    lives: [{
      name: "直播播放器测试源",
      epg: `${origin}/epg.xml`,
      groups: [{
        name: "新闻",
        channel: [
          { name: "新闻一台", number: "1", tvgId: "news-1", catchup, urls: [`${origin}/live.mp4?channel=1&line=1$主线路`, `${origin}/live.mp4?channel=1&line=2$备用线路`] },
          { name: "新闻二台", number: "2", tvgId: "news-2", catchup, urls: [`${origin}/live.mp4?channel=2&line=1$主线路`, `${origin}/live.mp4?channel=2&line=2$备用线路`] },
        ],
      }],
    }],
  };
}

function epgXml() {
  const now = Date.now();
  const currentStart = new Date(now - 10 * 60_000);
  const currentEnd = new Date(now + 20 * 60_000);
  const nextEnd = new Date(now + 50 * 60_000);
  const tomorrowStart = new Date(now + 24 * 60 * 60_000);
  const tomorrowEnd = new Date(tomorrowStart.getTime() + 30 * 60_000);
  const programmes = ["news-1", "news-2"].flatMap((channel, index) => [
    `<programme start="${xmltvTime(currentStart)}" stop="${xmltvTime(currentEnd)}" channel="${channel}"><title>当前新闻 ${index + 1}</title><desc>直播播放器端到端当前节目</desc></programme>`,
    `<programme start="${xmltvTime(currentEnd)}" stop="${xmltvTime(nextEnd)}" channel="${channel}"><title>下一档节目 ${index + 1}</title></programme>`,
    `<programme start="${xmltvTime(tomorrowStart)}" stop="${xmltvTime(tomorrowEnd)}" channel="${channel}"><title>明日新闻 ${index + 1}</title></programme>`,
  ]).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="news-1"><display-name>新闻一台</display-name></channel><channel id="news-2"><display-name>新闻二台</display-name></channel>${programmes}</tv>`;
}

function xmltvTime(date) {
  const value = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${value} +0000`;
}

function sendJson(response, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
  response.end(body);
}

function sendMedia(request, response, body, contentType) {
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = Math.min(body.length - 1, match?.[2] ? Number(match[2]) : body.length - 1);
    const ranged = body.subarray(start, end + 1);
    response.writeHead(206, {
      "content-type": contentType,
      "content-length": ranged.length,
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    response.end(ranged);
    return;
  }
  response.writeHead(200, { "content-type": contentType, "content-length": body.length, "accept-ranges": "bytes", "cache-control": "no-store" });
  response.end(body);
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function renderMarkdown(report) {
  const rows = report.results.map((item) => `| ${item.id} | ${item.passed ? "通过" : "失败"} | ${item.title} | ${String(item.details).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 700)} |`);
  return `# 直播播放器端到端测试报告\n\n- 时间：${report.testedAt}\n- native-libmpv：${report.nativeAvailable ? "可用" : "不可用"}\n- 总计：${report.summary.total}\n- 通过：${report.summary.passed}\n- 失败：${report.summary.failed}\n\n| 用例 | 结果 | 场景 | 详情 |\n|---|---|---|---|\n${rows.join("\n")}\n`;
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
    try { return await import(candidate); } catch (error) { failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  throw new Error(`未找到可用的 Playwright。\n${failures.join("\n")}`);
}
