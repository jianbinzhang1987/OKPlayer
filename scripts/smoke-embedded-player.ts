import { app, BrowserWindow, protocol } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaProtocolService, MEDIA_PROTOCOL_SCHEME } from "../src/desktop/media-protocol/media-protocol-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const tempDirectory = await mkdtemp(path.join(tmpdir(), "fongmi-embedded-player-"));
const mediaPath = path.join(tempDirectory, "smoke.mp4");
const hlsPath = path.join(tempDirectory, "master.m3u8");
const hlsSegmentPattern = path.join(tempDirectory, "segment-%03d.ts");
let window: BrowserWindow | undefined;
let server: ReturnType<typeof createServer> | undefined;
const resultPath = process.argv.find((value) => value.startsWith("--smoke-result="))?.slice("--smoke-result=".length)
  || process.env.EMBEDDED_SMOKE_RESULT?.trim();
let resultWritten = false;

async function writeResult(payload: Record<string, unknown>) {
  if (!resultPath || resultWritten) return;
  resultWritten = true;
  await writeFile(resultPath, JSON.stringify(payload, null, 2), "utf8");
}

process.on("uncaughtException", (error) => {
  void writeResult({ status: "failed", error: error instanceof Error ? error.stack ?? error.message : String(error) })
    .finally(() => app.exit(1));
});
process.on("unhandledRejection", (error) => {
  void writeResult({ status: "failed", error: error instanceof Error ? error.stack ?? error.message : String(error) })
    .finally(() => app.exit(1));
});

const startupWatchdog = setTimeout(() => {
  void writeResult({
    status: "failed",
    stage: "electron-startup",
    error: "Electron did not complete the embedded playback smoke test within 45 seconds. The current macOS session may not provide a usable GUI/Mach-port environment.",
  }).finally(() => app.exit(1));
}, 45_000);
startupWatchdog.unref();

