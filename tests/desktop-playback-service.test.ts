import assert from "node:assert/strict";
import test from "node:test";
import { DesktopPlaybackService, isLikelyPlaybackPage, selectPlaybackEngine } from "../src/desktop/desktop-playback-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";

function createServices(url = "https://cdn.example.com/demo.mp4", probeOk = true) {
  const opened: Array<{ url: string; headers: Record<string, string> }> = [];
  const sniffed: Array<{ url: string; headers?: Record<string, string> }> = [];
  const source = {
    resolve: async () => ({ url, headers: { Referer: "https://example.com" }, format: url.endsWith(".flv") ? "flv" : "mp4", resolvedBy: "direct" as const }),
    playerResult: async () => ({ key: "s", flag: "line", url, parse: 0, playUrl: "", header: {} }),
    getConfig: () => ({ ads: [] }),
  };
  const fallback = {
    open: async (mediaUrl: string, headers: Record<string, string> = {}) => { opened.push({ url: mediaUrl, headers }); },
    stop: async () => undefined,
  };
  const sniffer = {
    sniff: async (pageUrl: string, options?: { headers?: Record<string, string> }) => {
      sniffed.push({ url: pageUrl, ...(options?.headers ? { headers: options.headers } : {}) });
      return { url: "https://cdn.example.com/sniffed.m3u8", headers: {}, format: "hls", resolvedBy: "browser-sniffer" as const };
    },
    cancel: () => undefined,
  };
  const sessions = new PlaybackSessionStore();
  const probe = async (mediaUrl: string) => probeOk ? ({
    ok: true,
    url: mediaUrl,
    statusCode: 206,
    mimeType: mediaUrl.endsWith(".flv") ? "video/x-flv" : "video/mp4",
    bytesRead: 32,
    format: mediaUrl.endsWith(".flv") ? "flv" : "mp4",
    reason: "媒体内容验证通过",
  }) : ({
    ok: false,
    url: mediaUrl,
    statusCode: 404,
    mimeType: "text/html",
    bytesRead: 0,
    reason: "HTTP 404",
  });
  return { service: new DesktopPlaybackService(source, fallback, sniffer, sessions, probe), sessions, opened, sniffed };
}

