const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-dev-shm-usage");

const root = process.cwd();
const artifactDir = path.join(root, "artifacts", "font-audit");
const reportPath = path.join(artifactDir, "report.json");

function auditScript() {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const fontSize = (selector) => {
    const element = document.querySelector(selector);
    return element instanceof HTMLElement ? getComputedStyle(element).fontSize : "";
  };
  const clipped = (selector) => [...document.querySelectorAll(selector)]
    .filter(visible)
    .filter((element) => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)
    .map((element) => ({
      selector,
      text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 100),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
  const criticalSelectors = [
    ".primary-nav button",
    ".secondary-nav button",
    ".topbar-search input",
    ".source-switcher",
    ".primary-button",
    ".secondary-button",
    ".settings-card-heading h2",
    ".settings-card-heading p",
    ".setting-row strong",
    ".setting-row span",
    ".setting-row select",
    ".runtime-list span",
    ".runtime-list strong",
    ".detail-summary",
    ".detail-credits p",
    ".episode-grid button",
  ];
  const clipping = criticalSelectors.flatMap(clipped);
  const rootElement = document.querySelector(".app-shell");
  return {
    pageTitle: document.querySelector(".page-heading strong")?.textContent?.trim() || "",
    rootClass: rootElement?.className || "",
    viewport: { width: innerWidth, height: innerHeight },
    document: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    },
    fonts: {
      nav: fontSize(".primary-nav button"),
      sidebarStatus: fontSize(".sidebar-status strong"),
      pageTitle: fontSize(".page-title-row h1"),
      sectionTitle: fontSize(".section-heading h2"),
      posterTitle: fontSize(".poster-card > strong"),
      posterMeta: fontSize(".poster-card > span"),
      button: fontSize(".primary-button"),
      settingsTitle: fontSize(".setting-row strong"),
      settingsDescription: fontSize(".setting-row span"),
      detailSummary: fontSize(".detail-summary"),
    },
    clipping,
    criticalClippingCount: clipping.length,
  };
}

async function waitFor(window, expression, timeoutMs = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await window.webContents.executeJavaScript(`Boolean(${expression})`, true).catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待页面条件超时：${expression}`);
}

async function clickButton(window, label) {
  const encoded = JSON.stringify(label);
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').trim() === ${encoded});
    if (!button) return false;
    button.click();
    return true;
  })()`, true);
  if (!clicked) throw new Error(`未找到按钮：${label}`);
  await new Promise((resolve) => setTimeout(resolve, 180));
}

async function setFontSize(window, mode) {
  await clickButton(window, "设置");
  await waitFor(window, "document.querySelector('.settings-page')");
  const changed = await window.webContents.executeJavaScript(`(() => {
    const select = [...document.querySelectorAll('.setting-row select')].find((item) => [...item.options].some((option) => option.value === 'extra-large'));
    if (!select) return false;
    select.value = ${JSON.stringify(mode)};
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, true);
  if (!changed) throw new Error("未找到字体大小选择器");
  await new Promise((resolve) => setTimeout(resolve, 160));
}

async function capture(window, name) {
  await new Promise((resolve) => setTimeout(resolve, 220));
  const image = await window.capturePage();
  await fs.writeFile(path.join(artifactDir, `${name}.png`), image.toPNG());
  return window.webContents.executeJavaScript(`(${auditScript.toString()})()`, true);
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.rm(reportPath, { force: true });
  await app.whenReady();

  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.join(root, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 4179, strictPort: false },
    clearScreen: false,
    logLevel: "error",
  });
  await vite.listen();
  const baseUrl = vite.resolvedUrls?.local?.[0] || "http://127.0.0.1:4179/";

  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: "#0a0c10",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const consoleErrors = [];
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  try {
    await window.loadURL(`${baseUrl}?preview=1`);
    await waitFor(window, "document.querySelector('.hero')");

    const report = { auditedAt: new Date().toISOString(), consoleErrors, views: {} };
    report.views.standardHome = await capture(window, "01-standard-home");

    await setFontSize(window, "large");
    await clickButton(window, "首页");
    await waitFor(window, "document.querySelector('.hero')");
    report.views.largeHome = await capture(window, "02-large-home");

    await setFontSize(window, "extra-large");
    window.setContentSize(1040, 680);
    await clickButton(window, "首页");
    await waitFor(window, "document.querySelector('.hero')");
    report.views.extraLargeHome = await capture(window, "03-extra-large-home-1040x680");

    const openedDetail = await window.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.poster-card');
      if (!card) return false;
      card.click();
      return true;
    })()`, true);
    if (!openedDetail) throw new Error("首页没有可用于详情验证的影片卡片");
    await waitFor(window, "document.querySelector('.detail-page')");
    report.views.extraLargeDetail = await capture(window, "04-extra-large-detail-1040x680");

    await clickButton(window, "设置");
    await waitFor(window, "document.querySelector('.settings-page')");
    report.views.extraLargeSettings = await capture(window, "05-extra-large-settings-1040x680");

    const requiredViews = Object.values(report.views);
    report.passed = requiredViews.every((view) => !view.document.overflowX && view.criticalClippingCount === 0)
      && consoleErrors.length === 0;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    window.destroy();
    await vite.close();
    app.quit();
  }
}

main().catch(async (error) => {
  await fs.mkdir(artifactDir, { recursive: true }).catch(() => undefined);
  await fs.writeFile(reportPath, `${JSON.stringify({ passed: false, error: error instanceof Error ? error.stack : String(error) }, null, 2)}\n`, "utf8").catch(() => undefined);
  console.error(error);
  app.exit(1);
});
