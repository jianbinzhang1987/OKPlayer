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

const client = await connect();
try {
  await client.call("Runtime.enable");
  await client.call("Page.enable");
  await client.call("Page.bringToFront");

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (await client.evaluate("document.readyState === 'complete' && Boolean(window.tvApi)")) break;
    await delay(250);
  }

  const report = await client.evaluate(`(async () => {
    const waitFor = (predicate, timeoutMs, label) => new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        try {
          const value = predicate();
          if (value) {
            clearInterval(timer);
            resolve(value);
          } else if (Date.now() - started >= timeoutMs) {
            clearInterval(timer);
            reject(new Error('等待超时：' + label));
          }
        } catch (error) {
          clearInterval(timer);
          reject(error);
        }
      }, 250);
    });

    let prepared;
    let video;
    try {
      let catVod = await window.tvApi.getCatVodStatus();
      if (catVod?.state !== 'running') {
        await window.tvApi.startCatVod(undefined, 'allow');
        catVod = await window.tvApi.getCatVodStatus();
      }
      const account = await window.tvApi.getPanStatus('quark');
      if (!account?.login) throw new Error('夸克账号未登录');

      const sites = await window.tvApi.listSites();
      const site = sites.find((item) => /至臻/.test(String(item.name || '')) && item.capabilities?.search && item.capabilities?.detail && item.capabilities?.player);
      if (!site) throw new Error('未找到至臻可播放来源');

      const searched = await window.tvApi.searchDetailed('庆余年', site.key, 'current-site', 1);
      const item = (searched?.list || []).find((entry) => /庆余年/.test(String(entry.vodName || '')) && /第一季|S0?1/i.test(String(entry.vodName || '')))
        || (searched?.list || [])[0];
      if (!item) throw new Error('至臻来源未返回庆余年');

      const detail = await window.tvApi.detail(item.siteKey || site.key, item.vodId);
      const line = (detail.flags || []).find((entry) => /夸克极速/.test(String(entry.flag || entry.show || '')))
        || (detail.flags || []).find((entry) => /夸克/.test(String(entry.flag || entry.show || '')))
        || (detail.flags || [])[0];
      const episode = line?.episodes?.[0];
      if (!line || !episode) throw new Error('详情未返回夸克播放剧集');

      prepared = await window.tvApi.preparePlayback({
        siteKey: detail.siteKey || item.siteKey || site.key,
        flag: line.flag,
        episodeUrl: episode.url,
        vodId: detail.vodId || item.vodId,
        vodName: detail.vodName || item.vodName,
        episodeName: episode.name,
      });
      if (prepared.engine !== 'web') throw new Error('真实夸克 MP4 未路由到应用内播放器：' + prepared.engine);
      if (!String(prepared.playbackUrl || '').startsWith('fongmi-media://')) throw new Error('未使用受保护的不透明媒体地址');

      video = document.createElement('video');
      video.id = 'fongmi-real-quark-audit';
      video.muted = true;
      video.autoplay = false;
      video.preload = 'auto';
      video.controls = true;
      video.style.cssText = 'position:fixed;left:16px;bottom:16px;width:640px;height:360px;z-index:99999;background:#000';
      video.src = prepared.playbackUrl;
      document.body.appendChild(video);
      video.load();

      await waitFor(() => video.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(video.duration) && video.duration > 60, 90_000, '真实 4K 元数据');
      const metadata = {
        duration: video.duration,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        readyState: video.readyState,
      };

      await video.play();
      await waitFor(() => video.currentTime > 0.75 && !video.paused, 45_000, '开始播放');
      const beforePause = video.currentTime;
      video.pause();
      await waitFor(() => video.paused, 5_000, '暂停');
      const pausedAt = video.currentTime;

      video.currentTime = 300;
      await waitFor(() => video.currentTime >= 295 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, 90_000, '跳转到 5 分钟');
      const seekedAt = video.currentTime;

      await video.play();
      await waitFor(() => !video.paused && video.currentTime > seekedAt + 0.5, 45_000, '跳转后恢复播放');
      const resumedAt = video.currentTime;
      video.pause();

      return {
        status: 'passed',
        source: site.name,
        title: detail.vodName || item.vodName,
        line: line.show || line.flag,
        episode: episode.name,
        accountState: account.state,
        prepared: {
          engine: prepared.engine,
          format: prepared.format,
          resolvedBy: prepared.resolvedBy,
          opaqueProtocol: String(prepared.playbackUrl).split(':')[0],
        },
        metadata,
        controls: { beforePause, pausedAt, seekedAt, resumedAt },
        mediaError: video.error ? { code: video.error.code, message: video.error.message } : null,
      };
    } finally {
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
      }
      if (prepared?.sessionId) await window.tvApi.closePlayback(prepared.sessionId).catch(() => undefined);
    }
  })()`);

  console.log(JSON.stringify(report, null, 2));
  if (report?.status !== "passed") process.exitCode = 1;
} finally {
  client.socket.close();
}
