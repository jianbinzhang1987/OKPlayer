import fs from "node:fs/promises";
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
const artifactDirectory = path.join(root, "artifacts", "storage-recovery-e2e");
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-storage-recovery-"));
const userDataDirectory = path.join(temporaryHome, "profile");
const databasePath = path.join(userDataDirectory, "fongmi-desktop.sqlite");
const results = [];
const consoleErrors = [];
const pageErrors = [];
let app;
let page;

await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });

function record(id, title, passed, details = "") {
  results.push({ id, title, passed: Boolean(passed), details });
}

async function launchApp() {
  const launched = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: {
      ...process.env,
      HOME: temporaryHome,
      FONGMI_E2E_DISABLE_CATVOD: "1",
      ELECTRON_ENABLE_LOGGING: "1",
    },
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

try {
  ({ launched: app, window: page } = await launchApp());
  const marker = { id: "storage-recovery-e2e", savedAt: Date.now(), value: "必须恢复" };
  await page.evaluate(async ({ marker }) => {
    await window.tvApi.setSetting("storageRecoveryE2EMarker", marker);
    await window.tvApi.saveFavorite({
      siteKey: "recovery-source",
      vodId: "recovery-vod",
      vodName: "恢复收藏影片",
      vodPic: "",
      createdAt: marker.savedAt,
    });
    await window.tvApi.saveHistory({
      siteKey: "recovery-source",
      vodId: "recovery-vod",
      vodName: "恢复历史影片",
      episodeName: "第01集",
      episodeUrl: "https://media.example.com/recovery.mp4",
      flag: "恢复线路",
      position: 321,
      duration: 1800,
      updatedAt: marker.savedAt,
    });
  }, { marker });
  const beforeClose = await page.evaluate(async () => ({
    marker: await window.tvApi.getSetting("storageRecoveryE2EMarker", null),
    favorites: await window.tvApi.listFavorites(),
    history: await window.tvApi.listHistory(),
  }));
  record(
    "STORAGE-E2E-001",
    "打包应用写入设置、收藏和历史",
    beforeClose.marker?.value === marker.value
      && beforeClose.favorites.some((item) => item.vodName === "恢复收藏影片")
      && beforeClose.history.some((item) => item.vodName === "恢复历史影片" && item.position === 321),
    JSON.stringify(beforeClose),
  );

  await app.close();
  app = undefined;
  page = undefined;
  await waitForFile(databasePath, 10_000);
  const backupDirectory = `${databasePath}.backups`;
  await waitForDirectoryEntry(backupDirectory, (name) => name.endsWith(".sqlite"), 10_000);
  const backupsBeforeCorruption = await fs.readdir(backupDirectory);
  record(
    "STORAGE-E2E-002",
    "应用正常退出后生成有限数据库备份",
    backupsBeforeCorruption.some((name) => name.endsWith(".sqlite")) && backupsBeforeCorruption.length <= 3,
    JSON.stringify(backupsBeforeCorruption),
  );

  await fs.writeFile(databasePath, "intentionally corrupted sqlite database", "utf8");
  await fs.rm(`${databasePath}-wal`, { force: true });
  await fs.rm(`${databasePath}-shm`, { force: true });

  ({ launched: app, window: page } = await launchApp());
  const recovered = await page.evaluate(async () => ({
    marker: await window.tvApi.getSetting("storageRecoveryE2EMarker", null),
    recoveryNotice: await window.tvApi.getSetting("storageRecoveryNotice", null),
    favorites: await window.tvApi.listFavorites(),
    history: await window.tvApi.listHistory(),
  }));
  const archivedFiles = (await fs.readdir(userDataDirectory)).filter((name) => name.startsWith("fongmi-desktop.sqlite.corrupt-"));
  record(
    "STORAGE-E2E-003",
    "主库损坏后从最近有效备份恢复用户数据并保留损坏文件",
    recovered.marker?.value === marker.value
      && recovered.recoveryNotice?.state === "restored-backup"
      && recovered.favorites.some((item) => item.vodName === "恢复收藏影片")
      && recovered.history.some((item) => item.vodName === "恢复历史影片" && item.position === 321)
      && archivedFiles.length > 0,
    JSON.stringify({ recovered, archivedFiles }),
  );

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const notice = page.locator(".storage-recovery-notice");
  await notice.waitFor({ state: "visible", timeout: 10_000 });
  const noticeText = await notice.textContent();
  record(
    "STORAGE-E2E-004",
    "设置页向用户展示数据库恢复提示",
    noticeText?.includes("本地数据已从备份恢复") === true
      && noticeText.includes("检测到数据库损坏"),
    noticeText ?? "",
  );
  await page.screenshot({ path: path.join(artifactDirectory, "storage-recovered.png"), fullPage: true });

  record(
    "STORAGE-E2E-005",
    "数据库恢复端到端无页面和控制台错误",
    consoleErrors.length === 0 && pageErrors.length === 0,
    JSON.stringify({ consoleErrors, pageErrors }),
  );
} catch (error) {
  record("STORAGE-E2E-FATAL", "数据库恢复端到端脚本完整执行", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

const report = {
  generatedAt: new Date().toISOString(),
  executablePath,
  results,
  summary: {
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
  },
  consoleErrors,
  pageErrors,
};
await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
await fs.rm(temporaryHome, { recursive: true, force: true });
if (report.summary.failed > 0) process.exitCode = 1;

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size > 0) return;
    } catch {
      // File is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`等待文件超时：${filePath}`);
}

async function waitForDirectoryEntry(directory, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = await fs.readdir(directory);
      if (entries.some(predicate)) return;
    } catch {
      // Directory is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`等待备份目录超时：${directory}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
