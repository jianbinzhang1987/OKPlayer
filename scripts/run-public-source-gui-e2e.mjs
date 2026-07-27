import fs from "node:fs";
import path from "node:path";

const debugPort = Number(process.env.FONGMI_DEBUG_PORT || 9223);
const configUrl = process.env.FONGMI_TEST_CONFIG_URL
  || "http://127.0.0.1:4179/@fs/Users/adolf/Desktop/code/TV/mac/public/public-domain-config.json";
const outputDir = process.env.FONGMI_E2E_OUTPUT || "/tmp/fongmi-public-source-e2e";

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
      const detail = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || "页面脚本执行失败";
      throw new Error(detail);
    }
    return response.result?.value;
  }

  return { socket, call, evaluate };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const client = await connect();
  const { call, evaluate, socket } = client;

  async function waitFor(expression, label, timeoutMs = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await evaluate(expression)) return;
      await delay(250);
    }
    throw new Error(`等待超时：${label}`);
  }

  async function clickButton(text) {
    const clicked = await evaluate(`(() => {
      const expected = ${JSON.stringify(text)};
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.replace(/\\s+/g, ' ').trim().includes(expected));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`未找到按钮：${text}`);
  }

  async function fill(placeholder, value) {
    const changed = await evaluate(`(() => {
      const input = document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]');
      if (!input) return false;
      input.focus();
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!changed) throw new Error(`未找到输入框：${placeholder}`);
  }

  async function screenshot(name) {
    const result = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(path.join(outputDir, name), Buffer.from(result.data, "base64"));
  }

  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.bringToFront");
  await waitFor("document.readyState === 'complete' && Boolean(window.tvApi)", "应用初始化");

  await clickButton("播放源");
  await waitFor("Boolean(document.querySelector('input[placeholder=\"例如：家庭配置\"]'))", "播放源配置页");
  await fill("例如：家庭配置", "公开影片测试源");
  await fill("https://example.com/config.json", configUrl);
  await clickButton("导入");
  await waitFor("[...document.querySelectorAll('option')].some((item) => item.textContent.includes('公开影片测试源'))", "源导入完成", 45_000);
  await screenshot("01-source-configured.png");

  await fill("搜索影片、电视剧、综艺", "大雄兔");
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder="搜索影片、电视剧、综艺"]');
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  })()`);
  await waitFor("document.body.innerText.includes('大雄兔（Big Buck Bunny）') && document.body.innerText.includes('共找到 1 个结果')", "电影搜索结果", 45_000);
  await screenshot("02-search-result.png");

  const opened = await evaluate(`(() => {
    const card = [...document.querySelectorAll('button.poster-card')]
      .find((item) => item.textContent.includes('大雄兔'));
    if (!card) return false;
    card.click();
    return true;
  })()`);
  if (!opened) throw new Error("未找到《大雄兔》搜索结果卡片");
  await waitFor("Boolean(document.querySelector('.detail-actions .primary-button')) && document.body.innerText.includes('公开 HLS')", "影片详情", 30_000);
  await screenshot("03-detail.png");

  const playClicked = await evaluate(`(() => {
    const button = document.querySelector('.detail-actions .primary-button');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!playClicked) throw new Error("未找到详情页播放按钮");
  await waitFor("Boolean(document.querySelector('.embedded-player video'))", "内置播放器出现", 45_000);
  await evaluate(`(async () => {
    const video = document.querySelector('.embedded-player video');
    await video.play();
    return true;
  })()`);
  await waitFor(`(() => {
    const video = document.querySelector('.embedded-player video');
    return Boolean(video && video.readyState >= 2 && !video.paused && video.currentTime > 0.25);
  })()`, "影片开始播放", 60_000);
  await screenshot("04-playing.png");

  const result = await evaluate(`(() => {
    const video = document.querySelector('.embedded-player video');
    const source = document.querySelector('.source-switcher')?.selectedOptions?.[0]?.textContent || '';
    return {
      source,
      title: document.querySelector('.player-title strong')?.textContent || '',
      episode: document.querySelector('.player-title span')?.textContent || '',
      currentSrc: video?.currentSrc || '',
      readyState: video?.readyState ?? -1,
      paused: video?.paused ?? true,
      currentTime: video?.currentTime ?? 0,
      duration: video?.duration ?? 0,
      playerVisible: Boolean(document.querySelector('.embedded-player')),
    };
  })()`);

  console.log(JSON.stringify({
    status: "passed",
    configUrl,
    screenshots: outputDir,
    ...result,
  }, null, 2));
  socket.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
