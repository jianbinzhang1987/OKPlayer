import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root });
const artifactDirectory = path.join(root, "artifacts", "player-upgrade-e2e");
const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-player-e2e-profile-"));
const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-player-e2e-fixture-"));
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });

const fixture = await startFixtureServer(fixtureDirectory);
const results = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
let app;
let page;

function addResult(id, title, passed, details = "") {
  results.push({ id, title, passed, details });
}

async function launchApp() {
  const launched = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, FONGMI_PLAYER_E2E: "1", FONGMI_E2E_DISABLE_CATVOD: "1" },
  });
  const window = await launched.firstWindow({ timeout: 25_000 });
  window.on("console", (message) => {
    const entry = `${message.type()}: ${message.text()}`;
    if (message.type() === "error") consoleErrors.push(entry);
    if (message.type() === "warning") consoleWarnings.push(entry);
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  await window.waitForLoadState("domcontentloaded");
  await window.locator(".app-shell").waitFor({ state: "visible", timeout: 25_000 });
  await window.waitForTimeout(700);
  return { launched, window };
}

async function clickSidebar(text) {
  const button = page.locator(".sidebar button").filter({ hasText: text }).first();
  await button.click();
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(artifactDirectory, name), fullPage: true });
}

async function setPlayerPreferences(engine) {
  await clickSidebar("设置");
  await page.locator(".settings-page").waitFor({ state: "visible", timeout: 10_000 });
  const engineSelect = page.locator('select').filter({ has: page.locator('option[value="artplayer"]') }).first();
  await engineSelect.selectOption(engine);
  const fallbackSelect = page.locator('select').filter({ has: page.locator('option[value="manual"]') }).first();
  await fallbackSelect.selectOption("manual");
  await page.locator(".settings-footer .primary-button").click();
  await page.locator(".saved-indicator").waitFor({ state: "visible", timeout: 5_000 });
  return page.evaluate(async () => ({
    engine: await window.tvApi.getSetting("webPlayerEngine", "legacy"),
    fallback: await window.tvApi.getSetting("compatibilityFallbackMode", "automatic"),
  }));
}

async function importFixtureConfig() {
  await clickSidebar("内容来源");
  await page.locator(".sources-page").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByPlaceholder("粘贴配置地址后按回车即可导入").fill(fixture.configUrl);
  await page.getByPlaceholder("留空自动识别").fill("播放器端到端测试");
  await page.locator(".simplified-source-import-form .primary-button").click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 25_000 });
  await page.waitForFunction(async () => {
    const configs = await window.tvApi.listConfigs();
    return configs.some((item) => item.name === "播放器端到端测试" && item.enabled);
  }, undefined, { timeout: 15_000 });
  await clickSidebar("内容来源");
  await page.locator(".sources-page").waitFor({ state: "visible", timeout: 10_000 });
  const sourceCard = page.locator(".quick-source-card").filter({ hasText: "播放器端到端源" }).first();
  await sourceCard.waitFor({ state: "visible", timeout: 10_000 });
  await sourceCard.click();
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll(".quick-source-card")];
    return cards.some((item) => item.textContent?.includes("播放器端到端源") && item.classList.contains("active"));
  }, undefined, { timeout: 10_000 });
}

async function openFixtureDetail(title) {
  await clickSidebar("搜索");
  await page.locator(".search-page").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: "仅当前来源", exact: true }).click();
  const input = page.getByPlaceholder("搜索影片、电视剧、演员");
  await input.fill(title);
  await input.press("Enter");
  const exactHeading = page.getByRole("heading", { name: title, exact: true });
  const card = page.locator(".search-result-card").filter({ has: exactHeading }).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await card.getByRole("button", { name: "查看详情", exact: true }).click();
  const detail = page.locator(".detail-page");
  await detail.waitFor({ state: "visible", timeout: 15_000 });
  await detail.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(500);
  if (!(await detail.isVisible())) throw new Error(`详情页未保持显示：${title}`);
}

