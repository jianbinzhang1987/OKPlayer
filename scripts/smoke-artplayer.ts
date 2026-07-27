import { app, BrowserWindow, protocol } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaProtocolService, MEDIA_PROTOCOL_SCHEME } from "../src/desktop/media-protocol/media-protocol-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";

protocol.registerSchemesAsPrivileged([{
  scheme: MEDIA_PROTOCOL_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

const tempDirectory = await mkdtemp(path.join(tmpdir(), "fongmi-artplayer-smoke-"));
const mediaPath = path.join(tempDirectory, "smoke.mp4");
const hlsPath = path.join(tempDirectory, "master.m3u8");
const hlsSegmentPattern = path.join(tempDirectory, "segment-%03d.ts");
const htmlPath = path.join(tempDirectory, "index.html");
const artPlayerPath = path.join(tempDirectory, "artplayer.js");
const hlsLibraryPath = path.join(tempDirectory, "hls.js");
const resultPath = process.argv.find((value) => value.startsWith("--smoke-result="))?.slice("--smoke-result=".length)
  || process.env.ARTPLAYER_SMOKE_RESULT?.trim();
const projectRoot = process.argv.find((value) => value.startsWith("--project-root="))?.slice("--project-root=".length)
  || process.cwd();
let window: BrowserWindow | undefined;
let server: ReturnType<typeof createServer> | undefined;
let resultWritten = false;

async function writeResult(payload: Record<string, unknown>) {
  if (!resultPath || resultWritten) return;
  resultWritten = true;
  await writeFile(resultPath, JSON.stringify(payload, null, 2), "utf8");
}

const watchdog = setTimeout(() => {
  void writeResult({ status: "failed", stage: "electron-startup", error: "ArtPlayer smoke timed out after 45 seconds" })
    .finally(() => app.exit(1));
}, 45_000);
watchdog.unref();

process.on("uncaughtException", (error) => {
  void writeResult({ status: "failed", error: error instanceof Error ? error.stack ?? error.message : String(error) })
    .finally(() => app.exit(1));
});
process.on("unhandledRejection", (error) => {
  void writeResult({ status: "failed", error: error instanceof Error ? error.stack ?? error.message : String(error) })
    .finally(() => app.exit(1));
});

try {
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-y", mediaPath,
  ]);
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-i", mediaPath, "-c", "copy", "-hls_time", "1",
    "-hls_playlist_type", "vod", "-hls_segment_filename", hlsSegmentPattern, "-y", hlsPath,
  ]);

  const media = await readFile(mediaPath);
  const hlsManifest = await readFile(hlsPath);
  const hlsSegments = new Map<string, Buffer>();
  for (const filename of await readdir(tempDirectory)) {
    if (/^segment-\d+\.ts$/.test(filename)) hlsSegments.set(`/${filename}`, await readFile(path.join(tempDirectory, filename)));
  }
  assert.ok(hlsSegments.size > 0);
  const observedRequests: string[] = [];

  server = createServer((request, response) => {
    observedRequests.push(request.url ?? "");
    if (request.url === "/master.m3u8") {
      response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": hlsManifest.length });
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
      const end = Math.min(body.length - 1, match?.[2] ? Number(match[2]) : body.length - 1);
      const ranged = body.subarray(start, end + 1);
      response.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": ranged.length,
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Accept-Ranges": "bytes",
      });
      response.end(ranged);
      return;
    }
    response.writeHead(200, { "Content-Type": contentType, "Content-Length": body.length, "Accept-Ranges": "bytes" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine smoke server port");
  const origin = `http://127.0.0.1:${address.port}`;

  await app.whenReady();
  const sessions = new PlaybackSessionStore();
  new MediaProtocolService(sessions).register(protocol);
  const mp4Session = sessions.create({ url: `${origin}/video.mp4`, headers: { "X-Smoke": "artplayer" }, format: "mp4", resolvedBy: "direct" });
  const hlsSession = sessions.create({ url: `${origin}/master.m3u8`, headers: { "X-Smoke": "artplayer" }, format: "hls", resolvedBy: "direct" });
  const mp4Url = sessions.playbackUrl(mp4Session.id);
  const hlsUrl = sessions.playbackUrl(hlsSession.id);

  await Promise.all([
    writeFile(artPlayerPath, await readFile(path.join(projectRoot, "node_modules/artplayer/dist/artplayer.js"))),
    writeFile(hlsLibraryPath, await readFile(path.join(projectRoot, "node_modules/hls.js/dist/hls.min.js"))),
    writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#player{width:100%;height:100%;margin:0;background:#000}</style></head><body><div id="player"></div><script src="./artplayer.js"></script><script src="./hls.js"></script><script>
      window.runSmoke = async function(mp4Url, hlsUrl) {
        const container = document.getElementById('player');
        const run = (url, type) => new Promise((resolve, reject) => {
          let settled = false;
          const player = new Artplayer({
            container,
            url,
            type,
            autoplay: true,
            muted: true,
            hotkey: false,
            fullscreen: false,
            fullscreenWeb: false,
            customType: type === 'hls' ? {
              hls(video, source, art) {
                if (video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')) {
                  video.src = source;
                } else if (Hls.isSupported()) {
                  const hls = new Hls({ enableWorker: true });
                  art.hls = hls;
                  hls.loadSource(source);
                  hls.attachMedia(video);
                } else {
                  throw new Error('HLS unsupported');
                }
              }
            } : undefined,
          });
          const timer = setTimeout(() => finish(new Error(type + ' metadata timeout')), 15000);
          function finish(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const result = { duration: player.duration, currentSrc: player.video.currentSrc, ready: player.isReady };
            player.destroy(false);
            container.innerHTML = '';
            if (error) reject(error); else resolve(result);
          }
          player.on('ready', () => {
            if (player.duration > 0) finish();
          });
          player.on('video:loadedmetadata', () => finish());
          player.on('video:error', (error) => finish(error));
        });
        const mp4 = await run(mp4Url, 'mp4');
        const hls = await run(hlsUrl, 'hls');
        return { mp4, hls };
      };
    </script></body></html>`, "utf8"),
  ]);

  window = new BrowserWindow({
    show: false,
    width: 640,
    height: 400,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: "no-user-gesture-required" },
  });
  await window.loadFile(htmlPath);
  const playback = await window.webContents.executeJavaScript(`window.runSmoke(${JSON.stringify(mp4Url)}, ${JSON.stringify(hlsUrl)})`, true) as {
    mp4: { duration: number; currentSrc: string; ready: boolean };
    hls: { duration: number; currentSrc: string; ready: boolean };
  };
  assert.ok(playback.mp4.duration > 0);
  assert.ok(playback.mp4.currentSrc.startsWith("fongmi-media://"));
  assert.ok(playback.hls.duration > 0);
  assert.ok(playback.hls.currentSrc.startsWith("fongmi-media://"));
  assert.ok(observedRequests.some((url) => /^\/segment-\d+\.ts$/.test(url)));

  const result = {
    status: "passed",
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    artplayer: "5.4.0",
    mp4Duration: playback.mp4.duration,
    hlsDuration: playback.hls.duration,
    hlsSegmentRequested: true,
  };
  await writeResult(result);
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (window && !window.isDestroyed()) window.destroy();
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  await rm(tempDirectory, { recursive: true, force: true });
  app.quit();
}