test("desktop playback prepares an opaque embedded session and supports fallback", async () => {
  const fixture = createServices();
  const prepared = await fixture.service.prepare({
    siteKey: "s",
    flag: "line",
    episodeUrl: "episode-1",
    vodId: "1",
    vodName: "影片",
    episodeName: "第1集",
  });

  assert.equal(prepared.engine, "web");
  assert.equal(prepared.format, "mp4");
  assert.match(prepared.playbackUrl, /^fongmi-media:\/\/session\//);
  assert.equal(fixture.sessions.size(), 1);

  await fixture.service.fallback(prepared.sessionId);
  assert.deepEqual(fixture.opened[0], {
    url: "https://cdn.example.com/demo.mp4",
    headers: { Referer: "https://example.com" },
  });
  assert.deepEqual(fixture.service.close(prepared.sessionId), { closed: true });
});

test("external playback is allowed only for sessions without protected headers", async () => {
  const calls: Array<{ url: string; preference: string }> = [];
  const source = {
    resolve: async () => ({ url: "https://cdn.example.com/public.mp4", headers: {}, format: "mp4", resolvedBy: "direct" as const }),
    playerResult: async () => ({ key: "s", flag: "line", url: "https://cdn.example.com/public.mp4", parse: 0, playUrl: "", header: {} }),
    getConfig: () => ({ ads: [] }),
  };
  const fallback = { open: async () => undefined, stop: async () => undefined };
  const sniffer = { sniff: async () => ({ url: "https://cdn.example.com/public.mp4", headers: {}, format: "mp4", resolvedBy: "direct" as const }), cancel: () => undefined };
  const sessions = new PlaybackSessionStore();
  const probe = async (url: string) => ({ ok: true, url, statusCode: 206, mimeType: "video/mp4", bytesRead: 32, format: "mp4", reason: "ok" });
  const external = { open: async (url: string, preference: "iina" | "vlc" | "system") => {
    calls.push({ url, preference });
    return { status: "opened" as const, player: preference };
  } };
  const service = new DesktopPlaybackService(source, fallback, sniffer, sessions, probe, external);
  const prepared = await service.prepare({ siteKey: "s", flag: "line", episodeUrl: "episode-1" });
  assert.deepEqual(await service.openExternal(prepared.sessionId, "iina"), { status: "opened", player: "iina" });
  assert.deepEqual(calls, [{ url: "https://cdn.example.com/public.mp4", preference: "iina" }]);

  const protectedSession = sessions.create({
    url: "https://cdn.example.com/protected.mp4",
    headers: { Referer: "https://pan.example.com" },
    format: "mp4",
    resolvedBy: "direct",
  });
  await assert.rejects(() => service.openExternal(protectedSession.id, "iina"), /不能安全传递/);
});

test("web-compatible protected Quark media stays in the application window first", () => {
  assert.equal(selectPlaybackEngine(
    "mp4",
    "https://video-play-c-zb.pds.quark.cn/movie",
    { Cookie: "redacted", Referer: "https://pan.quark.cn" },
    { siteKey: "catvod:quark", flag: "夸克极速" },
  ), "web");
  assert.equal(selectPlaybackEngine(
    "hls",
    "https://video-play-c-zb.pds.quark.cn/movie.m3u8",
    { Cookie: "redacted", "User-Agent": "FongMi" },
    { siteKey: "catvod:quark", flag: "夸克原画" },
  ), "web");
  assert.equal(selectPlaybackEngine(
    "mp4",
    "https://cdn.example.com/movie.mp4",
    {},
    { siteKey: "normal", flag: "直连" },
  ), "web");
});

test("protected extensionless media is probed before engine routing", async () => {
  const fixture = createServices("https://video-play-c-zb.pds.quark.cn/opaque-media-token");
  const prepared = await fixture.service.prepare({ siteKey: "catvod:quark", flag: "夸克极速", episodeUrl: "episode-1" });
  assert.equal(prepared.format, "mp4");
  assert.equal(prepared.engine, "web");
  assert.match(prepared.playbackUrl, /^fongmi-media:\/\/session\//);
});

test("protected pan media reports expired authentication without degrading the source", async () => {
  const failures: Array<{ reason: string; impact?: string }> = [];
  const source = {
    resolve: async () => ({
      url: "https://pan.example.com/protected.mp4",
      headers: { Cookie: "redacted", Referer: "https://pan.quark.cn" },
      format: "mp4",
      resolvedBy: "direct" as const,
    }),
    playerResult: async () => ({ key: "s", flag: "夸克极速", url: "https://pan.example.com/protected.mp4", parse: 0, playUrl: "", header: {} }),
    getConfig: () => ({ ads: [] }),
    recordPlaybackFailure: async (_siteKey: string, reason: string, _latency: number, impact?: string) => { failures.push({ reason, impact }); },
  };
  const fallback = { open: async () => undefined, stop: async () => undefined };
  const sniffer = { sniff: async () => ({ url: "https://pan.example.com/protected.mp4", headers: {}, format: "mp4", resolvedBy: "direct" as const }), cancel: () => undefined };
  const probe = async (url: string) => ({ ok: false, url, statusCode: 403, mimeType: "text/plain", bytesRead: 0, reason: "HTTP 403" });
  const service = new DesktopPlaybackService(source, fallback, sniffer, new PlaybackSessionStore(), probe);

  await assert.rejects(
    service.prepare({ siteKey: "catvod:quark", flag: "夸克极速", episodeUrl: "quark://episode-1" }),
    (error: any) => error?.code === "AUTH_EXPIRED" && error?.sourceImpact === "none",
  );
  assert.deepEqual(failures, []);
});

test("desktop playback routes unsupported formats to compatibility mode", async () => {
  const fixture = createServices("https://cdn.example.com/demo.flv");
  const prepared = await fixture.service.prepare({ siteKey: "s", flag: "line", episodeUrl: "episode-1" });
  assert.equal(prepared.engine, "mpv");
});

test("desktop playback rejects definitively dead direct media before creating a session", async () => {
  const fixture = createServices("https://cdn.example.com/dead.m3u8", false);
  await assert.rejects(
    fixture.service.prepare({ siteKey: "s", flag: "line", episodeUrl: "episode-1" }),
    /媒体直链不可用：HTTP 404/,
  );
  assert.equal(fixture.sessions.size(), 0);
  assert.equal(fixture.sniffed.length, 0);
});

test("desktop playback sends obvious video pages to browser sniffing", async () => {
  assert.equal(isLikelyPlaybackPage("https://www.iqiyi.com/v_12ujg5qi8f8.html"), true);
  assert.equal(isLikelyPlaybackPage("https://v.youku.com/v_show/id_demo.html"), true);
  assert.equal(isLikelyPlaybackPage("https://cdn.example.com/stream?id=1"), false);
  assert.equal(isLikelyPlaybackPage("https://cdn.example.com/demo.m3u8"), false);

  const fixture = createServices("https://www.iqiyi.com/v_12ujg5qi8f8.html");
  const prepared = await fixture.service.prepare({ siteKey: "s", flag: "qiyi", episodeUrl: "episode-1" });
  assert.equal(prepared.resolvedBy, "browser-sniffer");
  assert.equal(prepared.format, "hls");
  assert.equal(fixture.sniffed[0]?.url, "https://www.iqiyi.com/v_12ujg5qi8f8.html");
  assert.deepEqual(fixture.sniffed[0]?.headers, { Referer: "https://example.com" });
});