async function startPlayback(expectedEngine) {
  const playButton = page.locator(".detail-page .detail-actions .primary-button").first();
  const detailState = await page.evaluate(() => ({
    detailVisible: Boolean(document.querySelector(".detail-page")),
    detailTitle: document.querySelector(".detail-copy h1")?.textContent?.trim() ?? "",
    detailActions: document.querySelector(".detail-actions")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    buttons: [...document.querySelectorAll(".detail-page button")].map((item) => ({
      text: item.textContent?.replace(/\s+/g, " ").trim() ?? "",
      className: item.className,
      disabled: item.hasAttribute("disabled"),
    })),
    bodyTail: document.body.innerText.replace(/\s+/g, " ").slice(-1200),
  }));
  if (await playButton.count() === 0) throw new Error(`详情页缺少播放按钮：${JSON.stringify(detailState)}`);
  if (await playButton.isDisabled()) throw new Error(`详情页播放按钮不可用：${JSON.stringify(detailState)}`);
  await playButton.click();
  await page.locator(".player-container").waitFor({ state: "visible", timeout: 25_000 });
  await page.waitForTimeout(1_200);
  const engineState = await page.evaluate(() => ({
    activeEngine: document.querySelector(".player-container")?.getAttribute("data-player-engine") ?? "",
    artVisible: Boolean(document.querySelector(".art-player-host")),
    legacyVisible: Boolean(document.querySelector(".embedded-player")),
    status: [...document.querySelectorAll(".message-bar,.status-message,.error-message")].map((item) => item.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean),
    artResources: performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("ArtPlayerHost")),
    bodyTail: document.body.innerText.replace(/\s+/g, " ").slice(-900),
  }));
  if (engineState.activeEngine !== expectedEngine) throw new Error(`播放器引擎未按设置启用：${JSON.stringify(engineState)}`);
  const selector = expectedEngine === "artplayer" ? ".art-player-host" : ".embedded-player";
  await page.locator(selector).waitFor({ state: "visible", timeout: 12_000 });
  await page.locator(`${selector} video`).waitFor({ state: "attached", timeout: 15_000 });
  await page.evaluate(async (rootSelector) => {
    const video = document.querySelector(`${rootSelector} video`);
    if (!(video instanceof HTMLVideoElement)) throw new Error("播放器 video 元素不存在");
    video.muted = true;
    try { await video.play(); } catch {}
  }, selector);
  await page.waitForFunction((rootSelector) => {
    const video = document.querySelector(`${rootSelector} video`);
    return video instanceof HTMLVideoElement
      && video.readyState >= 2
      && video.currentTime > 0.15
      && !video.paused;
  }, selector, { timeout: 30_000 });
  return page.evaluate((rootSelector) => {
    const video = document.querySelector(`${rootSelector} video`);
    const container = document.querySelector(".player-container");
    return {
      activeEngine: container?.getAttribute("data-player-engine") ?? "",
      currentSrc: video instanceof HTMLVideoElement ? video.currentSrc : "",
      readyState: video instanceof HTMLVideoElement ? video.readyState : -1,
      paused: video instanceof HTMLVideoElement ? video.paused : true,
      currentTime: video instanceof HTMLVideoElement ? video.currentTime : 0,
      duration: video instanceof HTMLVideoElement ? video.duration : 0,
      artVisible: Boolean(document.querySelector(".art-player-host")),
      legacyVisible: Boolean(document.querySelector(".embedded-player")),
      title: document.querySelector(".player-title strong")?.textContent?.trim() ?? "",
      episode: document.querySelector(".player-title span")?.textContent?.trim() ?? "",
    };
  }, selector);
}

async function testFullscreen() {
  await page.bringToFront();
  const fullscreenButton = page.locator('.art-player-host button[title="全屏"]');
  await fullscreenButton.click();
  const startedAt = Date.now();
  let nativeFullscreen = false;
  let domFullscreen = false;
  while (Date.now() - startedAt < 12_000) {
    domFullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
    nativeFullscreen = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) => item.isFullScreen()));
    if (domFullscreen || nativeFullscreen) break;
    await page.waitForTimeout(250);
  }
  const snapshot = await page.evaluate(() => ({
    fullscreenEnabled: document.fullscreenEnabled,
    fullscreenTag: document.fullscreenElement?.tagName ?? "",
    fullscreenClass: document.fullscreenElement?.className ?? "",
    headerPresent: Boolean(document.querySelector(".art-player-host .art-player-header")),
    headerVisibleInDomFullscreen: Boolean(document.querySelector(".art-player-host:fullscreen .art-player-header")),
    rootHasRequestFullscreen: typeof document.querySelector(".art-player-host")?.requestFullscreen === "function",
  }));
  snapshot.domFullscreen = domFullscreen;
  snapshot.nativeFullscreen = nativeFullscreen;
  snapshot.entered = domFullscreen || nativeFullscreen;
  if (snapshot.entered) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    const stillNative = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) => item.isFullScreen()));
    if (stillNative) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((item) => item.setFullScreen(false)));
  }
  return snapshot;
}

async function closePlayer() {
  const close = page.locator('.player-header-button[title="关闭播放器"]');
  await close.click();
  await page.locator(".player-container").waitFor({ state: "detached", timeout: 15_000 });
}

