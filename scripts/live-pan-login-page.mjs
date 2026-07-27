import electronPath from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const provider = process.env.PAN_PROVIDER || "quark";
const root = process.cwd();
const artifactDirectory = path.join(root, "artifacts", "live-pan-login");
const stateFile = path.join(artifactDirectory, "state.json");
const logFile = path.join(artifactDirectory, "daemon.log");
const port = Number(process.env.PAN_LIVE_PORT || 17981);
const refreshMs = Math.max(20_000, Number(process.env.PAN_REFRESH_MS || 35_000) || 35_000);

if (process.env.PAN_BG === "1") {
  await fs.rm(artifactDirectory, { recursive: true, force: true });
  await fs.mkdir(artifactDirectory, { recursive: true });
  const out = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out.fd, out.fd],
    env: {
      ...process.env,
      PAN_BG: "0",
      PAN_PROVIDER: provider,
      PAN_LIVE_PORT: String(port),
      PAN_REFRESH_MS: String(refreshMs),
    },
  });
  child.unref();
  const url = `http://127.0.0.1:${port}/`;
  await fs.writeFile(stateFile, JSON.stringify({ ok: true, starting: true, pid: child.pid, provider, url, logFile, startedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ ok: true, daemon: true, pid: child.pid, provider, url, artifactDirectory, logFile }, null, 2));
  process.exit(0);
}

const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-live-pan-login-"));
const userDataDirectory = path.join(temporaryHome, "profile");
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

await fs.mkdir(artifactDirectory, { recursive: true });

let app;
let page;
let latest = {
  provider,
  status: "starting",
  message: "正在启动本地服务…",
  qrImage: "",
  taskId: "",
  createdAt: 0,
  refreshMs,
  login: null,
  catvod: null,
  error: "",
};

function safePublicState() {
  return {
    provider: latest.provider,
    status: latest.status,
    message: latest.message,
    qrImage: latest.qrImage,
    taskId: latest.taskId,
    createdAt: latest.createdAt,
    refreshMs: latest.refreshMs,
    login: latest.login,
    catvod: latest.catvod,
    error: latest.error,
    now: Date.now(),
  };
}

async function persist(extra = {}) {
  await fs.writeFile(stateFile, JSON.stringify({ ok: true, url: `http://127.0.0.1:${port}/`, ...safePublicState(), ...extra }, null, 2));
}

async function launchElectron() {
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
  latest.status = "booted";
  latest.message = "Electron 已启动，正在启动 CatVod…";
  await persist();
}

async function startFreshQr(reason = "refresh") {
  try {
    latest.status = "refreshing";
    latest.message = reason === "manual" ? "正在手动刷新二维码…" : "正在生成新的二维码…";
    latest.error = "";
    await persist();
    const result = await page.evaluate(async (loginProvider) => {
      const api = window.tvApi;
      if (!api?.startCatVod) throw new Error("tvApi.startCatVod 不存在");
      await api.startCatVod();
      const catvod = await api.getCatVodStatus();
      const started = await api.startPanLogin(loginProvider);
      return { catvod, started };
    }, provider);
    const started = result.started || {};
    latest.catvod = {
      state: result.catvod?.state,
      port: result.catvod?.port,
      siteCount: result.catvod?.siteCount,
      versionMd5: result.catvod?.versionMd5,
    };
    latest.taskId = started.taskId || "";
    latest.qrImage = typeof started.qrImage === "string" ? started.qrImage : "";
    latest.status = started.status || "waiting";
    latest.message = started.message || "请使用夸克 App 扫码确认";
    latest.login = started;
    latest.createdAt = Date.now();
    await persist({ refreshedAt: new Date().toISOString(), reason });
  } catch (error) {
    latest.status = "error";
    latest.error = error instanceof Error ? error.message : String(error);
    latest.message = `生成二维码失败：${latest.error}`;
    await persist();
  }
}

