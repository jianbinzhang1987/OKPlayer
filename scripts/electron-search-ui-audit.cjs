const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-dev-shm-usage");

const root = process.cwd();
const artifactDir = path.join(root, "artifacts", "search-ui-audit");
const reportPath = path.join(artifactDir, "report.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(window, expression, timeoutMs = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await window.webContents.executeJavaScript(`Boolean(${expression})`, true).catch(() => false);
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`等待页面条件超时：${expression}`);
}

async function clickExact(window, label) {
  const encoded = JSON.stringify(label);
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').trim() === ${encoded});
    if (!button) return false;
    button.click();
    return true;
  })()`, true);
  if (!clicked) throw new Error(`未找到按钮：${label}`);
  await sleep(220);
}

async function setAuditAppearance(window) {
  await clickExact(window, "设置");
  await waitFor(window, "document.querySelector('.settings-page')");
  const changed = await window.webContents.executeJavaScript(`(() => {
    const selects = [...document.querySelectorAll('.setting-row select')];
    const fontSelect = selects.find((item) => [...item.options].some((option) => option.value === 'standard'));
    const themeSelect = selects.find((item) => [...item.options].some((option) => option.value === 'dark'));
    if (!fontSelect || !themeSelect) return false;
    fontSelect.value = 'standard';
    fontSelect.dispatchEvent(new Event('input', { bubbles: true }));
    fontSelect.dispatchEvent(new Event('change', { bubbles: true }));
    themeSelect.value = 'dark';
    themeSelect.dispatchEvent(new Event('input', { bubbles: true }));
    themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, true);
  if (!changed) throw new Error("未找到字体或主题选择器");
  await sleep(260);
}

async function capture(window, name, quality = 48) {
  await sleep(320);
  const image = await window.capturePage();
  const jpegPath = path.join(artifactDir, `${name}.jpg`);
  const previewPath = path.join(artifactDir, `${name}-preview.jpg`);
  await fs.writeFile(jpegPath, image.toJPEG(quality));
  await fs.writeFile(previewPath, image.resize({ width: 960, quality: "good" }).toJPEG(42));
  return { full: jpegPath, preview: previewPath };
}

async function measureSearch(window) {
  return window.webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const value = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: Math.round(value.x),
        y: Math.round(value.y),
        width: Math.round(value.width),
        height: Math.round(value.height),
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    };
    const input = document.querySelector('.search-command-input input');
    const panel = document.querySelector('.search-command-panel');
    const suggestions = document.querySelector('.search-suggestions');
    const scopeButtons = [...document.querySelectorAll('.search-scope button')];
    const suggestionButtons = [...document.querySelectorAll('.search-suggestions button')];
    const inputRect = input?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rootClass: document.querySelector('.app-shell')?.className || '',
      header: rect('.search-header-row'),
      panel: rect('.search-command-panel'),
      inputShell: rect('.search-command-input'),
      input: rect('.search-command-input input'),
      suggestions: rect('.search-suggestions'),
      scopeButtonHeight: scopeButtons[0] ? Math.round(scopeButtons[0].getBoundingClientRect().height) : 0,
      scopeButtonFontSize: scopeButtons[0] ? getComputedStyle(scopeButtons[0]).fontSize : '',
      suggestionButtonHeight: suggestionButtons[0] ? Math.round(suggestionButtons[0].getBoundingClientRect().height) : 0,
      suggestionButtonFontSize: suggestionButtons[0] ? getComputedStyle(suggestionButtons[0]).fontSize : '',
      strongFontSize: document.querySelector('.search-suggestions strong') ? getComputedStyle(document.querySelector('.search-suggestions strong')).fontSize : '',
      horizontalFillRatio: inputRect && panelRect ? Number((inputRect.width / panelRect.width).toFixed(3)) : 0,
      clipped: input instanceof HTMLElement ? input.scrollWidth > input.clientWidth + 1 || input.scrollHeight > input.clientHeight + 1 : null,
      overlap: Boolean(panel && suggestions && panel.getBoundingClientRect().bottom < suggestions.getBoundingClientRect().bottom),
    };
  })()`, true);
}

async function measureSources(window) {
  return window.webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const value = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: Math.round(value.x),
        y: Math.round(value.y),
        width: Math.round(value.width),
        height: Math.round(value.height),
        fontSize: style.fontSize,
      };
    };
    const tab = document.querySelector('.quick-source-tabs button');
    const cardTitle = document.querySelector('.quick-source-card-copy strong');
    const cardMeta = document.querySelector('.quick-source-card-copy small');
    const state = document.querySelector('.quick-source-state');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      search: rect('.quick-source-search'),
      searchInput: rect('.quick-source-search input'),
      tabHeight: tab ? Math.round(tab.getBoundingClientRect().height) : 0,
      tabFontSize: tab ? getComputedStyle(tab).fontSize : '',
      cardsVisible: [...document.querySelectorAll('.quick-source-card')].filter((item) => item.getBoundingClientRect().height > 0).length,
      cardTitleFontSize: cardTitle ? getComputedStyle(cardTitle).fontSize : '',
      cardMetaFontSize: cardMeta ? getComputedStyle(cardMeta).fontSize : '',
      stateFontSize: state ? getComputedStyle(state).fontSize : '',
    };
  })()`, true);
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
    width: 1600,
    height: 900,
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
    await setAuditAppearance(window);

    await clickExact(window, "搜索");
    await waitFor(window, "document.querySelector('.search-command-input')");
    const search = await measureSearch(window);
    const searchScreenshot = await capture(window, "01-search-standard-1600x900");

    await clickExact(window, "内容来源");
    await waitFor(window, "document.querySelector('.quick-source-search')");
    const sources = await measureSources(window);
    const sourceScreenshot = await capture(window, "02-sources-standard-1600x900");

    const passed =
      search.rootClass.includes('font-standard') &&
      !search.documentOverflowX &&
      Number.parseFloat(search.input?.fontSize || '0') >= 17 &&
      (search.inputShell?.height || 0) >= 64 &&
      (search.inputShell?.width || 0) >= 1000 &&
      search.scopeButtonHeight >= 40 &&
      Number.parseFloat(search.scopeButtonFontSize || '0') >= 13 &&
      search.suggestionButtonHeight >= 34 &&
      Number.parseFloat(search.suggestionButtonFontSize || '0') >= 12 &&
      !search.clipped &&
      !sources.documentOverflowX &&
      (sources.search?.width || 0) >= 700 &&
      (sources.search?.height || 0) >= 50 &&
      Number.parseFloat(sources.searchInput?.fontSize || '0') >= 15 &&
      sources.tabHeight >= 36 &&
      Number.parseFloat(sources.tabFontSize || '0') >= 12 &&
      consoleErrors.length === 0;

    const report = {
      auditedAt: new Date().toISOString(),
      mode: "standard-dark",
      viewport: "1600x900",
      search,
      sources,
      screenshots: { search: searchScreenshot, sources: sourceScreenshot },
      consoleErrors,
      passed,
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (!passed) process.exitCode = 1;
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
