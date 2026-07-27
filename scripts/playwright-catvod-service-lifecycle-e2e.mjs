import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const executablePath = resolvePackagedExecutable({ root, explicit: process.env.FONGMI_APP_EXECUTABLE });
const artifactDirectory = path.join(root, "artifacts", "catvod-service-lifecycle");
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-catvod-lifecycle-"));
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });
const hostFixture = await startHostBridgeFixtureServer();

let app;
let page;
let finalBaseUrl = "";
let realSourceMd5Url = "";
const results = [];
const record = (id, title, passed, details) => results.push({ id, title, passed, details });

try {
  ({ app, page } = await launchLifecycleApplication());

  const initial = await waitForState(page, "running", 90_000);
  realSourceMd5Url = String(initial.sourceMd5Url ?? "");
  const initialSites = await page.evaluate(() => window.tvApi.listSites());
  record(
    "LIFE-001",
    "应用启动后 CatVod 服务进入 running",
    Boolean(initial.baseUrl) && Number(initial.siteCount ?? 0) > 0 && initialSites.some((site) => String(site.key).startsWith("catvod:")),
    JSON.stringify({ status: initial, siteCount: initialSites.length }),
  );

  const restarted = await page.evaluate(() => window.tvApi.restartCatVod("allow"));
  const restartedStatus = await waitForState(page, "running", 60_000);
  record(
    "LIFE-002",
    "CatVod 服务可重启并重新注册动态站点",
    restarted?.state === "running" && restartedStatus.state === "running" && Number(restartedStatus.siteCount ?? 0) > 0,
    JSON.stringify({ restarted, restartedStatus }),
  );

  const stopped = await page.evaluate(() => window.tvApi.stopCatVod());
  const stoppedStatus = await waitForState(page, "stopped", 15_000);
  const sitesAfterStop = await page.evaluate(() => window.tvApi.listSites());
  record(
    "LIFE-003",
    "停止服务后动态站点被清理",
    stopped?.state === "stopped" && stoppedStatus.state === "stopped" && !sitesAfterStop.some((site) => String(site.key).startsWith("catvod:")),
    JSON.stringify({ stopped, stoppedStatus, siteCount: sitesAfterStop.length }),
  );

  await page.evaluate(({ source }) => window.tvApi.startCatVod(source, "allow"), { source: realSourceMd5Url });
  const allowedAuditStatus = await waitForAnyRemoteAudit(page, false, 30_000);
  const allowedOrigins = allowedAuditStatus.remoteAccesses
    .filter((item) => item.blocked === false)
    .map((item) => item.origin);
  const originsAreSanitized = allowedOrigins.length > 0 && allowedOrigins.every((origin) => {
    try {
      return new URL(origin).origin === origin && !/[?#]/.test(origin);
    } catch {
      return false;
    }
  });
  record(
    "LIFE-004",
    "允许模式记录真实 CatVod 启动阶段远程域名",
    allowedAuditStatus.remoteAccessPolicy === "allow" && originsAreSanitized,
    JSON.stringify({ policy: allowedAuditStatus.remoteAccessPolicy, origins: allowedOrigins }),
  );

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const advancedToggle = page.getByRole("button", { name: "展开高级设置", exact: true });
  if (await advancedToggle.isVisible().catch(() => false)) await advancedToggle.click();
  await page.locator(".catvod-remote-audit").waitFor({ state: "visible", timeout: 10_000 });
  const renderedOrigins = await page.locator(".catvod-remote-audit-list strong").allTextContents();
  record(
    "LIFE-005",
    "设置页只展示远程 origin",
    renderedOrigins.length > 0
      && renderedOrigins.every((origin) => allowedOrigins.includes(origin.trim()))
      && renderedOrigins.every((origin) => !/[?#]/.test(origin)),
    JSON.stringify({ renderedOrigins, allowedOrigins }),
  );
  await page.evaluate(() => window.tvApi.stopCatVod());
  await waitForState(page, "stopped", 15_000);

  const blockAttempt = await page.evaluate(async ({ source }) => {
    try {
      const result = await window.tvApi.startCatVod(source, "block-startup");
      return { ok: true, result, status: await window.tvApi.getCatVodStatus() };
    } catch (error) {
      return { ok: false, error: String(error), status: await window.tvApi.getCatVodStatus() };
    }
  }, { source: realSourceMd5Url });
  const blockedAuditStatus = await waitForAnyRemoteAudit(page, true, 60_000);
  record(
    "LIFE-006",
    "阻止模式阻断并记录真实启动阶段远程访问",
    blockedAuditStatus.remoteAccessPolicy === "block-startup"
      && blockedAuditStatus.remoteAccesses.some((item) => item.blocked === true)
      && blockedAuditStatus.remoteAccesses.every((item) => !/[?#]/.test(item.origin)),
    JSON.stringify({ blockAttempt, blockedAuditStatus }),
  );
  await page.evaluate(async () => {
    try { await window.tvApi.stopCatVod(); } catch { /* service may already be in error */ }
  });
  await waitForState(page, "stopped", 15_000);

  const hostStarted = await page.evaluate(({ source }) => window.tvApi.startCatVod(source, "allow"), { source: hostFixture.md5Url });
  const hostStatus = await waitForState(page, "running", 30_000);
  const firstHostResult = await waitForHostResult(String(hostStatus.baseUrl ?? ""), 10_000);
  await page.getByText("HOST_BRIDGE_TOAST", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const bridgeSnapshot = await page.evaluate(async () => {
    let rendererProfileAccessBlocked = false;
    try {
      await window.tvApi.getSetting("catVodProfile", {});
    } catch {
      rendererProfileAccessBlocked = true;
    }
    return {
      rendererProfileAccessBlocked,
      siteNames: (await window.tvApi.listSites()).map((site) => site.name),
      bodyText: document.body.innerText,
    };
  });
  record(
    "BRIDGE-001",
    "宿主桥完成 saveProfile、queryProfile、toast 和 danmuPush 往返",
    hostStarted?.state === "running"
      && isFixtureProfile(firstHostResult.queried, hostFixture.profile)
      && bridgeSnapshot.rendererProfileAccessBlocked
      && firstHostResult.saved?.ok === true
      && firstHostResult.toast?.ok === true
      && firstHostResult.danmu?.ok === true
      && bridgeSnapshot.siteNames.some((name) => name.includes("宿主桥|bridge-ok"))
      && bridgeSnapshot.bodyText.includes("CatVod 已推送弹幕信息"),
    JSON.stringify({
      state: hostStatus.state,
      sourceMd5Url: hostStatus.sourceMd5Url,
      profileSaved: firstHostResult.saved?.ok === true,
      markerQueried: isFixtureProfile(firstHostResult.queried, hostFixture.profile),
      rendererProfileAccessBlocked: bridgeSnapshot.rendererProfileAccessBlocked,
      toastOk: firstHostResult.toast?.ok === true,
      danmuOk: firstHostResult.danmu?.ok === true,
      fixtureSiteVisible: bridgeSnapshot.siteNames.some((name) => name.includes("宿主桥|bridge-ok")),
      danmuNoticeVisible: bridgeSnapshot.bodyText.includes("CatVod 已推送弹幕信息"),
    }),
  );

  const sqlitePath = path.join(temporaryHome, "profile", "fongmi-desktop.sqlite");
  const sqliteWalPath = `${sqlitePath}-wal`;
  const profileKeyPath = path.join(temporaryHome, "profile", "catvod-profile.key");
  const sqliteBytes = await fs.readFile(sqlitePath);
  const sqliteWalBytes = await fs.readFile(sqliteWalPath).catch(() => Buffer.alloc(0));
  const sqliteRaw = Buffer.concat([sqliteBytes, sqliteWalBytes]).toString("latin1");
  const profileKeyStat = await fs.stat(profileKeyPath).catch(() => undefined);
  const fallbackKeyProtected = !profileKeyStat || (profileKeyStat.mode & 0o777) === 0o600;
  record(
    "BRIDGE-001A",
    "CatVod Profile 在 SQLite 主库或 WAL 中仅保存受保护密文",
    sqliteRaw.includes("catVodProfileEncryptedV1")
      && !sqliteRaw.includes(hostFixture.profile.credentialMarker)
      && fallbackKeyProtected,
    JSON.stringify({
      sqlitePath,
      sqliteWalPath,
      encryptedSettingPresent: sqliteRaw.includes("catVodProfileEncryptedV1"),
      plaintextMarkerAbsent: !sqliteRaw.includes(hostFixture.profile.credentialMarker),
      storageMode: profileKeyStat ? "local-aes-gcm" : "native-safe-storage",
      fallbackKeyMode: profileKeyStat ? (profileKeyStat.mode & 0o777).toString(8) : "not-created",
      bytes: sqliteBytes.length + sqliteWalBytes.length,
    }),
  );

  const hostRestarted = await page.evaluate(() => window.tvApi.restartCatVod("allow"));
  const hostRestartedStatus = await waitForState(page, "running", 30_000);
  const secondHostResult = await waitForHostResult(String(hostRestartedStatus.baseUrl ?? ""), 10_000);
  record(
    "BRIDGE-002",
    "CatVod 服务重启后 queryProfile 恢复已保存 Profile",
    hostRestarted?.state === "running"
      && isFixtureProfile(secondHostResult.initial, hostFixture.profile)
      && isFixtureProfile(secondHostResult.queried, hostFixture.profile)
      && secondHostResult.saved?.skipped === true,
    JSON.stringify({
      state: hostRestartedStatus.state,
      markerInInitialProfile: isFixtureProfile(secondHostResult.initial, hostFixture.profile),
      markerInQueriedProfile: isFixtureProfile(secondHostResult.queried, hostFixture.profile),
      saveSkipped: secondHostResult.saved?.skipped === true,
    }),
  );

  const fixtureBaseUrlBeforeAppRestart = String(hostRestartedStatus.baseUrl ?? "");
  await app.close();
  app = undefined;
  page = undefined;
  await delay(1_000);
  const fixtureClosedWithApp = await isUnavailable(`${fixtureBaseUrlBeforeAppRestart.replace(/\/$/, "")}/health`);
  ({ app, page } = await launchLifecycleApplication());
  const appRestartStatus = await waitForState(page, "running", 60_000);
  const thirdHostResult = await waitForHostResult(String(appRestartStatus.baseUrl ?? ""), 10_000);
  record(
    "BRIDGE-003",
    "应用重启后 SQLite Profile 通过宿主桥恢复",
    fixtureClosedWithApp
      && appRestartStatus.sourceMd5Url === hostFixture.md5Url
      && isFixtureProfile(thirdHostResult.initial, hostFixture.profile)
      && isFixtureProfile(thirdHostResult.queried, hostFixture.profile),
    JSON.stringify({
      fixtureClosedWithApp,
      state: appRestartStatus.state,
      sourceRestored: appRestartStatus.sourceMd5Url === hostFixture.md5Url,
      markerInInitialProfile: isFixtureProfile(thirdHostResult.initial, hostFixture.profile),
      markerInQueriedProfile: isFixtureProfile(thirdHostResult.queried, hostFixture.profile),
    }),
  );

  await page.evaluate(() => window.tvApi.stopCatVod());
  await waitForState(page, "stopped", 15_000);

  const startedAgain = await page.evaluate(({ source }) => window.tvApi.startCatVod(source, "allow"), { source: realSourceMd5Url });
  const finalStatus = await waitForState(page, "running", 90_000);
  finalBaseUrl = String(finalStatus.baseUrl ?? "");
  record(
    "LIFE-007",
    "审计策略测试后可恢复真实 CatVod 服务",
    startedAgain?.state === "running" && finalStatus.state === "running" && Number(finalStatus.siteCount ?? 0) > 0,
    JSON.stringify({ startedAgain, finalStatus }),
  );

  const mainPid = app.process().pid;
  const utilityProcessInfo = findCatVodUtilityProcess(mainPid);
  if (!utilityProcessInfo) throw new Error(`未找到 CatVod Utility Process，主进程 PID=${mainPid}`);
  process.kill(utilityProcessInfo.pid, "SIGKILL");
  const recoveredStatus = await waitForRestart(page, Number(finalStatus.startedAt ?? 0), 60_000);
  const recoveredSites = await page.evaluate(() => window.tvApi.listSites());
  finalBaseUrl = String(recoveredStatus.baseUrl ?? finalBaseUrl);
  record(
    "LIFE-008",
    "CatVod Utility Process 异常退出后自动重启一次",
    recoveredStatus.state === "running"
      && Number(recoveredStatus.startedAt ?? 0) > Number(finalStatus.startedAt ?? 0)
      && Number(recoveredStatus.siteCount ?? 0) > 0
      && recoveredSites.some((site) => String(site.key).startsWith("catvod:")),
    JSON.stringify({ mainPid, utilityProcessInfo, finalStatus, recoveredStatus, siteCount: recoveredSites.length }),
  );

  const serviceLogPath = await page.evaluate(() => window.tvApi.getCatVodLogPath());
  const archivedLogPath = path.join(artifactDirectory, "service.log");
  await fs.copyFile(serviceLogPath, archivedLogPath);
  const archivedLogStat = await fs.stat(archivedLogPath);
  record(
    "LIFE-008A",
    "真实 CatVod 服务日志已归档供安全审计",
    archivedLogStat.size > 0,
    JSON.stringify({ serviceLogPath, archivedLogPath, bytes: archivedLogStat.size }),
  );

  await page.screenshot({ path: path.join(artifactDirectory, "01-running-after-restart.png"), fullPage: true });
} catch (error) {
  record("HARNESS", "生命周期自动化执行", false, error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await page.screenshot({ path: path.join(artifactDirectory, "99-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  if (app) await app.close().catch(() => undefined);
  await hostFixture.close().catch(() => undefined);
}

if (finalBaseUrl) {
  await delay(1_500);
  const closed = await isUnavailable(`${finalBaseUrl.replace(/\/$/, "")}/health`);
  record("LIFE-009", "应用退出后 CatVod 端口不可访问", closed, finalBaseUrl);
}

const failed = results.filter((item) => !item.passed);
const report = {
  executedAt: new Date().toISOString(),
  executablePath,
  summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
};
await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(report), "utf8");
await fs.rm(temporaryHome, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;

async function launchLifecycleApplication() {
  const launched = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${path.join(temporaryHome, "profile")}`],
    cwd: root,
    env: {
      ...process.env,
      HOME: temporaryHome,
      FONGMI_DISABLE_CATVOD_AUTO_START: "0",
    },
  });
  const window = await launched.firstWindow({ timeout: 30_000 });
  await window.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });
  return { app: launched, page: window };
}

async function waitForHostResult(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/host-result`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        last = await response.json();
        if (last && typeof last === "object" && last.queried) return last;
      }
    } catch { /* fixture may still be starting */ }
    await delay(150);
  }
  throw new Error(`等待宿主桥结果超时：${JSON.stringify(last)}`);
}

function isFixtureProfile(value, expected) {
  const marker = value?.__hostBridgeFixture;
  return Boolean(marker)
    && marker.fixtureUser === expected.fixtureUser
    && marker.preference === expected.preference
    && marker.credentialMarker === expected.credentialMarker;
}

async function waitForRestart(page, previousStartedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.tvApi.getCatVodStatus());
    if (last?.state === "running" && Number(last.startedAt ?? 0) > previousStartedAt) return last;
    if (last?.state === "error") throw new Error(last.message ?? "CatVod 自动重启失败");
    await delay(300);
  }
  throw new Error(`等待 CatVod 自动重启超时：${JSON.stringify(last)}`);
}

function findCatVodUtilityProcess(mainPid) {
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    const rows = output.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
    }).filter(Boolean);
    const descendants = new Set([mainPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          changed = true;
        }
      }
    }
    return rows.find((row) => descendants.has(row.pid)
      && (/catvod-bootstrap/i.test(row.command) || /utility-sub-type=node\.mojom\.NodeService/i.test(row.command)));
  } catch {
    return undefined;
  }
}

async function waitForState(page, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.tvApi.getCatVodStatus());
    if (last?.state === expected) return last;
    if (last?.state === "error") throw new Error(last.message ?? "CatVod 服务失败");
    await delay(300);
  }
  throw new Error(`等待 CatVod 状态 ${expected} 超时：${JSON.stringify(last)}`);
}