async function pollLogin() {
  if (!latest.taskId || latest.status === "success" || latest.status === "logged_in") return;
  try {
    const poll = await page.evaluate(async ({ loginProvider, taskId }) => {
      const api = window.tvApi;
      if (!api?.pollPanLogin) throw new Error("tvApi.pollPanLogin 不存在");
      return api.pollPanLogin(loginProvider, taskId);
    }, { loginProvider: provider, taskId: latest.taskId });
    latest.login = poll;
    latest.status = poll?.status || latest.status;
    latest.message = poll?.message || latest.message;
    if (poll?.terminal || /success|logged|已登录|完成/i.test(String(poll?.status || poll?.message || ""))) {
      latest.status = poll?.status || "success";
      latest.message = poll?.message || "登录流程已结束，请回到应用检查状态";
    }
    await persist({ polledAt: new Date().toISOString() });
  } catch (error) {
    latest.error = error instanceof Error ? error.message : String(error);
    await persist({ pollErrorAt: new Date().toISOString() });
  }
}

function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>夸克实时扫码登录</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f4f6fb; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { width:min(94vw,920px); box-sizing:border-box; padding:28px; border-radius:28px; background:#fff; box-shadow:0 16px 70px rgba(15,23,42,.14); text-align:center; }
  h1 { margin:0 0 10px; font-size:26px; }
  .hint { margin:0 0 18px; color:#667085; }
  .qr-wrap { display:grid; place-items:center; min-height:min(76vw,700px); border:1px solid #eef0f5; border-radius:24px; background:#fff; }
  img { width:min(78vw,700px); height:auto; image-rendering:pixelated; display:block; }
  .status { margin-top:16px; padding:12px 14px; border-radius:14px; background:#f8fafc; color:#334155; font-weight:600; }
  .meta { margin-top:10px; color:#667085; font-size:14px; word-break:break-all; }
  button { margin-top:14px; padding:12px 18px; border:0; border-radius:999px; background:#111827; color:#fff; font-weight:700; font-size:15px; }
  .ok { color:#047857; background:#ecfdf3; }
  .bad { color:#b42318; background:#fef3f2; }
</style>
</head>
<body>
<main>
  <h1>夸克 App 实时扫码登录</h1>
  <p class="hint">这个页面由本机脚本直接刷新二维码，不经过聊天上传。请用手机扫电脑屏幕。</p>
  <div class="qr-wrap"><img id="qr" alt="二维码生成中"></div>
  <div id="status" class="status">正在启动…</div>
  <div id="meta" class="meta"></div>
  <button onclick="manualRefresh()">二维码过期？立即刷新</button>
</main>
<script>
let lastTaskId = "";
async function loadState() {
  const res = await fetch('/state?ts=' + Date.now(), { cache: 'no-store' });
  const data = await res.json();
  const qr = document.getElementById('qr');
  const status = document.getElementById('status');
  const meta = document.getElementById('meta');
  if (data.qrImage && data.taskId !== lastTaskId) {
    qr.src = data.qrImage;
    lastTaskId = data.taskId;
  } else if (data.qrImage && !qr.src) {
    qr.src = data.qrImage;
  }
  const age = data.createdAt ? Math.floor((Date.now() - data.createdAt) / 1000) : 0;
  status.textContent = data.message || data.status || '等待中';
  status.className = 'status ' + (/success|logged|已登录|完成/i.test(String(data.status) + String(data.message)) ? 'ok' : data.error ? 'bad' : '');
  meta.textContent = 'taskId: ' + (data.taskId || '-') + ' ｜ 二维码已生成 ' + age + ' 秒 ｜ 每 ' + Math.round((data.refreshMs || 35000) / 1000) + ' 秒自动换新';
}
async function manualRefresh() {
  document.getElementById('status').textContent = '正在刷新二维码…';
  await fetch('/refresh', { method: 'POST' });
  await loadState();
}
setInterval(loadState, 1500);
loadState();
</script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderPage());
      return;
    }
    if (url.pathname === "/state") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(safePublicState()));
      return;
    }
    if (url.pathname === "/refresh" && request.method === "POST") {
      await startFreshQr("manual");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(safePublicState()));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.stack || error.message : String(error));
  }
});

server.listen(port, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${port}/`;
  latest.message = "本地扫码页已启动，正在启动 Electron…";
  await persist({ url });
  spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" }).unref();
  await launchElectron();
  await startFreshQr("initial");
  setInterval(async () => {
    if (latest.status === "success" || latest.status === "logged_in") return;
    if (!latest.createdAt || Date.now() - latest.createdAt >= refreshMs) await startFreshQr("auto");
  }, 2_000);
  setInterval(pollLogin, 3_000);
});

process.on("SIGTERM", async () => {
  if (app) await app.close().catch(() => undefined);
  server.close(() => process.exit(0));
});

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
