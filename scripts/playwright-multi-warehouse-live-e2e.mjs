import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const WAREHOUSE_URL = "https://gitlab.com/noimank/tvbox/-/raw/main/tvboxmuti.json";
const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root });
const artifactDirectory = path.join(root, "artifacts", "multi-warehouse-live-e2e");
const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-multi-warehouse-"));
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });

const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const consoleErrors = [];
const pageErrors = [];
let app;
let page;

async function launch() {
  const launched = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, FONGMI_MULTI_WAREHOUSE_E2E: "1" },
  });
  const window = await launched.firstWindow({ timeout: 30_000 });
  window.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  await window.waitForLoadState("domcontentloaded");
  await window.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });
  return { launched, window };
}

async function gotoSources() {
  await page.locator(".sidebar button").filter({ hasText: "播放源" }).first().click();
  await page.locator(".sources-page").waitFor({ state: "visible", timeout: 20_000 });
}

async function records() {
  return page.evaluate(() => window.tvApi.listConfigs());
}

try {
  ({ launched: app, window: page } = await launch());
  await gotoSources();
  await page.locator(".add-source-button").click();
  await page.getByPlaceholder("例如：家庭配置").fill("Noimank 多仓");
  await page.getByPlaceholder("https://example.com/config.json").fill(WAREHOUSE_URL);
  await page.locator(".source-import-drawer .primary-button").click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(async () => (await window.tvApi.listConfigs()).length >= 2, undefined, { timeout: 60_000 });

  const imported = await records();
  await gotoSources();
  await page.screenshot({ path: path.join(artifactDirectory, "01-imported-warehouse.png"), fullPage: true });

  const inactiveRows = page.locator(".simple-config-row");
  const inactiveCount = await inactiveRows.count();
  if (inactiveCount === 0) throw new Error("多仓导入后没有生成可切换的子配置");
  const targetRow = inactiveRows.first();
  const targetName = (await targetRow.locator(".simple-config-copy strong").textContent())?.trim() ?? "";
  if (!targetName) throw new Error("无法读取待切换的子配置名称");
  await targetRow.locator("button").filter({ hasText: "切换使用" }).click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(async (name) => {
    const configs = await window.tvApi.listConfigs();
    return configs.find((item) => item.enabled)?.name === name;
  }, targetName, { timeout: 60_000 });

  const afterSwitch = await records();
  await gotoSources();
  const currentNameAfterSwitch = (await page.locator(".current-source-card h2").textContent())?.trim() ?? "";
  await page.screenshot({ path: path.join(artifactDirectory, "02-after-switch.png"), fullPage: true });

  await app.close();
  app = undefined;
  page = undefined;
  ({ launched: app, window: page } = await launch());
  await gotoSources();
  const currentNameAfterRestart = (await page.locator(".current-source-card h2").textContent())?.trim() ?? "";
  const afterRestart = await records();
  await page.screenshot({ path: path.join(artifactDirectory, "03-after-restart.png"), fullPage: true });

  const names = imported.map((item) => item.name);
  const report = {
    auditedAt: new Date().toISOString(),
    warehouseUrl: WAREHOUSE_URL,
    importedCount: imported.length,
    importedNames: names,
    enabledCountAfterImport: imported.filter((item) => item.enabled).length,
    targetName,
    currentNameAfterSwitch,
    currentNameAfterRestart,
    enabledAfterSwitch: afterSwitch.find((item) => item.enabled)?.name ?? "",
    enabledAfterRestart: afterRestart.find((item) => item.enabled)?.name ?? "",
    consoleErrors,
    pageErrors,
    passed:
      imported.length >= 2
      && new Set(imported.map((item) => item.url)).size === imported.length
      && imported.filter((item) => item.enabled).length === 1
      && currentNameAfterSwitch === targetName
      && currentNameAfterRestart === targetName
      && afterRestart.find((item) => item.enabled)?.name === targetName
      && consoleErrors.length === 0
      && pageErrors.length === 0,
  };
  await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(report), "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  if (page) await page.screenshot({ path: path.join(artifactDirectory, "99-failure.png"), fullPage: true }).catch(() => undefined);
  await fs.writeFile(path.join(artifactDirectory, "failure.json"), `${JSON.stringify({
    auditedAt: new Date().toISOString(),
    warehouseUrl: WAREHOUSE_URL,
    message,
    consoleErrors,
    pageErrors,
  }, null, 2)}\n`, "utf8");
  console.error(message);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => undefined);
  await fs.rm(userDataDirectory, { recursive: true, force: true });
}

function renderMarkdown(report) {
  return `# 多仓配置 Playwright 实测报告\n\n- 地址：${report.warehouseUrl}\n- 导入成功：${report.importedCount} 个子配置\n- 导入名称：${report.importedNames.join("、")}\n- 切换目标：${report.targetName}\n- 切换后当前配置：${report.currentNameAfterSwitch}\n- 重启后当前配置：${report.currentNameAfterRestart}\n- 结果：${report.passed ? "通过" : "失败"}\n`;
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
