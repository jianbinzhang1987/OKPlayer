import process from "node:process";

const debugPort = Number(process.env.FONGMI_DEBUG_PORT || 9223);
const endpoint = `http://127.0.0.1:${debugPort}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect() {
  const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
  const target = targets.find((item) => item.type === "page" && item.title.includes("FongMi"))
    ?? targets.find((item) => item.type === "page");
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
      throw new Error(response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || "页面脚本执行失败");
    }
    return response.result?.value;
  }

  return { socket, call, evaluate };
}

async function waitFor(evaluate, expression, label, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return;
    await delay(300);
  }
  throw new Error(`等待超时：${label}`);
}

const client = await connect();
try {
  await client.call("Runtime.enable");
  await client.call("Page.enable");
  await client.call("Page.bringToFront");
  await waitFor(client.evaluate, "document.readyState === 'complete' && Boolean(window.tvApi) && Boolean(document.querySelector('.app-shell'))", "应用初始化", 30_000);

  const setup = await client.evaluate(`(async () => {
    let catVod = await window.tvApi.getCatVodStatus();
    if (catVod?.state !== 'running') {
      await window.tvApi.startCatVod(undefined, 'allow');
      catVod = await window.tvApi.getCatVodStatus();
    }
    const account = await window.tvApi.getPanStatus('quark');
    const sites = await window.tvApi.listSites();
    const site = sites.find((item) => /至臻/.test(String(item.name || '')) && item.capabilities?.search && item.capabilities?.detail && item.capabilities?.player);
    if (!site) throw new Error('未找到至臻可播放来源');
    if (!account?.login) throw new Error('夸克账号未登录');
    await window.tvApi.setSetting('defaultSite', site.key);
    await window.tvApi.setSetting('webPlayerEngine', 'artplayer');
    return { siteKey: site.key, siteName: site.name, accountState: account.state };
  })()`);

  await client.call("Page.reload", { ignoreCache: true });
  await waitFor(client.evaluate, "document.readyState === 'complete' && Boolean(document.querySelector('.app-shell'))", "应用重新加载", 45_000);
  await waitFor(client.evaluate, `document.querySelector('.source-picker-trigger')?.textContent?.includes(${JSON.stringify(setup.siteName)})`, "至臻成为当前来源", 45_000);

  const submitted = await client.evaluate(`(() => {
    const input = document.querySelector('.topbar-search input');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '庆余年');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  })()`);
  if (!submitted) throw new Error("未找到顶部搜索输入框");

  await waitFor(client.evaluate, `(() => [...document.querySelectorAll('.search-result-card')].some((card) => /庆余年/.test(card.textContent || '') && /第一季/.test(card.textContent || '') && !/特别/.test(card.querySelector('h3')?.textContent || '')))()`, "庆余年第一季正片搜索结果", 90_000);

  const opened = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.search-result-card')];
    const card = cards.find((item) => /庆余年/.test(item.textContent || '') && /第一季/.test(item.textContent || '') && !/特别/.test(item.querySelector('h3')?.textContent || ''));
    if (!card) return false;
    const exactSource = [...card.querySelectorAll('.search-source-list button')]
      .find((button) => /至臻/.test(button.textContent || ''));
    const fallback = card.querySelector('.secondary-button');
    const button = exactSource || fallback;
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (!opened) throw new Error("未能从搜索结果打开至臻详情");

  await waitFor(client.evaluate, `Boolean(document.querySelector('.detail-page')) && /庆余年/.test(document.querySelector('.detail-page h1')?.textContent || '')`, "详情页", 60_000);
  await waitFor(client.evaluate, `(() => [...document.querySelectorAll('.line-tabs button')].some((button) => /夸克极速/.test(button.textContent || '')))()`, "夸克极速线路", 60_000);

  const selectedLine = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('.line-tabs button')].find((item) => /夸克极速/.test(item.textContent || ''));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (!selectedLine) throw new Error("未能选择夸克极速线路");

  const selectedEpisode = await client.evaluate(`(() => {
    const button = document.querySelector('.episode-grid button');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (!selectedEpisode) throw new Error("未能选择第一集");

  await waitFor(client.evaluate, `Boolean(document.querySelector('.art-player-host video'))`, "ArtPlayer 页面", 60_000);
  await waitFor(client.evaluate, `(() => {
    const video = document.querySelector('.art-player-host video');
    return video instanceof HTMLVideoElement && Number.isFinite(video.duration) && video.duration > 60 && video.videoWidth >= 3000;
  })()`, "ArtPlayer 真实 4K 元数据", 120_000);

  const controls = await client.evaluate(`(async () => {
    const video = document.querySelector('.art-player-host video');
    if (!(video instanceof HTMLVideoElement)) throw new Error('ArtPlayer video 不存在');
    const wait = (predicate, timeout, label) => new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new Error('等待超时：' + label));
        }
      }, 250);
    });
    if (video.paused) await video.play();
    await wait(() => !video.paused && video.currentTime > 0.75, 45_000, 'ArtPlayer 开始播放');
    const beforePause = video.currentTime;
    video.pause();
    await wait(() => video.paused, 5_000, 'ArtPlayer 暂停');
    const pausedAt = video.currentTime;
    video.currentTime = 300;
    await wait(() => video.currentTime >= 295 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, 90_000, 'ArtPlayer 跳转');
    const seekedAt = video.currentTime;
    await video.play();
    await wait(() => !video.paused && video.currentTime > seekedAt + 0.5, 45_000, 'ArtPlayer 恢复播放');
    const resumedAt = video.currentTime;
    video.playbackRate = 1.5;
    const speedStartedAt = video.currentTime;
    await wait(() => video.playbackRate === 1.5 && video.currentTime > speedStartedAt + 2, 15_000, 'ArtPlayer 1.5 倍速');
    const speedEndedAt = video.currentTime;
    const playbackRate = video.playbackRate;
    video.playbackRate = 1;
    video.pause();
    return {
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      beforePause,
      pausedAt,
      seekedAt,
      resumedAt,
      playbackRate,
      speedAdvancedSeconds: speedEndedAt - speedStartedAt,
      mediaError: video.error ? { code: video.error.code, message: video.error.message } : null,
      playerEngine: document.querySelector('.player-container')?.getAttribute('data-player-engine') || '',
      formatLabel: document.querySelector('.art-player-host .format-chip')?.textContent?.trim() || '',
      title: document.querySelector('.art-player-host .player-title strong')?.textContent?.trim() || '',
      episode: document.querySelector('.art-player-host .player-title span')?.textContent?.trim() || '',
    };
  })()`);

  const switched = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('.art-player-host button')]
      .find((item) => /下一集/.test(item.getAttribute('title') || ''));
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!switched) throw new Error('当前线路没有可验证的下一集');

  const initialEpisode = JSON.stringify(controls.episode);
  await waitFor(client.evaluate, `(() => {
    const episode = document.querySelector('.art-player-host .player-title span')?.textContent?.trim() || '';
    return Boolean(document.querySelector('.art-player-host video')) && episode && episode !== ${initialEpisode};
  })()`, "切换到下一集", 90_000);
  await waitFor(client.evaluate, `(() => {
    const video = document.querySelector('.art-player-host video');
    return video instanceof HTMLVideoElement && Number.isFinite(video.duration) && video.duration > 60 && video.videoWidth >= 3000;
  })()`, "下一集 4K 元数据", 120_000);

  const nextEpisode = await client.evaluate(`(async () => {
    const video = document.querySelector('.art-player-host video');
    if (!(video instanceof HTMLVideoElement)) throw new Error('下一集 ArtPlayer video 不存在');
    const started = Date.now();
    if (video.paused) await video.play();
    while ((video.paused || video.currentTime <= 0.5) && Date.now() - started < 45_000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (video.paused || video.currentTime <= 0.5) throw new Error('下一集未开始播放');
    const result = {
      title: document.querySelector('.art-player-host .player-title strong')?.textContent?.trim() || '',
      episode: document.querySelector('.art-player-host .player-title span')?.textContent?.trim() || '',
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      currentTime: video.currentTime,
      mediaError: video.error ? { code: video.error.code, message: video.error.message } : null,
    };
    video.pause();
    return result;
  })()`);

  console.log(JSON.stringify({ status: "passed", setup, controls, nextEpisode }, null, 2));
} finally {
  await client.evaluate(`(() => {
    const button = document.querySelector('.art-player-host .player-header-button');
    if (button instanceof HTMLButtonElement) button.click();
    return true;
  })()`).catch(() => undefined);
  client.socket.close();
}
