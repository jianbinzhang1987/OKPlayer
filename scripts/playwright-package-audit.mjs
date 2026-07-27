import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const playwrightModule = process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright";
const playwright = await import(playwrightModule);
const electron = playwright._electron ?? playwright.default?._electron;
if (!electron) throw new Error("当前 Playwright 模块未导出 Electron 启动器");

const executablePath = process.env.FONGMI_APP_EXECUTABLE;
if (!executablePath) throw new Error("缺少 FONGMI_APP_EXECUTABLE");

const artifactDir = path.resolve("artifacts", "package-audit");
await fs.mkdir(artifactDir, { recursive: true });
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-package-audit-"));
const errors = [];
const warnings = [];

const app = await electron.launch({
  executablePath,
  args: ["--no-default-browser-check", `--user-data-dir=${path.join(temporaryHome, "profile")}`],
  env: {
    ...process.env,
    HOME: temporaryHome,
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

try {
  const window = await app.firstWindow({ timeout: 20_000 });
  window.on("console", (message) => {
    const text = `${message.type()}: ${message.text()}`;
    if (message.type() === "error") errors.push(text);
    if (message.type() === "warning") warnings.push(text);
  });
  window.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await window.waitForLoadState("domcontentloaded");
  await window.locator(".app-shell").waitFor({ state: "visible", timeout: 20_000 });
  await window.waitForTimeout(800);

  const renderer = await window.evaluate(() => ({
    title: document.title,
    bodyText: document.body.innerText.slice(0, 500),
    viewport: { width: innerWidth, height: innerHeight },
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    appShell: document.querySelector(".app-shell") !== null,
    sidebar: document.querySelector(".sidebar") !== null,
    topbar: document.querySelector(".topbar") !== null,
    remoteScript: [...document.scripts].some((script) => /^https?:/i.test(script.src)),
  }));

  const runtime = await app.evaluate(({ app }) => ({
    appName: app.getName(),
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    arch: process.arch,
    platform: process.platform,
  }));

  await window.screenshot({ path: path.join(artifactDir, "packaged-app.png"), fullPage: true });

  const report = {
    auditedAt: new Date().toISOString(),
    executablePath,
    runtime,
    renderer,
    consoleErrors: errors,
    consoleWarnings: warnings,
    passed:
      runtime.electron === "43.2.0"
      && runtime.appVersion === "0.1.0"
      && renderer.appShell
      && renderer.sidebar
      && renderer.topbar
      && !renderer.overflowX
      && !renderer.remoteScript
      && errors.length === 0,
  };

  await fs.writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await app.close();
  await fs.rm(temporaryHome, { recursive: true, force: true });
}
