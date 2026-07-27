import fs from "node:fs/promises";
import path from "node:path";
const playwrightModule = process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright";
const { _electron: electron } = await import(playwrightModule);

const root = process.cwd();
const artifactDir = path.join(root, "artifacts", "ui-audit");
await fs.mkdir(artifactDir, { recursive: true });

const executablePath = path.join(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const errors = [];
const warnings = [];

const app = await electron.launch({
  executablePath,
  args: [path.join(root, "scripts", "playwright-preview-main.cjs")],
  cwd: root,
  env: { ...process.env },
});

try {
  const page = await app.firstWindow();
  page.on("console", (message) => {
    const entry = `console:${message.type()}: ${message.text()}`;
    console.log(entry);
    if (message.type() === "error") errors.push(entry);
    if (message.type() === "warning") warnings.push(entry);
  });
  page.on("pageerror", (error) => {
    const entry = `pageerror: ${error.message}`;
    errors.push(entry);
    console.log(entry);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (failure === "net::ERR_ABORTED" || request.url().includes("interactive-examples.mdn.mozilla.net")) return;
    const entry = `requestfailed: ${request.url()} ${failure}`;
    errors.push(entry);
    console.log(entry);
  });

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(900);
  console.log(JSON.stringify({ initialUrl: page.url(), title: await page.title(), bodyText: (await page.locator("body").innerText().catch(() => "")).slice(0, 500) }, null, 2));
  await page.locator(".hero").waitFor({ state: "visible", timeout: 12_000 });

  const homeMetrics = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const buttons = [...document.querySelectorAll("button")];
    const emptyButtonNames = buttons.filter((button) => !(button.textContent ?? "").trim() && !button.getAttribute("aria-label") && !button.getAttribute("title")).length;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sidebar: rect(".sidebar"),
      topbar: rect(".topbar"),
      hero: rect(".hero"),
      posterCards: document.querySelectorAll(".poster-card").length,
      continueCards: document.querySelectorAll(".continue-card").length,
      emptyButtonNames,
      fontFamily: getComputedStyle(document.documentElement).fontFamily,
      backdropFilter: getComputedStyle(document.querySelector(".sidebar")).backdropFilter,
    };
  });

  await page.screenshot({ path: path.join(artifactDir, "01-home.png"), fullPage: true });

  await page.locator(".poster-card").first().click();
  await page.locator(".detail-page").waitFor({ state: "visible" });
  const detailMetrics = await page.evaluate(() => ({
    title: document.querySelector(".detail-copy h1")?.textContent?.trim() ?? "",
    episodeButtons: document.querySelectorAll(".episode-grid button").length,
    lineTabs: document.querySelectorAll(".line-tabs button").length,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  await page.screenshot({ path: path.join(artifactDir, "02-detail.png"), fullPage: true });

  await page.locator(".detail-actions .primary-button").click();
  await page.locator(".embedded-player").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector(".format-chip")?.textContent?.includes("HLS · MSE"), undefined, { timeout: 20_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector(".embedded-player video");
    return (video instanceof HTMLVideoElement && video.readyState >= 1) || document.querySelector(".player-error-card") !== null;
  }, undefined, { timeout: 20_000 });
  const playerMetrics = await page.evaluate(() => {
    const media = document.querySelector(".embedded-player video");
    return {
      visible: document.querySelector(".embedded-player") !== null,
      videoElements: document.querySelectorAll(".embedded-player video").length,
      hasCompatibilityAction: [...document.querySelectorAll(".embedded-player button")].some((button) => button.textContent?.includes("兼容模式")),
      nativeHlsSupport: document.createElement("video").canPlayType("application/vnd.apple.mpegurl"),
      engineLabel: document.querySelector(".format-chip")?.textContent?.trim() ?? "",
      readyState: media instanceof HTMLVideoElement ? media.readyState : 0,
      duration: media instanceof HTMLVideoElement && Number.isFinite(media.duration) ? media.duration : 0,
      playerError: document.querySelector(".player-error-card p")?.textContent?.trim() ?? "",
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  await page.screenshot({ path: path.join(artifactDir, "03-player.png"), fullPage: true });
  await page.getByTitle("关闭播放器").click();
  await page.locator(".embedded-player").waitFor({ state: "detached" });

  await page.getByRole("button", { name: "播放源" }).click();
  await page.locator(".sources-page").waitFor({ state: "visible" });
  const sourceMetrics = await page.evaluate(() => ({
    configCards: document.querySelectorAll(".config-card").length,
    siteCards: document.querySelectorAll(".site-card").length,
    availableStatus: document.querySelectorAll(".success-chip").length,
    restrictedStatus: document.querySelectorAll(".warning-chip").length,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  await page.getByTitle("重命名").first().click();
  const renameInput = page.locator(".config-rename-row input");
  await renameInput.fill("演示配置 · 已优化");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const renamedConfigVisible = await page.getByText("演示配置 · 已优化", { exact: false }).isVisible();
  await page.screenshot({ path: path.join(artifactDir, "04-sources.png"), fullPage: true });

  await page.getByRole("button", { name: "播放历史", exact: true }).click();
  await page.locator(".history-list").waitFor({ state: "visible" });
  const historyMetrics = await page.evaluate(() => ({
    items: document.querySelectorAll(".history-item").length,
    progressBars: document.querySelectorAll(".history-copy i").length,
    removeActions: document.querySelectorAll(".history-remove").length,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  await page.screenshot({ path: path.join(artifactDir, "05-history.png"), fullPage: true });

  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const searchInput = page.locator(".topbar-search input");
  await searchInput.fill("星际");
  await searchInput.press("Enter");
  await page.waitForTimeout(150);
  const searchMetrics = await page.evaluate(() => ({
    resultCards: document.querySelectorAll(".search-grid .poster-card").length,
    statusChips: document.querySelectorAll(".search-status-list span").length,
    title: document.querySelector(".page-title-row h1")?.textContent?.trim() ?? "",
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  await page.screenshot({ path: path.join(artifactDir, "06-search.png"), fullPage: true });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".settings-page").waitFor({ state: "visible" });
  const fontSizeSelect = page.locator(".setting-row").filter({ hasText: "界面字体大小" }).locator("select");
  await fontSizeSelect.selectOption("extra-large");
  await page.waitForTimeout(120);
  const settingsMetrics = await page.evaluate(() => ({
    runtimeRows: document.querySelectorAll(".runtime-list > div").length,
    fontSizeOptions: document.querySelectorAll(".setting-row select option").length,
    fontMode: document.querySelector(".app-shell")?.classList.contains("font-extra-large") ? "extra-large" : "unknown",
    navigationFontSize: getComputedStyle(document.querySelector(".primary-nav button")).fontSize,
    helperFontSize: getComputedStyle(document.querySelector(".setting-row span")).fontSize,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  await page.screenshot({ path: path.join(artifactDir, "07-settings-extra-large.png"), fullPage: true });

  await page.setViewportSize({ width: 1040, height: 680 });
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.waitForTimeout(120);
  const compactMetrics = await page.evaluate(() => ({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    sidebarWidth: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
    heroWidth: document.querySelector(".hero")?.getBoundingClientRect().width ?? 0,
    visiblePosterCards: [...document.querySelectorAll(".poster-card")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length,
  }));
  await page.screenshot({ path: path.join(artifactDir, "08-compact.png"), fullPage: true });

  const report = {
    auditedAt: new Date().toISOString(),
    home: homeMetrics,
    detail: detailMetrics,
    player: playerMetrics,
    sources: { ...sourceMetrics, renamedConfigVisible },
    history: historyMetrics,
    search: searchMetrics,
    settings: settingsMetrics,
    compact: compactMetrics,
    consoleErrors: errors,
    consoleWarnings: warnings,
    passed:
      !homeMetrics.bodyOverflowX &&
      homeMetrics.posterCards >= 6 &&
      homeMetrics.emptyButtonNames === 0 &&
      detailMetrics.episodeButtons >= 10 &&
      !detailMetrics.overflowX &&
      playerMetrics.visible &&
      playerMetrics.videoElements === 1 &&
      playerMetrics.hasCompatibilityAction &&
      playerMetrics.engineLabel === "HLS · MSE" &&
      playerMetrics.readyState >= 1 &&
      playerMetrics.playerError === "" &&
      !playerMetrics.overflowX &&
      sourceMetrics.siteCards >= 4 &&
      renamedConfigVisible &&
      !sourceMetrics.overflowX &&
      historyMetrics.items >= 3 &&
      historyMetrics.progressBars >= 3 &&
      !historyMetrics.overflowX &&
      searchMetrics.resultCards >= 1 &&
      searchMetrics.statusChips >= 1 &&
      !searchMetrics.overflowX &&
      settingsMetrics.runtimeRows >= 1 &&
      settingsMetrics.fontMode === "extra-large" &&
      Number.parseFloat(settingsMetrics.navigationFontSize) >= 16 &&
      Number.parseFloat(settingsMetrics.helperFontSize) >= 13 &&
      !settingsMetrics.overflowX &&
      !compactMetrics.overflowX &&
      compactMetrics.heroWidth > 600 &&
      errors.length === 0,
  };

  await fs.writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