try {
  execFileSync("ffmpeg", [
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "color=c=black:s=320x180:d=2",
    "-f", "lavfi",
    "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    "-y",
    mediaPath,
  ]);
  execFileSync("ffmpeg", [
    "-loglevel", "error",
    "-i", mediaPath,
    "-c", "copy",
    "-hls_time", "1",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", hlsSegmentPattern,
    "-y",
    hlsPath,
  ]);

  const media = await readFile(mediaPath);
  const hlsManifest = await readFile(hlsPath);
  const hlsSegments = new Map<string, Buffer>();
  for (const filename of await readdir(tempDirectory)) {
    if (/^segment-\d+\.ts$/.test(filename)) hlsSegments.set(`/${filename}`, await readFile(path.join(tempDirectory, filename)));
  }
  assert.ok(hlsSegments.size > 0, "烟雾测试必须生成至少一个 HLS 分片");

  const observedRequests: Array<{ url: string; range?: string; referer?: string; smoke?: string }> = [];

  server = createServer((request, response) => {
    observedRequests.push({
      url: request.url ?? "",
      ...(request.headers.range ? { range: request.headers.range } : {}),
      ...(request.headers.referer ? { referer: request.headers.referer } : {}),
      ...(typeof request.headers["x-smoke"] === "string" ? { smoke: request.headers["x-smoke"] } : {}),
    });

    if (request.url === "/master.m3u8") {
      response.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Content-Length": hlsManifest.length,
      });
      response.end(hlsManifest);
      return;
    }

    const body = request.url === "/video.mp4" ? media : hlsSegments.get(request.url ?? "");
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }

    const contentType = request.url === "/video.mp4" ? "video/mp4" : "video/mp2t";
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const requestedEnd = match?.[2] ? Number(match[2]) : body.length - 1;
      const end = Math.min(body.length - 1, requestedEnd);
      const rangedBody = body.subarray(start, end + 1);
      response.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": rangedBody.length,
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Accept-Ranges": "bytes",
      });
      response.end(rangedBody);
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Accept-Ranges": "bytes",
    });
    response.end(body);
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法获取烟雾测试服务端口");
  const origin = `http://127.0.0.1:${address.port}`;

  const electronMajor = Number(process.versions.electron?.split(".", 1)[0] ?? 0);
  const chromiumMajor = Number(process.versions.chrome?.split(".", 1)[0] ?? 0);
  assert.ok(electronMajor >= 43, `需要 Electron 43 或更高版本，当前为 ${process.versions.electron ?? "unknown"}`);
  assert.ok(chromiumMajor >= 150, `需要 Chromium 150 或更高版本，当前为 ${process.versions.chrome ?? "unknown"}`);

  await app.whenReady();
  const sessions = new PlaybackSessionStore();
  const mediaProtocol = new MediaProtocolService(sessions);
  mediaProtocol.register(protocol);

  const mp4Session = sessions.create({
    url: `${origin}/video.mp4`,
    headers: { Referer: "https://player.example.test/", "X-Smoke": "embedded" },
    format: "mp4",
    resolvedBy: "direct",
  });
  const mp4Url = sessions.playbackUrl(mp4Session.id);

  const rangeResponse = await mediaProtocol.handle(new Request(mp4Url, { headers: { Range: "bytes=0-127" } }));
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), `bytes 0-127/${media.length}`);
  assert.equal((await rangeResponse.arrayBuffer()).byteLength, 128);
  assert.ok(observedRequests.some((request) => request.range === "bytes=0-127" && request.smoke === "embedded"));
  assert.ok(observedRequests.some((request) => request.referer === "https://player.example.test/"));

  const hlsSession = sessions.create({
    url: `${origin}/master.m3u8`,
    headers: { Referer: "https://player.example.test/", "X-Smoke": "embedded" },
    format: "hls",
    resolvedBy: "direct",
  });
  const manifestResponse = await mediaProtocol.handle(new Request(sessions.playbackUrl(hlsSession.id)));
  const rewrittenManifest = await manifestResponse.text();
  assert.match(rewrittenManifest, /fongmi-media:\/\/session\/.+\/resource\/.+/);
  const childUrl = rewrittenManifest.split("\n").find((line) => line.startsWith("fongmi-media://"));
  assert.ok(childUrl);
  const childResponse = await mediaProtocol.handle(new Request(childUrl, { headers: { Range: "bytes=0-63" } }));
  assert.equal(childResponse.status, 206);
  assert.equal((await childResponse.arrayBuffer()).byteLength, 64);

  window = new BrowserWindow({
    show: false,
    width: 640,
    height: 400,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  await window.loadURL("data:text/html,<video id='video' muted playsinline></video>");
  const playbackResult = await window.webContents.executeJavaScript(`
    (async () => {
      const video = document.getElementById('video');
      const hlsSupport = video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL');
      const load = (src, label) => new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener('loadedmetadata', onMetadata);
          video.removeEventListener('error', onError);
        };
        const onMetadata = async () => {
          cleanup();
          try { await video.play(); } catch {}
          resolve({ label, duration: video.duration, readyState: video.readyState, currentSrc: video.currentSrc });
        };
        const onError = () => {
          cleanup();
          reject(new Error(label + ' video error ' + (video.error?.code ?? 'unknown')));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(label + ' video metadata timeout'));
        }, 15000);
        video.addEventListener('loadedmetadata', onMetadata, { once: true });
        video.addEventListener('error', onError, { once: true });
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.src = src;
        video.load();
      });
      const mp4 = await load(${JSON.stringify(mp4Url)}, 'mp4');
      const hls = await load(${JSON.stringify(sessions.playbackUrl(hlsSession.id))}, 'hls');
      return { hlsSupport, mp4, hls };
    })()
  `, true) as {
    hlsSupport: string;
    mp4: { duration: number; readyState: number; currentSrc: string };
    hls: { duration: number; readyState: number; currentSrc: string };
  };
  assert.notEqual(playbackResult.hlsSupport, "", "Chromium 必须声明原生 HLS 支持");
  assert.ok(playbackResult.mp4.duration > 0);
  assert.ok(playbackResult.mp4.readyState >= 1);
  assert.equal(playbackResult.mp4.currentSrc, mp4Url);
  assert.ok(playbackResult.hls.duration > 0);
  assert.ok(playbackResult.hls.readyState >= 1);
  assert.ok(observedRequests.some((request) => /^\/segment-\d+\.ts$/.test(request.url)));

  const result = {
    status: "passed",
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    hlsSupport: playbackResult.hlsSupport,
    mp4Duration: playbackResult.mp4.duration,
    hlsDuration: playbackResult.hls.duration,
    requests: observedRequests.length,
    manifestRewritten: true,
    rangeForwarded: true,
  };
  await writeResult(result);
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(startupWatchdog);
  if (window && !window.isDestroyed()) window.destroy();
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  await rm(tempDirectory, { recursive: true, force: true });
  app.quit();
}
