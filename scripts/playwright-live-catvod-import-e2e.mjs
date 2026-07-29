import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const sourceUrl = process.env.FONGMI_LIVE_CATVOD_URL?.trim();
if (!sourceUrl) throw new Error("请通过 FONGMI_LIVE_CATVOD_URL 提供待验证的 index.js.md5 地址");

const parsedSource = new URL(sourceUrl);
const expectedHost = parsedSource.hostname;
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root });
const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-live-catvod-"));
const artifactDirectory = path.join(root, "artifacts", "live-catvod-import-e2e");
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });

let app;
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: {
      ...process.env,
      FONGMI_E2E_DISABLE_CATVOD: "1",
    },
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });

  await page.getByRole("button", { name: "内容来源", exact: true }).click();
  await page.locator(".quick-source-page").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByPlaceholder("粘贴配置地址后按回车即可导入").fill(sourceUrl);
  await page.getByRole("button", { name: "导入并使用", exact: true }).click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 90_000 });

  await page.waitForFunction(async () => {
    const defaultSite = await window.tvApi.getSetting("defaultSite", "");
    const status = await window.tvApi.getCatVodStatus();
    return typeof defaultSite === "string" && defaultSite.startsWith("catvod:") && status?.state === "running";
  }, undefined, { timeout: 90_000 });

  const beforePicker = await page.evaluate(async () => ({
    defaultSite: await window.tvApi.getSetting("defaultSite", ""),
    status: await window.tvApi.getCatVodStatus(),
    sites: await window.tvApi.listSites(),
  }));
  const currentSourceName = (await page.locator(".source-picker-trigger-copy strong").textContent())?.trim() ?? "";
  const packageCopy = (await page.locator(".source-picker-trigger-copy small").textContent())?.trim() ?? "";

  await page.getByRole("button", { name: "选择播放源" }).click();
  await page.locator(".source-picker-panel").waitFor({ state: "visible", timeout: 10_000 });
  const pickerNames = await page.locator(".source-picker-item-copy strong").allTextContents();
  const catVodVisibleNames = beforePicker.sites
    .filter((site) => site.key?.startsWith("catvod:")
      && site.supported
      && site.hide !== 1
      && !["tool", "live", "comic", "audio", "discovery"].includes(site.contentType ?? ""))
    .map((site) => site.name);
  const ordinaryVisibleNames = new Set(beforePicker.sites
    .filter((site) => !site.key?.startsWith("catvod:") && site.supported && site.hide !== 1)
    .map((site) => site.name));
  const pickerContainsOrdinaryOnlyName = pickerNames.some((name) => ordinaryVisibleNames.has(name) && !catVodVisibleNames.includes(name));

  await page.screenshot({ path: path.join(artifactDirectory, "live-catvod-import.png"), fullPage: true });

  const report = {
    ok: beforePicker.defaultSite.startsWith("catvod:")
      && beforePicker.status?.state === "running"
      && beforePicker.status?.sourceMd5Url?.includes(expectedHost)
      && packageCopy.includes(expectedHost)
      && currentSourceName.length > 0
      && pickerNames.length > 0
      && !pickerContainsOrdinaryOnlyName,
    sourceHost: expectedHost,
    defaultSite: beforePicker.defaultSite,
    currentSourceName,
    packageCopy,
    catVodVisibleCount: catVodVisibleNames.length,
    pickerItemCount: pickerNames.length,
    pickerContainsOrdinaryOnlyName,
    screenshot: path.join(artifactDirectory, "live-catvod-import.png"),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await fs.rm(userDataDirectory, { recursive: true, force: true });
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
