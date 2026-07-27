import electronPath from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const provider = process.env.PAN_PROVIDER || "quark";
const root = process.cwd();
const artifactDirectory = path.join(root, "artifacts", "manual-pan-login");

if (process.env.PAN_DAEMON === "1") {
  await fs.rm(artifactDirectory, { recursive: true, force: true });
  await fs.mkdir(artifactDirectory, { recursive: true });
  const out = await fs.open(path.join(artifactDirectory, "daemon.log"), "a");
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out.fd, out.fd],
    env: {
      ...process.env,
      PAN_DAEMON: "0",
      PAN_PROVIDER: provider,
      PAN_KEEP_ALIVE_MS: process.env.PAN_KEEP_ALIVE_MS || "300000",
    },
  });
  child.unref();
  await fs.writeFile(path.join(artifactDirectory, "daemon.json"), JSON.stringify({ pid: child.pid, provider, startedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ ok: true, daemon: true, pid: child.pid, provider, artifactDirectory }, null, 2));
  process.exit(0);
}

const keepAliveMs = Math.max(0, Number(process.env.PAN_KEEP_ALIVE_MS || 0) || 0);
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-pan-login-"));
const userDataDirectory = path.join(temporaryHome, "profile");
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

await fs.mkdir(artifactDirectory, { recursive: true });

let app;
let page;
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [
      "--no-default-browser-check",
      `--user-data-dir=${userDataDirectory}`,
      path.join(root, "dist", "main", "main.js"),
    ],
    cwd: root,
    env: {
      ...process.env,
      HOME: temporaryHome,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });

  const result = await page.evaluate(async (loginProvider) => {
    const api = window.tvApi;
    if (!api?.startCatVod) throw new Error("tvApi.startCatVod 不存在");
    await api.startCatVod();
    const status = await api.getCatVodStatus();
    const statuses = api.getPanStatuses ? await api.getPanStatuses() : [];
    const started = await api.startPanLogin(loginProvider);
    return { status, statuses, started };
  }, provider);

  const dataUrl = typeof result.started?.qrImage === "string" ? result.started.qrImage : "";
  let qrFile = "";
  if (dataUrl.startsWith("data:image/")) {
    const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/i.exec(dataUrl);
    if (match) {
      const extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
      qrFile = path.join(artifactDirectory, `pan-login-${provider}.${extension}`);
      await fs.writeFile(qrFile, Buffer.from(match[2], "base64"));
    }
  }

  const summary = {
    ok: true,
    provider,
    artifactDirectory,
    qrFile,
    status: {
      state: result.status?.state,
      sourceMd5Url: result.status?.sourceMd5Url,
      port: result.status?.port,
      versionMd5: result.status?.versionMd5,
      siteCount: result.status?.siteCount,
    },
    panStatuses: result.statuses,
    login: {
      provider: result.started?.provider,
      taskId: result.started?.taskId,
      status: result.started?.status,
      terminal: result.started?.terminal,
      message: result.started?.message,
      hasQrImage: Boolean(dataUrl),
      qrImageLength: dataUrl.length,
      qrImage: dataUrl.length <= 1_000_000 ? dataUrl : "",
    },
  };
  await fs.writeFile(path.join(artifactDirectory, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (keepAliveMs > 0) {
    await fs.writeFile(path.join(artifactDirectory, "keepalive.json"), JSON.stringify({ until: new Date(Date.now() + keepAliveMs).toISOString(), provider, taskId: summary.login.taskId }, null, 2));
    await new Promise((resolve) => setTimeout(resolve, keepAliveMs));
  }
} finally {
  if (app) await app.close().catch(() => undefined);
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