async function waitForAnyRemoteAudit(page, blocked, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.tvApi.getCatVodStatus());
    const accesses = Array.isArray(last?.remoteAccesses) ? last.remoteAccesses : [];
    if (accesses.some((item) => item.blocked === blocked)) return last;
    if (last?.state === "error" && blocked === false) throw new Error(last.message ?? "CatVod 远程访问审计失败");
    await delay(200);
  }
  throw new Error(`等待远程访问审计超时：${JSON.stringify(last)}`);
}

async function isUnavailable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return false;
  } catch {
    return true;
  }
}

function renderMarkdown(report) {
  const rows = report.results.map((item) => `| ${item.id} | ${item.passed ? "通过" : "失败"} | ${item.title} | ${String(item.details).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 500)} |`);
  return `# CatVod 服务生命周期 E2E 报告\n\n- 时间：${report.executedAt}\n- 总计：${report.summary.total}\n- 通过：${report.summary.passed}\n- 失败：${report.summary.failed}\n\n| 用例 | 结果 | 场景 | 详情 |\n|---|---|---|---|\n${rows.join("\n")}\n`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startHostBridgeFixtureServer() {
  const profile = {
    fixtureUser: "bridge-ok",
    preference: "demo",
    credentialMarker: "catvod-profile-secret-7f8a2c",
  };
  const script = `const http = require("node:http");
let server;
let hostResult = {};
async function sendHost(payload) {
  const bridgePort = globalThis.catDartServerPort();
  const response = await fetch("http://127.0.0.1:" + bridgePort + "/msg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}
exports.start = async function start() {
  const initial = await sendHost({ action: "queryProfile" });
  const currentMarker = initial && initial.__hostBridgeFixture;
  const shouldSave = !currentMarker || currentMarker.fixtureUser !== ${JSON.stringify(profile.fixtureUser)};
  const mergedProfile = { ...(initial || {}), __hostBridgeFixture: ${JSON.stringify(profile)} };
  const saved = shouldSave
    ? await sendHost({ action: "saveProfile", opt: mergedProfile })
    : { ok: true, skipped: true };
  const queried = await sendHost({ action: "queryProfile" });
  const toast = await sendHost({ action: "toast", opt: { message: "HOST_BRIDGE_TOAST", duration: 30 } });
  const danmu = await sendHost({ action: "danmuPush", opt: { source: "host-bridge-fixture" } });
  hostResult = { initial, saved, queried, toast, danmu };
  await new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/health") response.end(JSON.stringify({ ok: true }));
      else if (request.url === "/config") response.end(JSON.stringify({ video: { sites: [{ key: "host_fixture", name: "宿主桥|" + String(queried.__hostBridgeFixture?.fixtureUser || "unknown"), type: 15, api: "/spider/host_fixture" }] } }));
      else if (request.url === "/host-result") response.end(JSON.stringify(hostResult));
      else response.end(JSON.stringify({ code: 404 }));
    });
    server.once("error", reject);
    server.listen(Number(process.env.PORT), process.env.HOST || "127.0.0.1", resolve);
  });
};
exports.stop = async function stop() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = undefined;
};
`;
  const md5 = createHash("md5").update(script).digest("hex");
  let origin = "";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    if (url.pathname === "/host.js.md5") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(md5);
      return;
    }
    if (url.pathname === "/host.js") {
      response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(script);
      return;
    }
    response.writeHead(404).end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("宿主桥 Fixture 启动失败");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    md5Url: `${origin}/host.js.md5`,
    profile,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
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
