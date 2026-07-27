import fs from "node:fs/promises";
import path from "node:path";

const debugPort = Number(process.env.FONGMI_DEBUG_PORT || 9223);
const artifactDir = path.resolve("artifacts", "player-titlebar-audit");
await fs.rm(artifactDir, { recursive: true, force: true });
await fs.mkdir(artifactDir, { recursive: true });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  const target = targets.find((item) => item.type === "page" && item.title.includes("FongMi"));
  if (!target?.webSocketDebuggerUrl) throw new Error("未找到 FongMi Electron 调试页面");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    if (!message.id) return;
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });

  function call(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "页面执行失败");
    }
    return response.result?.value;
  }

  return { socket, call, evaluate };
}

let client;
try {
  client = await connect();
  const { call, evaluate } = client;
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.bringToFront");

  async function waitFor(expression, label, timeoutMs = 60_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await evaluate(expression)) return;
      await delay(250);
    }
    throw new Error(`等待超时：${label}`);
  }

  await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('.app-shell'))", "应用初始化");

  const playerAlreadyVisible = await evaluate("Boolean(document.querySelector('.embedded-player'))");
  if (!playerAlreadyVisible) {
    const detailVisible = await evaluate("Boolean(document.querySelector('.detail-page'))");
    if (!detailVisible) {
      const clickedHistory = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '播放历史');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!clickedHistory) throw new Error("未找到播放历史按钮");
      await waitFor("[...document.querySelectorAll('.history-item')].some((item) => item.textContent.includes('大雄兔（Big Buck Bunny）'))", "大雄兔历史记录");
      const opened = await evaluate(`(() => {
        const item = [...document.querySelectorAll('.history-item')].find((element) => element.textContent.includes('大雄兔（Big Buck Bunny）'));
        const button = item?.querySelector('.history-open');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!opened) throw new Error("未找到大雄兔历史记录入口");
      await waitFor("Boolean(document.querySelector('.detail-page'))", "影片详情", 90_000);
    }

    const started = await evaluate(`(() => {
      const button = document.querySelector('.detail-actions .primary-button');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!started) throw new Error("未找到立即播放按钮");
    await waitFor("Boolean(document.querySelector('.embedded-player'))", "内置播放器", 90_000);
  }

  await waitFor(`(() => {
    const video = document.querySelector('.embedded-player video');
    return video instanceof HTMLVideoElement && video.readyState >= 2;
  })()`, "视频可播放", 90_000);

  const metrics = await evaluate(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const video = document.querySelector('.embedded-player video');
    const safe = rect('.mac-window-controls-safe-area');
    const back = rect('.player-back-button');
    const hint = rect('.player-hint');
    const hintStyle = document.querySelector('.player-hint') ? getComputedStyle(document.querySelector('.player-hint')) : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      header: rect('.embedded-player-header'),
      safeArea: safe,
      backButton: back,
      title: rect('.player-title'),
      actions: rect('.player-header-actions'),
      playerHint: hint,
      hintBottomClearance: hint ? innerHeight - hint.bottom : -1,
      hintPointerEvents: hintStyle?.pointerEvents ?? '',
      safeGap: safe && back ? back.left - safe.right : -1,
      backLeft: back?.left ?? -1,
      titleText: document.querySelector('.player-title strong')?.textContent?.trim() ?? '',
      playing: video instanceof HTMLVideoElement ? !video.paused : false,
      readyState: video instanceof HTMLVideoElement ? video.readyState : 0,
      error: document.querySelector('.player-error-card p')?.textContent?.trim() ?? '',
    };
  })()`);

  const image = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.writeFile(path.join(artifactDir, "player-titlebar-fixed.png"), Buffer.from(image.data, "base64"));

  const passed = metrics.safeArea?.width === 96
    && metrics.safeGap >= 12
    && metrics.backLeft >= 126
    && metrics.hintBottomClearance >= 88
    && metrics.hintPointerEvents === "none"
    && metrics.titleText.includes("大雄兔")
    && metrics.readyState >= 2
    && metrics.error === "";
  const report = {
    auditedAt: new Date().toISOString(),
    status: passed ? "passed" : "failed",
    ...metrics,
  };
  await fs.writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  const report = {
    auditedAt: new Date().toISOString(),
    status: "failed",
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  };
  await fs.writeFile(path.join(artifactDir, "failure.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(report.message);
  process.exitCode = 1;
} finally {
  client?.socket.close();
}