try {
  ({ launched: app, window: page } = await launchApp());

  const preferences = await setPlayerPreferences("artplayer");
  addResult(
    "PL-001",
    "ArtPlayer 与手动兼容策略可以保存",
    preferences.engine === "artplayer" && preferences.fallback === "manual",
    JSON.stringify(preferences),
  );
  await screenshot("01-artplayer-settings.png");

  await importFixtureConfig();
  const configs = await page.evaluate(() => window.tvApi.listConfigs());
  addResult(
    "PL-002",
    "离线测试配置可以导入并激活",
    configs.some((item) => item.name === "播放器端到端测试" && item.enabled),
    JSON.stringify(configs),
  );
  await screenshot("02-config-imported.png");

  await openFixtureDetail("端到端 MP4");
  await screenshot("03-mp4-detail.png");
  const mp4 = await startPlayback("artplayer");
  addResult(
    "PL-003",
    "ArtPlayer 可以通过受控协议播放 MP4",
    mp4.activeEngine === "artplayer"
      && mp4.artVisible
      && !mp4.legacyVisible
      && mp4.currentSrc.startsWith("fongmi-media://")
      && mp4.readyState >= 2
      && !mp4.paused
      && mp4.currentTime > 0.15
      && mp4.duration > 0,
    JSON.stringify(mp4),
  );
  await screenshot("04-artplayer-mp4-playing.png");

  const fullscreen = await testFullscreen();
  addResult(
    "PL-004",
    "ArtPlayer 使用完整播放器外壳全屏",
    fullscreen.entered
      && fullscreen.headerPresent
      && (!fullscreen.domFullscreen || (fullscreen.fullscreenTag === "SECTION" && String(fullscreen.fullscreenClass).includes("art-player-host"))),
    JSON.stringify(fullscreen),
  );
  await closePlayer();

  await openFixtureDetail("端到端 HLS");
  const hls = await startPlayback("artplayer");
  addResult(
    "PL-005",
    "ArtPlayer 可以通过受控协议播放 HLS",
    hls.activeEngine === "artplayer"
      && hls.artVisible
      && hls.currentSrc.startsWith("fongmi-media://")
      && hls.readyState >= 2
      && !hls.paused
      && hls.currentTime > 0.15
      && fixture.hits.hlsSegments > 0,
    JSON.stringify({ ...hls, hlsSegments: fixture.hits.hlsSegments }),
  );
  await screenshot("05-artplayer-hls-playing.png");
  await closePlayer();

  const legacyPreferences = await setPlayerPreferences("legacy");
  await openFixtureDetail("端到端 MP4");
  const legacy = await startPlayback("legacy");
  addResult(
    "PL-006",
    "可以切回稳定播放器并正常播放",
    legacyPreferences.engine === "legacy"
      && legacy.activeEngine === "legacy"
      && legacy.legacyVisible
      && !legacy.artVisible
      && legacy.currentSrc.startsWith("fongmi-media://")
      && legacy.readyState >= 2
      && !legacy.paused,
    JSON.stringify({ preferences: legacyPreferences, playback: legacy }),
  );
  await screenshot("06-legacy-player-playing.png");
  await closePlayer();

  await setPlayerPreferences("artplayer");
  await app.close();
  app = undefined;
  page = undefined;

  ({ launched: app, window: page } = await launchApp());
  await clickSidebar("设置");
  await page.locator(".settings-page").waitFor({ state: "visible", timeout: 10_000 });
  const persistedSelect = page.locator('select').filter({ has: page.locator('option[value="artplayer"]') }).first();
  const persisted = {
    uiValue: await persistedSelect.inputValue(),
    storedValue: await page.evaluate(() => window.tvApi.getSetting("webPlayerEngine", "legacy")),
    configs: await page.evaluate(() => window.tvApi.listConfigs()),
  };
  addResult(
    "PL-007",
    "重启后播放器选择和配置保持不变",
    persisted.uiValue === "artplayer"
      && persisted.storedValue === "artplayer"
      && persisted.configs.some((item) => item.name === "播放器端到端测试" && item.enabled),
    JSON.stringify(persisted),
  );
  await screenshot("07-after-relaunch.png");

  addResult(
    "PL-008",
    "完整播放器流程无页面脚本错误",
    pageErrors.length === 0 && consoleErrors.length === 0,
    JSON.stringify({ pageErrors, consoleErrors, consoleWarnings }),
  );
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  results.push({ id: "HARNESS", title: "播放器端到端执行过程", passed: false, details: message });
  if (page) await page.screenshot({ path: path.join(artifactDirectory, "99-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  if (app) await app.close().catch(() => undefined);
  await fixture.close();
  await Promise.all([
    fs.rm(userDataDirectory, { recursive: true, force: true }),
    fs.rm(fixtureDirectory, { recursive: true, force: true }),
  ]);
}

const failed = results.filter((item) => !item.passed);
const report = {
  testedAt: new Date().toISOString(),
  executablePath,
  fixtureOrigin: fixture.origin,
  summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
  runtime: {
    mediaHits: fixture.hits,
    consoleErrors,
    consoleWarnings,
    pageErrors,
  },
};
await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(report), "utf8");
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;

function renderMarkdown(report) {
  const rows = report.results.map((item) => `| ${item.id} | ${item.passed ? "通过" : "失败"} | ${item.title} | ${String(item.details).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 800)} |`);
  return `# 播放器升级端到端测试报告\n\n- 时间：${report.testedAt}\n- 总计：${report.summary.total}\n- 通过：${report.summary.passed}\n- 失败：${report.summary.failed}\n\n| 用例 | 结果 | 场景 | 详情 |\n|---|---|---|---|\n${rows.join("\n")}\n`;
}

async function startFixtureServer(directory) {
  const mp4Path = path.join(directory, "video.mp4");
  const manifestPath = path.join(directory, "master.m3u8");
  const segmentPattern = path.join(directory, "segment-%03d.ts");
  execFileSync("ffmpeg", [
    "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-movflags", "+faststart", "-shortest", "-y", mp4Path,
  ]);
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-i", mp4Path, "-c", "copy",
    "-hls_time", "1", "-hls_playlist_type", "vod",
    "-hls_segment_filename", segmentPattern, "-y", manifestPath,
  ]);

  const mp4 = await fs.readFile(mp4Path);
  const manifest = await fs.readFile(manifestPath);
  const segments = new Map();
  for (const name of await fs.readdir(directory)) {
    if (/^segment-\d+\.ts$/.test(name)) segments.set(`/${name}`, await fs.readFile(path.join(directory, name)));
  }

  const hits = { config: 0, api: 0, mp4: 0, manifest: 0, hlsSegments: 0 };
  let origin = "";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    if (url.pathname === "/config.json") {
      hits.config += 1;
      return sendPayload(response, {
        sites: [{
          key: "player_e2e",
          name: "播放器端到端源",
          type: 1,
          api: `${origin}/api`,
          searchable: 1,
          quickSearch: 1,
          categories: ["电影"],
        }],
      });
    }
    if (url.pathname === "/api") {
      hits.api += 1;
      const keyword = url.searchParams.get("wd") ?? "";
      const id = url.searchParams.get("ids");
      if (id) return sendJson(response, apiPayload(origin).filter((item) => item.vod_id === id));
      const list = keyword
        ? apiPayload(origin).filter((item) => item.vod_name.includes(keyword))
        : apiPayload(origin);
      return sendJson(response, list);
    }
    if (url.pathname === "/video.mp4") {
      hits.mp4 += 1;
      return sendMedia(request, response, mp4, "video/mp4");
    }
    if (url.pathname === "/master.m3u8") {
      hits.manifest += 1;
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
        "content-length": manifest.length,
        "cache-control": "no-store",
      });
      response.end(manifest);
      return;
    }
    const segment = segments.get(url.pathname);
    if (segment) {
      hits.hlsSegments += 1;
      return sendMedia(request, response, segment, "video/mp2t");
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("播放器测试服务启动失败");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    configUrl: `${origin}/config.json`,
    hits,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function apiPayload(origin) {
  return [
    {
      vod_id: "e2e-mp4",
      vod_name: "端到端 MP4",
      vod_pic: "",
      vod_year: "2026",
      vod_area: "本地",
      type_name: "测试影片",
      vod_remarks: "MP4",
      vod_content: "本地生成的 MP4 端到端测试影片。",
      vod_play_from: "本地 MP4",
      vod_play_url: `第1集$${origin}/video.mp4`,
    },
    {
      vod_id: "e2e-hls",
      vod_name: "端到端 HLS",
      vod_pic: "",
      vod_year: "2026",
      vod_area: "本地",
      type_name: "测试影片",
      vod_remarks: "HLS",
      vod_content: "本地生成的 HLS 端到端测试影片。",
      vod_play_from: "本地 HLS",
      vod_play_url: `第1集$${origin}/master.m3u8`,
    },
  ];
}

function sendJson(response, list) {
  return sendPayload(response, { code: 1, msg: "数据列表", page: 1, pagecount: 1, limit: 20, total: list.length, list });
}

function sendPayload(response, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
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
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  response.end(body);
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
