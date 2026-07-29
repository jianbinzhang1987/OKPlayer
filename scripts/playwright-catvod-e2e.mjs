import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root, explicit: process.env.FONGMI_APP_EXECUTABLE });
const artifactDirectory = path.join(root, "artifacts", "catvod-e2e");
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-catvod-e2e-"));
const userDataDirectory = path.join(temporaryHome, "profile");
const fixture = await startFixtureServer();

await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });

const results = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const requestFailures = [];
let app;
let page;

function record(id, title, passed, details = "", priority = "P0") {
  results.push({ id, priority, title, passed: Boolean(passed), details });
}

async function launchApp({ isolateCatVod = false } = {}) {
  const launched = await electron.launch({
    executablePath,
    args: [
      "--no-default-browser-check",
      `--user-data-dir=${userDataDirectory}`,
    ],
    cwd: root,
    env: {
      ...process.env,
      HOME: temporaryHome,
      ELECTRON_ENABLE_LOGGING: "1",
      FONGMI_E2E_DISABLE_CATVOD: "1",
    },
  });
  const window = await launched.firstWindow({ timeout: 30_000 });
  window.on("console", (message) => {
    const entry = `${message.type()}: ${message.text()}`;
    if (message.type() === "error") consoleErrors.push(entry);
    if (message.type() === "warning") consoleWarnings.push(entry);
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  window.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (failure === "net::ERR_ABORTED") return;
    requestFailures.push(`${request.url()} ${failure}`);
  });
  await window.waitForLoadState("domcontentloaded");
  await window.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });
  if (isolateCatVod) {
    await window.evaluate(async () => {
      if (window.tvApi?.stopCatVod) await window.tvApi.stopCatVod();
    });
    await window.reload({ waitUntil: "domcontentloaded" });
    await window.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });
    await window.waitForFunction(async () => (await window.tvApi.listSites()).length === 0, undefined, { timeout: 15_000 });
  }
  return { launched, window };
}

async function go(name) {
  await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
}

async function goSources() {
  await go("内容来源");
  await page.locator(".quick-source-page").waitFor({ state: "visible", timeout: 10_000 });
}

async function goSettings() {
  await go("设置");
  await page.locator(".settings-page").waitFor({ state: "visible", timeout: 10_000 });
}

async function importConfig(name, url, { expectSuccess = true } = {}) {
  await goSources();
  const card = page.locator(".source-config-settings-card");
  await card.getByPlaceholder("留空自动识别").fill(name);
  await card.getByPlaceholder("粘贴配置地址后按回车即可导入").fill(url);
  await card.getByRole("button", { name: "导入并使用", exact: true }).click();
  if (expectSuccess) {
    await page.locator(".home-page").waitFor({ state: "visible", timeout: 25_000 });
  } else {
    await page.locator(".error-message").waitFor({ state: "visible", timeout: 20_000 });
  }
}

function allSourcesSection() {
  return page.locator(".quick-source-section").last();
}

async function sourceNames() {
  return allSourcesSection().locator(".quick-source-card").evaluateAll((items) => items.map((item) => item.querySelector("strong")?.textContent?.trim() ?? ""));
}

async function currentSourceName() {
  return (await page.locator(".source-picker-trigger-copy strong").textContent())?.trim() ?? "";
}

async function currentSettings() {
  return page.evaluate(async () => ({
    defaultSite: await window.tvApi.getSetting("defaultSite", ""),
    recentSiteKeys: await window.tvApi.getSetting("recentSiteKeys", []),
    configs: await window.tvApi.listConfigs(),
    sites: await window.tvApi.listSites(),
  }));
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(artifactDirectory, name), fullPage: true });
}

async function waitForAuditComplete(timeout = 45_000) {
  await page.waitForFunction(async () => {
    if (!window.tvApi.getSourceAuditStatus) return true;
    const status = await window.tvApi.getSourceAuditStatus();
    return !status.running;
  }, undefined, { timeout });
}

