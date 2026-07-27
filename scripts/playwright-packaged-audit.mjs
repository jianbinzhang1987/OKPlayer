import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const playwrightModule = process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright";
const loadedPlaywright = await import(playwrightModule);
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root });
const artifactDirectory = path.join(root, "artifacts", "release-audit");
const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-packaged-audit-"));
await fs.mkdir(artifactDirectory, { recursive: true });

const errors = [];
const warnings = [];
const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataDirectory}`],
  cwd: root,
  env: { ...process.env, FONGMI_RELEASE_AUDIT: "1" },
});

try {
  const page = await app.firstWindow({ timeout: 20_000 });
  page.on("console", (message) => {
    const entry = `${message.type()}: ${message.text()}`;
    if (message.type() === "error") errors.push(entry);
    if (message.type() === "warning") warnings.push(entry);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);

  const metrics = await page.evaluate(() => ({
    title: document.title,
    sidebarVisible: Boolean(document.querySelector(".sidebar")),
    topbarVisible: Boolean(document.querySelector(".topbar")),
    emptyStateVisible: Boolean(document.querySelector(".hero-empty")),
    bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    preloadApiFunctions: typeof window.tvApi === "object"
      ? ["listConfigs", "listSites", "preparePlayback", "onPlayerState"].filter((name) => typeof window.tvApi[name] === "function")
      : [],
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }));

  await page.screenshot({ path: path.join(artifactDirectory, "packaged-home.png"), fullPage: true });
  const report = {
    auditedAt: new Date().toISOString(),
    executablePath,
    metrics,
    consoleErrors: errors,
    consoleWarnings: warnings,
    passed:
      metrics.title === "FongMi Desktop"
      && metrics.sidebarVisible
      && metrics.topbarVisible
      && metrics.preloadApiFunctions.length === 4
      && !metrics.bodyOverflowX
      && errors.length === 0,
  };
  await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await app.close();
  await fs.rm(userDataDirectory, { recursive: true, force: true });
}
