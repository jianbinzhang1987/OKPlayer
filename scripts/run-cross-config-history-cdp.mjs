import fs from "node:fs/promises";
import path from "node:path";

const debugPort = Number(process.env.FONGMI_DEBUG_PORT || 9223);
const artifactDir = path.resolve("artifacts", "cross-config-history-cdp");
await fs.rm(artifactDir, { recursive: true, force: true });
await fs.mkdir(artifactDir, { recursive: true });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  async function waitFor(expression, label, timeoutMs = 45_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return;
      await delay(250);
    }
    throw new Error(`等待超时：${label}`);
  }

  await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('.app-shell'))", "应用初始化");

  const clickedSources = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '播放源');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clickedSources) throw new Error("未找到播放源按钮");
  await waitFor("Boolean(document.querySelector('.sources-page'))", "播放源页面");
  const loadedOtherConfig = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.config-card')].find((item) => item.textContent.includes('https://9280.kstore.vip/newwex.json'));
    const button = [...(card?.querySelectorAll('button') || [])].find((item) => item.textContent.includes('载入'));
    if (!button) return card?.classList.contains('active') || false;
    button.click();
    return true;
  })()`);
  if (!loadedOtherConfig) throw new Error("未找到 newwex.json 配置的载入按钮");
  await waitFor("document.querySelector('.source-switcher')?.value !== 'public_domain_movies'", "切换到 newwex 配置", 90_000);
  const initialSource = await evaluate("document.querySelector('.source-switcher')?.selectedOptions?.[0]?.textContent?.trim() || ''");

  const clickedHistory = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '播放历史');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clickedHistory) throw new Error("未找到播放历史按钮");
  await waitFor("[...document.querySelectorAll('.history-item')].some((item) => item.textContent.includes('大雄兔（Big Buck Bunny）'))", "旧历史记录");

  const opened = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.history-item')].find((element) => element.textContent.includes('大雄兔（Big Buck Bunny）'));
    const button = item?.querySelector('.history-open');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!opened) throw new Error("未找到大雄兔历史记录入口");

  await waitFor("Boolean(document.querySelector('.detail-page'))", "影片详情");
  await waitFor("document.querySelector('.source-switcher')?.value === 'public_domain_movies'", "自动恢复历史配置");

  const result = await evaluate(`(() => ({
    page: document.querySelector('.detail-page') ? 'detail' : 'unknown',
    title: document.querySelector('.detail-copy h1')?.textContent?.trim() || '',
    selectedSource: document.querySelector('.source-switcher')?.selectedOptions?.[0]?.textContent?.trim() || '',
    selectedSiteKey: document.querySelector('.source-switcher')?.value || '',
    error: document.querySelector('.error-message p')?.textContent?.trim() || '',
    lines: [...document.querySelectorAll('.line-tabs button')].map((item) => item.textContent.trim()),
  }))()`);

  const image = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.writeFile(path.join(artifactDir, "restored-detail.png"), Buffer.from(image.data, "base64"));

  const report = {
    auditedAt: new Date().toISOString(),
    status: result.error ? "failed" : "passed",
    initialSource,
    ...result,
  };
  await fs.writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (result.error) process.exitCode = 1;
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