try {
  ({ launched: app, window: page } = await launchApp({ isolateCatVod: true }));

  record("E2E-001", "应用冷启动并显示主界面", await page.locator(".app-shell").isVisible(), "主窗口已显示");

  await goSources();
  const emptyState = {
    current: await currentSourceName(),
    emptyVisible: await page.locator(".quick-source-empty").isVisible(),
    oldStatusList: await page.locator(".simple-site-list, .current-source-card, .simple-source-tabs").count(),
    technicalCopy: await page.locator(".quick-source-page").textContent(),
  };
  record(
    "E2E-002",
    "空数据时播放源页面保持简洁",
    emptyState.current === "暂无可用播放源"
      && emptyState.emptyVisible
      && emptyState.oldStatusList === 0
      && !/本地端口|脚本版本|查看日志|服务实例/.test(emptyState.technicalCopy ?? ""),
    JSON.stringify(emptyState),
  );

  await goSettings();
  await page.getByRole("button", { name: "展开高级设置", exact: true }).click();
  const catVodButtons = await page.locator(".catvod-actions button").allTextContents();
  record(
    "E2E-024",
    "设置页保留 CatVod 管理入口",
    ["启动服务", "重启", "停止", "检查更新", "打开配置中心", "查看日志路径"].every((label) => catVodButtons.some((item) => item.includes(label))),
    JSON.stringify(catVodButtons),
    "P1",
  );

  await importConfig("端到端配置 A", fixture.urls.configA);
  const afterImport = await currentSettings();
  record(
    "E2E-003",
    "设置页导入配置并立即使用",
    afterImport.configs.length === 1
      && afterImport.configs[0]?.enabled === true
      && afterImport.sites.length === 6,
    JSON.stringify({ configs: afterImport.configs, siteCount: afterImport.sites.length }),
  );

  await goSources();
  const allNames = await sourceNames();
  const allCount = Number((await allSourcesSection().locator(".quick-source-section-heading em").textContent())?.trim() ?? -1);
  record(
    "E2E-004",
    "播放源页面只展示可用影视来源",
    allCount === 4
      && allNames.length === 4
      && ["测试｜4K", "测试｜秒播", "测试｜采集", "测试普通源"].every((name) => allNames.includes(name))
      && !allNames.includes("隐藏工具源")
      && !allNames.includes("Android Dex 测试源"),
    JSON.stringify({ allCount, allNames }),
  );
  await screenshot("01-quick-source-page.png");

  const sourceSearch = page.getByPlaceholder("搜索播放源，例如：玩偶、4K、韩剧");
  await sourceSearch.fill("4K");
  const searchNames = await sourceNames();
  record(
    "E2E-005",
    "播放源页面支持关键词搜索",
    searchNames.length === 1 && searchNames[0] === "测试｜4K",
    JSON.stringify(searchNames),
  );
  await sourceSearch.fill("");

  const groupExpectations = [
    ["4K", ["测试｜4K"]],
    ["秒播", ["测试｜秒播"]],
    ["采集", ["测试｜采集"]],
  ];
  const groupSnapshots = {};
  let groupsPassed = true;
  for (const [tab, expected] of groupExpectations) {
    await page.locator(".quick-source-tabs button").filter({ hasText: tab }).click();
    const names = await sourceNames();
    groupSnapshots[tab] = names;
    groupsPassed &&= JSON.stringify(names) === JSON.stringify(expected);
  }
  record("E2E-006", "播放源页面分组筛选正确", groupsPassed, JSON.stringify(groupSnapshots));

  await page.locator(".quick-source-tabs button").filter({ hasText: "全部" }).click();
  await allSourcesSection().locator(".quick-source-card").filter({ hasText: "测试｜采集" }).click();
  await page.waitForFunction(() => document.querySelector(".source-picker-trigger-copy strong")?.textContent?.includes("测试｜采集"));
  const cardSwitch = {
    current: await currentSourceName(),
    activeCard: await allSourcesSection().locator(".quick-source-card.active").textContent(),
  };
  record(
    "E2E-007",
    "播放源卡片点击后立即切换",
    cardSwitch.current === "测试｜采集" && cardSwitch.activeCard?.includes("测试｜采集"),
    JSON.stringify(cardSwitch),
  );

  await page.getByRole("button", { name: "选择播放源" }).click();
  const pickerOpened = await page.locator(".source-picker-panel").isVisible();
  await page.getByRole("button", { name: "关闭播放源选择器" }).click();
  const pickerClosed = !(await page.locator(".source-picker-panel").isVisible().catch(() => false));
  record("E2E-008", "顶部来源选择器可打开并通过遮罩关闭", pickerOpened && pickerClosed, JSON.stringify({ pickerOpened, pickerClosed }));

  await page.getByRole("button", { name: "选择播放源" }).click();
  const picker = page.locator(".source-picker-panel");
  await picker.getByPlaceholder("搜索来源，例如：玩偶、4K、韩剧").fill("秒播");
  const pickerSearchNames = await picker.locator(".source-picker-item").evaluateAll((items) => items.map((item) => item.querySelector("strong")?.textContent?.trim() ?? ""));
  await picker.getByPlaceholder("搜索来源，例如：玩偶、4K、韩剧").fill("");
  await picker.locator(".source-picker-tabs button").filter({ hasText: "4K" }).click();
  const picker4kNames = await picker.locator(".source-picker-item").evaluateAll((items) => items.map((item) => item.querySelector("strong")?.textContent?.trim() ?? ""));
  record(
    "E2E-009",
    "顶部选择器支持搜索和分类",
    JSON.stringify(pickerSearchNames) === JSON.stringify(["测试｜秒播"])
      && JSON.stringify(picker4kNames) === JSON.stringify(["测试｜4K"]),
    JSON.stringify({ pickerSearchNames, picker4kNames }),
  );

  await picker.locator(".source-picker-tabs button").filter({ hasText: "全部" }).click();
  await picker.locator(".source-picker-item").filter({ hasText: "测试｜秒播" }).click();
  await page.waitForFunction(() => document.querySelector(".source-picker-trigger-copy strong")?.textContent?.includes("测试｜秒播"));
  await page.locator(".source-picker-panel").waitFor({ state: "detached", timeout: 5_000 });
  const pickerSwitch = {
    current: await currentSourceName(),
    closed: true,
  };
  record("E2E-010", "顶部选择器切换后自动关闭并同步当前来源", pickerSwitch.current === "测试｜秒播" && pickerSwitch.closed, JSON.stringify(pickerSwitch));

  await goSources();
  await allSourcesSection().locator(".quick-source-card").filter({ hasText: "测试｜4K" }).click();
  await allSourcesSection().locator(".quick-source-card").filter({ hasText: "测试｜采集" }).click();
  await allSourcesSection().locator(".quick-source-card").filter({ hasText: "测试｜秒播" }).click();
  await page.waitForTimeout(700);
  const recentCardNames = await page.locator(".recent-source-grid .quick-source-card").evaluateAll((items) => items.map((item) => item.querySelector("strong")?.textContent?.trim() ?? ""));
  await page.getByRole("button", { name: "选择播放源" }).click();
  await page.locator(".source-picker-tabs button").filter({ hasText: "最近使用" }).click();
  const recentPickerNames = await page.locator(".source-picker-item").evaluateAll((items) => items.map((item) => item.querySelector("strong")?.textContent?.trim() ?? ""));
  await page.getByTitle("关闭").click();
  record(
    "E2E-011",
    "最近使用按最后选择顺序展示",
    recentCardNames.slice(0, 3).join("|") === "测试｜秒播|测试｜采集|测试｜4K"
      && recentPickerNames.slice(0, 3).join("|") === "测试｜秒播|测试｜采集|测试｜4K",
    JSON.stringify({ recentCardNames, recentPickerNames }),
    "P1",
  );

  const settingsBeforeRestart = await currentSettings();
  await app.close();
  app = undefined;
  page = undefined;
  ({ launched: app, window: page } = await launchApp());
  await page.waitForFunction(() => document.querySelector(".source-picker-trigger-copy strong")?.textContent?.includes("测试｜秒播"), undefined, { timeout: 20_000 });
  const settingsAfterRestart = await currentSettings();
  record(
    "E2E-012",
    "应用重启后保持当前播放源",
    (await currentSourceName()) === "测试｜秒播"
      && settingsAfterRestart.defaultSite === settingsBeforeRestart.defaultSite,
    JSON.stringify({ before: settingsBeforeRestart.defaultSite, after: settingsAfterRestart.defaultSite, current: await currentSourceName() }),
  );
  record(
    "E2E-013",
    "应用重启后保持最近使用记录",
    JSON.stringify(settingsAfterRestart.recentSiteKeys.slice(0, 3)) === JSON.stringify(settingsBeforeRestart.recentSiteKeys.slice(0, 3)),
    JSON.stringify({ before: settingsBeforeRestart.recentSiteKeys, after: settingsAfterRestart.recentSiteKeys }),
    "P1",
  );
  await screenshot("02-after-restart.png");

  await go("片库");
  await page.locator(".library-page").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".full-library-grid .library-poster-card").first().waitFor({ state: "visible", timeout: 20_000 });
  const libraryText = await page.locator(".library-page").textContent();
  record(
    "E2E-014",
    "片库加载当前来源内容",
    libraryText?.includes("端到端测试影片") === true && (await currentSourceName()) === "测试｜秒播",
    JSON.stringify({ current: await currentSourceName(), hasMovie: libraryText?.includes("端到端测试影片") }),
  );

  await go("搜索");
  await page.locator(".search-page").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".search-scope button").filter({ hasText: "仅当前来源" }).click();
  const searchInput = page.getByPlaceholder("搜索影片、电视剧、演员");
  await searchInput.fill("端到端测试影片");
  await searchInput.press("Enter");
  const resultCard = page.locator(".search-result-card").filter({ hasText: "端到端测试影片" }).first();
  await resultCard.waitFor({ state: "visible", timeout: 20_000 });
  const resultCopy = await resultCard.textContent();
  record(
    "E2E-015",
    "当前播放源搜索返回指定结果",
    resultCopy?.includes("端到端测试影片") === true && resultCopy.includes("测试｜秒播"),
    resultCopy ?? "",
  );

  const searchLoadMore = page.locator(".search-load-more button");
  const loadMoreVisible = await searchLoadMore.isVisible();
  if (loadMoreVisible) await searchLoadMore.click();
  const secondPageCard = page.locator(".search-result-card").filter({ hasText: "端到端测试影片 第二页" }).first();
  await secondPageCard.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  const pagedSearchNames = await page.locator(".search-result-card h3").allTextContents();
  record(
    "E2E-015A",
    "搜索结果可继续加载下一页并保留已有结果",
    loadMoreVisible
      && pagedSearchNames.includes("端到端测试影片")
      && pagedSearchNames.includes("端到端测试影片 第二页")
      && new Set(pagedSearchNames).size === pagedSearchNames.length,
    JSON.stringify({ loadMoreVisible, pagedSearchNames }),
    "P1",
  );
  await screenshot("03-search-result.png");

  await resultCard.locator(".search-source-list button").filter({ hasText: "测试｜秒播" }).click();
  await page.locator(".detail-page").waitFor({ state: "visible", timeout: 20_000 });
  const detailText = await page.locator(".detail-page").textContent();
  record(
    "E2E-016",
    "搜索结果可进入详情并显示线路剧集",
    detailText?.includes("端到端测试影片") === true
      && detailText.includes("测试线路")
      && detailText.includes("正片")
      && await page.locator(".detail-actions .primary-button").isEnabled(),
    detailText?.replace(/\s+/g, " ").slice(0, 800) ?? "",
  );
  await screenshot("04-detail.png");

  await page.locator(".detail-actions .primary-button").click();
  await page.locator(".embedded-player").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(".embedded-player video").waitFor({ state: "attached", timeout: 20_000 });
  const sessionState = await page.evaluate(() => {
    const video = document.querySelector(".embedded-player video");
    return {
      title: document.querySelector(".player-title strong")?.textContent?.trim() ?? "",
      episode: document.querySelector(".player-title span")?.textContent?.trim() ?? "",
      currentSrc: video instanceof HTMLVideoElement ? video.currentSrc : "",
      readyState: video instanceof HTMLVideoElement ? video.readyState : -1,
      error: document.querySelector(".player-error-card p")?.textContent?.trim() ?? "",
    };
  });
  record(
    "E2E-017",
    "详情页建立内置播放会话",
    sessionState.title.includes("端到端测试影片")
      && sessionState.episode === "正片"
      && sessionState.currentSrc.startsWith("fongmi-media://")
      && sessionState.error === "",
    JSON.stringify(sessionState),
  );

  let mediaState;
  try {
    await page.evaluate(async () => {
      const video = document.querySelector(".embedded-player video");
      if (!(video instanceof HTMLVideoElement)) throw new Error("video 元素不存在");
      try { await video.play(); } catch { /* 外部媒体可能限制自动播放 */ }
    });
    await page.waitForFunction(() => {
      const video = document.querySelector(".embedded-player video");
      return video instanceof HTMLVideoElement && video.readyState >= 1;
    }, undefined, { timeout: 45_000 });
    mediaState = await page.evaluate(() => {
      const video = document.querySelector(".embedded-player video");
      return video instanceof HTMLVideoElement ? {
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        errorCode: video.error?.code ?? 0,
      } : null;
    });
  } catch (error) {
    mediaState = { error: error instanceof Error ? error.message : String(error) };
  }
  record(
    "E2E-018",
    "播放器尝试加载实际媒体数据",
    Boolean(mediaState && !mediaState.error && mediaState.readyState >= 1 && mediaState.errorCode === 0),
    JSON.stringify(mediaState),
    "P1",
  );
  await screenshot("05-player.png");
  await page.locator(".embedded-player").getByTitle("关闭播放器").click().catch(async () => {
    await page.keyboard.press("Escape");
  });

  await importConfig("端到端配置 B", fixture.urls.configB);
  await goSources();
  const configRows = page.locator(".source-config-settings-row");
  const configA = configRows.filter({ hasText: "端到端配置 A" });
  const configB = configRows.filter({ hasText: "端到端配置 B" });
  const importBState = await currentSettings();
  record(
    "E2E-019",
    "导入第二配置后可切换配置",
    importBState.configs.length === 2
      && importBState.configs.find((item) => item.enabled)?.name === "端到端配置 B"
      && await configA.getByRole("button", { name: "切换", exact: true }).isVisible(),
    JSON.stringify(importBState.configs),
  );

  await configA.getByTitle("重命名").click();
  const renameRow = page.locator(".source-config-settings-row .config-rename-row").first();
  await renameRow.waitFor({ state: "visible", timeout: 5_000 });
  await renameRow.getByLabel("配置名称").fill("端到端配置 A（已重命名）");
  await renameRow.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("端到端配置 A（已重命名）"));
  let configState = await currentSettings();
  record(
    "E2E-020",
    "配置重命名即时生效并持久化",
    configState.configs.some((item) => item.name === "端到端配置 A（已重命名）"),
    JSON.stringify(configState.configs),
    "P1",
  );

  const renamedA = page.locator(".source-config-settings-row").filter({ hasText: "端到端配置 A（已重命名）" });
  await renamedA.getByRole("button", { name: "切换", exact: true }).click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 20_000 });
  await goSources();
  const inactiveB = page.locator(".source-config-settings-row").filter({ hasText: "端到端配置 B" });
  await inactiveB.getByTitle("删除配置").click();
  const confirmVisible = await inactiveB.getByTitle("再次点击确认删除").isVisible();
  await inactiveB.getByTitle("再次点击确认删除").click();
  await inactiveB.waitFor({ state: "detached", timeout: 10_000 });
  configState = await currentSettings();
  record(
    "E2E-021",
    "删除配置需要二次确认且无残留",
    confirmVisible && !configState.configs.some((item) => item.name === "端到端配置 B"),
    JSON.stringify({ confirmVisible, configs: configState.configs }),
    "P1",
  );

  const configsBeforeInvalid = JSON.stringify(configState.configs);
  await importConfig("非法配置", fixture.urls.invalidConfig, { expectSuccess: false });
  const invalidError = (await page.locator(".error-message p").textContent())?.trim() ?? "";
  const importButtonText = (await page.locator(".source-config-settings-card .primary-button").textContent())?.trim() ?? "";
  const configsAfterInvalid = JSON.stringify((await currentSettings()).configs);
  record(
    "E2E-022",
    "非法配置报错且不替换当前配置",
    invalidError.length > 0
      && importButtonText.includes("导入并使用")
      && configsBeforeInvalid === configsAfterInvalid,
    JSON.stringify({ invalidError, importButtonText, unchanged: configsBeforeInvalid === configsAfterInvalid }),
  );

  await page.locator(".error-message .message-actions > button:last-child").click();
  const apiHitsBeforeAudit = fixture.totalApiHits();
  const auditButton = page.locator(".quick-source-header").getByRole("button", { name: "检查并修复", exact: true });
  await auditButton.click();
  await page.waitForFunction(() => document.querySelector(".quick-source-header button")?.hasAttribute("disabled"), undefined, { timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector(".quick-source-header button")?.hasAttribute("disabled"), undefined, { timeout: 90_000 });
  await waitForAuditComplete();
  const apiHitsAfterAudit = fixture.totalApiHits();
  record(
    "E2E-023",
    "重新检测会真实访问来源接口并结束",
    apiHitsAfterAudit > apiHitsBeforeAudit,
    JSON.stringify({ apiHitsBeforeAudit, apiHitsAfterAudit }),
    "P1",
  );
  await screenshot("06-settings-config-management.png");

  await page.evaluate(() => window.tvApi.saveFavorite({
    siteKey: "missing-catvod-source",
    vodId: "missing-vod",
    vodName: "端到端测试影片",
    vodPic: "",
    createdAt: Date.now(),
  }));
  await go("收藏");
  const missingFavorite = page.locator(".library-card").filter({ hasText: "端到端测试影片" }).first();
  await missingFavorite.waitFor({ state: "visible", timeout: 10_000 });
  await missingFavorite.locator(".poster-card").click();
  const recoveryAction = page.locator(".error-message .message-action").filter({ hasText: "查找其他来源" });
  const recoveryVisible = await recoveryAction.isVisible();
  if (recoveryVisible) await recoveryAction.click();
  const recoveredSearchResult = page.locator(".search-result-card").filter({ hasText: "端到端测试影片" }).first();
  await recoveredSearchResult.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  record(
    "E2E-026",
    "收藏来源失效后可重新查找其他来源",
    recoveryVisible
      && await page.locator(".search-page").isVisible()
      && await recoveredSearchResult.isVisible(),
    JSON.stringify({ recoveryVisible, searchVisible: await page.locator(".search-page").isVisible() }),
    "P1",
  );
  await screenshot("07-favorite-source-recovery.png");

  const unexpectedConsoleErrors = consoleErrors.filter((item) => !/Autofill|DevTools/.test(item));
  record(
    "E2E-025",
    "完整 GUI 流程无页面脚本异常",
    pageErrors.length === 0 && unexpectedConsoleErrors.length === 0,
    JSON.stringify({ pageErrors, consoleErrors: unexpectedConsoleErrors, consoleWarnings, requestFailures: requestFailures.slice(0, 10) }),
  );
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  record("HARNESS", "GUI 自动化执行过程", false, message, "P0");
  if (page) await page.screenshot({ path: path.join(artifactDirectory, "99-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  if (app) await app.close().catch(() => undefined);
  await fixture.close();
}

const failed = results.filter((item) => !item.passed);
const p0Failed = failed.filter((item) => item.priority === "P0");
const report = {
  executedAt: new Date().toISOString(),
  executablePath,
  fixtureOrigin: fixture.origin,
  summary: {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    p0Failed: p0Failed.length,
  },
  results,
  runtime: {
    consoleErrors,
    consoleWarnings,
    pageErrors,
    requestFailures,
    fixtureHits: Object.fromEntries(fixture.hits),
  },
};

await fs.writeFile(path.join(artifactDirectory, "gui-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(artifactDirectory, "gui-report.md"), renderMarkdown(report), "utf8");
await fs.rm(temporaryHome, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
if (p0Failed.length > 0) process.exitCode = 1;

function renderMarkdown(report) {
  const rows = report.results.map((item) => `| ${item.id} | ${item.priority} | ${item.passed ? "通过" : "失败"} | ${item.title} | ${String(item.details).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 600)} |`);
  return `# CatVod GUI 端到端测试报告\n\n- 时间：${report.executedAt}\n- 总计：${report.summary.total}\n- 通过：${report.summary.passed}\n- 失败：${report.summary.failed}\n- P0 失败：${report.summary.p0Failed}\n\n| 用例 | 优先级 | 结果 | 场景 | 详情 |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
}

async function startFixtureServer() {
  const hits = new Map();
  let origin = "";
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

    if (url.pathname === "/config-a.json") return sendJson(response, configA(origin));
    if (url.pathname === "/config-b.json") return sendJson(response, configB(origin));
    if (url.pathname === "/invalid-config.json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"sites": [');
      return;
    }
    if (url.pathname.startsWith("/api/")) return sendJson(response, apiPayload(url));

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture 服务启动失败");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    hits,
    urls: {
      configA: `${origin}/config-a.json`,
      configB: `${origin}/config-b.json`,
      invalidConfig: `${origin}/invalid-config.json`,
    },
    totalApiHits: () => [...hits.entries()].filter(([key]) => key.startsWith("/api/")).reduce((sum, [, value]) => sum + value, 0),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function configA(origin) {
  return {
    spider: `${origin}/android-spider.jar;md5;fixture`,
    sites: [
      source("fixture_4k", "测试｜4K", `${origin}/api/4k`),
      source("fixture_quick", "测试｜秒播", `${origin}/api/quick`),
      source("fixture_collect", "测试｜采集", `${origin}/api/collect`),
      source("fixture_other", "测试普通源", `${origin}/api/other`),
      { ...source("fixture_hidden", "隐藏工具源", `${origin}/api/hidden`), hide: 1 },
      {
        key: "fixture_android_dex",
        name: "Android Dex 测试源",
        type: 3,
        api: "csp_FixtureAndroid",
        searchable: 1,
      },
    ],
  };
}

function configB(origin) {
  return {
    sites: [
      source("fixture_b_4k", "配置B｜4K", `${origin}/api/b4k`),
      source("fixture_b_collect", "配置B｜采集", `${origin}/api/bcollect`),
    ],
  };
}

function source(key, name, api) {
  return {
    key,
    name,
    type: 1,
    api,
    searchable: 1,
    quickSearch: 1,
    filterable: 1,
    categories: ["电影"],
  };
}

function apiPayload(url) {
  const suffix = url.pathname.split("/").pop() ?? "fixture";
  const searchRequest = url.searchParams.has("wd");
  const page = searchRequest ? Math.max(1, Number(url.searchParams.get("pg") ?? "1") || 1) : 1;
  const pageCount = searchRequest ? 2 : 1;
  return {
    code: 1,
    msg: "数据列表",
    page,
    pagecount: pageCount,
    limit: 20,
    total: pageCount,
    class: [{ type_id: "电影", type_name: "电影" }],
    list: [{
      vod_id: `e2e-${suffix}-${page}`,
      vod_name: page === 1 ? "端到端测试影片" : "端到端测试影片 第二页",
      vod_pic: "",
      vod_remarks: "测试资源",
      vod_year: "2026",
      vod_area: "测试区",
      vod_content: "用于验证搜索、详情和内置播放完整链路。",
      vod_play_from: "测试线路",
      vod_play_url: "正片$https://media.w3.org/2010/05/sintel/trailer.mp4",
    }],
  };
}

function sendJson(response, payload) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
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
