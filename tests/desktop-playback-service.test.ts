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

test("web playback can consume media through the loopback HTTP gateway", async () => {
  const fixture = createServices();
  const service = new DesktopPlaybackService(
    {
      resolve: async () => ({ url: "https://cdn.example.com/demo.mp4", headers: {}, format: "mp4", resolvedBy: "direct" as const }),
      playerResult: async () => ({ key: "s", flag: "line", url: "https://cdn.example.com/demo.mp4", parse: 0, playUrl: "", header: {} }),
      getConfig: () => ({ ads: [] }),
    },
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { throw new Error("不应调用嗅探"); }, cancel: () => undefined },
    fixture.sessions,
    async (url: string) => ({ ok: true, url, statusCode: 206, mimeType: "video/mp4", bytesRead: 32, format: "mp4", reason: "ok" }),
    undefined,
    undefined,
    (session) => `http://127.0.0.1:43210/session/${session.id}/resource/root`,
  );
  const prepared = await service.prepare({ siteKey: "s", flag: "直连", episodeUrl: "episode-1" });
  assert.equal(prepared.engine, "web");
  assert.match(prepared.playbackUrl, /^http:\/\/127\.0\.0\.1:43210\/session\//);
});

test("native playback can use an opaque local gateway without passing pan headers to mpv", async () => {
  const opened: Array<{ url: string; headers?: Record<string, string> }> = [];
  const sessions = new PlaybackSessionStore();
  const service = new DesktopPlaybackService(
    {
      resolve: async () => ({ url: "https://cdn.example.com/protected.mkv", headers: { Cookie: "secret" }, format: "mkv", resolvedBy: "direct" as const }),
      playerResult: async () => ({ key: "s", flag: "夸克原画", url: "", parse: 0, playUrl: "", header: {} }),
      getConfig: () => ({ ads: [] }),
    },
    { open: async (url: string, headers?: Record<string, string>) => { opened.push({ url, headers }); }, stop: async () => undefined },
    { sniff: async () => { throw new Error("不应调用嗅探"); }, cancel: () => undefined },
    sessions,
    async (url: string) => ({ ok: true, url, statusCode: 206, mimeType: "video/x-matroska", bytesRead: 32, format: "mkv", reason: "ok" }),
    undefined,
    (session) => ({ url: `http://127.0.0.1:43210/session/${session.id}/resource/root` }),
  );
  const prepared = await service.prepare({ siteKey: "catvod:quark", flag: "夸克原画", episodeUrl: "episode-1" });
  await service.fallback(prepared.sessionId);
  assert.match(opened[0]?.url ?? "", /^http:\/\/127\.0\.0\.1:43210\/session\//);
  assert.deepEqual(opened[0]?.headers, undefined);
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

test("netdisk original-quality MP4 prefers compatibility playback while ordinary MP4 stays web-compatible", () => {
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
  assert.equal(selectPlaybackEngine(
    "mp4",
    "https://bdd0.baidupcs.com/file/opaque-token",
    { "User-Agent": "AndroidXMedia/1.5.1" },
    { siteKey: "catvod:nodejs_duoduo", flag: "百度原画" },
  ), "mpv");
  assert.equal(selectPlaybackEngine(
    "mp4",
    "https://video-play-c-zb.pds.quark.cn/movie",
    { Cookie: "redacted" },
    { siteKey: "catvod:nodejs_duoduo", flag: "夸克原画", playbackMode: "standard" },
  ), "web");
});

test("protected extensionless media is probed before engine routing", async () => {
  const fixture = createServices("https://video-play-c-zb.pds.quark.cn/opaque-media-token");
  const prepared = await fixture.service.prepare({ siteKey: "catvod:quark", flag: "夸克极速", episodeUrl: "episode-1" });
  assert.equal(prepared.format, "mp4");
  assert.equal(prepared.engine, "web");
  assert.match(prepared.playbackUrl, /^fongmi-media:\/\/session\//);
});

test("local Quark original proxy is unwrapped and its MKV container routes straight to mpv", async () => {
  const upstreamUrl = "https://dl-pc-zb.drive.quark.cn/file/opaque-token";
  const upstreamHeaders = {
    "User-Agent": "quark-cloud-drive/2.5.20",
    Cookie: "session=redacted",
    Referer: "https://pan.quark.cn/",
  };
  const payload = Buffer.from(JSON.stringify({ url: upstreamUrl, headers: upstreamHeaders })).toString("base64url");
  const proxyUrl = `http://127.0.0.1:54669/spider/demo/3/proxy/quark/session-id?pst=${payload}`;
  const probes: Array<{ url: string; headers?: Record<string, string> }> = [];
  const source = {
    resolve: async () => ({ url: proxyUrl, headers: {}, resolvedBy: "direct" as const }),
    playerResult: async () => ({ key: "s", flag: "夸克原画", url: proxyUrl, parse: 0, playUrl: "", header: {} }),
    getConfig: () => ({ ads: [] }),
  };
  const fallback = { open: async () => undefined, stop: async () => undefined };
  const sniffer = { sniff: async () => ({ url: upstreamUrl, headers: upstreamHeaders, format: "mkv", resolvedBy: "direct" as const }), cancel: () => undefined };
  const sessions = new PlaybackSessionStore();
  const probe = async (url: string, options?: { headers?: Record<string, string> }) => {
    probes.push({ url, headers: options?.headers });
    return { ok: true, url, statusCode: 206, mimeType: "video/x-matroska", bytesRead: 64 * 1024, format: "mkv", reason: "媒体内容验证通过" };
  };
  const service = new DesktopPlaybackService(source, fallback, sniffer, sessions, probe);

  const prepared = await service.prepare({ siteKey: "catvod:demo", flag: "夸克原画", episodeUrl: "episode-1" });
  const session = sessions.get(prepared.sessionId);
  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.url, upstreamUrl);
  // Playback stays on the proxy URL so the CatVod proxy pulls the CDN with
  // parallel chunked streams instead of a slow single direct connection.
  assert.equal(session.sourceUrl, proxyUrl);
  assert.deepEqual(session.headers, {});
  assert.equal(prepared.format, "mkv");
  assert.equal(prepared.engine, "mpv");
});

test("local Baidu original proxy is unwrapped and its MP4 container routes to libmpv", async () => {
  const upstreamUrl = "https://bdd0.baidupcs.com/file/opaque-token";
  const payload = Buffer.from(JSON.stringify({
    url: upstreamUrl,
    headers: {
      "User-Agent": "AndroidXMedia/1.5.1",
      Connection: "keep-alive",
      Injected: "unsafe\r\nheader",
    },
  })).toString("base64url");
  const proxyUrl = `http://127.0.0.1:54669/spider/demo/3/proxy/baidu/session-id?pst=${payload}`;
  const probes: Array<{ url: string; headers?: Record<string, string> }> = [];
  const source = {
    resolve: async () => ({ url: proxyUrl, headers: {}, resolvedBy: "direct" as const }),
    playerResult: async () => ({ key: "s", flag: "百度原画", url: proxyUrl, parse: 0, playUrl: "", header: {} }),
    getConfig: () => ({ ads: [] }),
  };
  const fallback = { open: async () => undefined, stop: async () => undefined };
  const sniffer = { sniff: async () => ({ url: upstreamUrl, headers: {}, format: "mp4", resolvedBy: "direct" as const }), cancel: () => undefined };
  const sessions = new PlaybackSessionStore();
  const probe = async (url: string, options?: { headers?: Record<string, string> }) => {
    probes.push({ url, headers: options?.headers });
    return { ok: true, url, statusCode: 206, mimeType: "video/mp4", bytesRead: 64 * 1024, format: "mp4", reason: "媒体内容验证通过" };
  };
  const service = new DesktopPlaybackService(source, fallback, sniffer, sessions, probe);

  const prepared = await service.prepare({ siteKey: "catvod:nodejs_demo", flag: "百度原画", episodeUrl: "episode-1" });
  const session = sessions.get(prepared.sessionId);
  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.url, upstreamUrl);
  assert.deepEqual(probes[0]?.headers, { "User-Agent": "AndroidXMedia/1.5.1" });
  assert.equal(session.sourceUrl, upstreamUrl);
  assert.deepEqual(session.headers, { "User-Agent": "AndroidXMedia/1.5.1" });
  assert.equal(prepared.format, "mp4");
  assert.equal(prepared.engine, "mpv");
});

test("a failed advisory probe on a pan proxy keeps the format unknown without flipping the line", async () => {
  const upstreamUrl = "https://dl-pc-zb.drive.quark.cn/file/opaque-token";
  const payload = Buffer.from(JSON.stringify({ url: upstreamUrl, headers: { Cookie: "session=redacted" } })).toString("base64url");
  const proxyUrl = `http://127.0.0.1:54669/spider/demo/3/proxy/quark/session-id?pst=${payload}`;
  const sessions = new PlaybackSessionStore();
  const service = new DesktopPlaybackService(
    {
      resolve: async () => ({ url: proxyUrl, headers: {}, resolvedBy: "direct" as const }),
      playerResult: async () => ({ key: "s", flag: "夸克原画", url: proxyUrl, parse: 0, playUrl: "", header: {} }),
      getConfig: () => ({ ads: [] }),
    },
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { throw new Error("不应调用嗅探"); }, cancel: () => undefined },
    sessions,
    async (url: string) => ({ ok: false, url, statusCode: 412, mimeType: "text/html", bytesRead: 0, reason: "HTTP 412" }),
  );

  const prepared = await service.prepare({ siteKey: "catvod:demo", flag: "夸克原画", episodeUrl: "episode-1" });
  assert.equal(prepared.format, "unknown");
  assert.equal(prepared.engine, "web");
  assert.equal(sessions.get(prepared.sessionId).sourceUrl, proxyUrl);
});

test("a pan proxy probe that THROWS (abort/timeout) must not flip the line or burn the link", async () => {
  const upstreamUrl = "https://dl-pc-zb.drive.quark.cn/file/opaque-token";
  const payload = Buffer.from(JSON.stringify({ url: upstreamUrl, headers: { Cookie: "session=redacted" } })).toString("base64url");
  const proxyUrl = `http://127.0.0.1:54669/spider/demo/3/proxy/quark/session-id?pst=${payload}`;
  const sessions = new PlaybackSessionStore();
  let snifferCalled = false;
  const service = new DesktopPlaybackService(
    {
      resolve: async () => ({ url: proxyUrl, headers: {}, resolvedBy: "direct" as const }),
      playerResult: async () => { throw new Error("不应调用解析兜底"); },
      getConfig: () => ({ ads: [] }),
    },
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { snifferCalled = true; throw new Error("网页嗅探不应参与代理链接"); }, cancel: () => undefined },
    sessions,
    async () => {
      // probeMediaUrl aborts on the 4s timeout; the AbortError THROWS instead
      // of returning a MediaProbeResult. This must be swallowed for pan
      // proxies — it previously leaked into the sniffer fallback and flipped
      // the line (夸克原画 → 百度原画).
      throw new DOMException("The operation was aborted", "AbortError");
    },
  );

  const prepared = await service.prepare({ siteKey: "catvod:demo", flag: "夸克原画", episodeUrl: "episode-1" });
  assert.equal(prepared.format, "unknown");
  assert.equal(prepared.engine, "web");
  assert.equal(snifferCalled, false);
  assert.equal(sessions.get(prepared.sessionId).sourceUrl, proxyUrl);
});

test("a CatVod pan proxy carrying pst is unwrapped even when its host has not been rebound yet", async () => {
  const upstreamUrl = "https://dl-pc-zb.drive.quark.cn/file/opaque-token";
  const payload = Buffer.from(JSON.stringify({ url: upstreamUrl, headers: { Cookie: "session=redacted" } })).toString("base64url");
  const proxyUrl = `http://catvod-runtime.invalid/spider/demo/3/proxy/quark/session-id?pst=${payload}`;
  let probeCalls = 0;
  const sessions = new PlaybackSessionStore();
  const service = new DesktopPlaybackService(
    {
      resolve: async () => ({ url: proxyUrl, headers: {}, resolvedBy: "direct" as const }),
      playerResult: async () => ({ key: "s", flag: "夸克原画", url: proxyUrl, parse: 0, playUrl: "", header: {} }),
      getConfig: () => ({ ads: [] }),
    },
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { throw new Error("不应调用嗅探"); }, cancel: () => undefined },
    sessions,
    async (url: string) => {
      probeCalls += 1;
      return { ok: true, url, statusCode: 206, mimeType: "video/x-matroska", bytesRead: 32, format: "mkv", reason: "ok" };
    },
  );
  const prepared = await service.prepare({ siteKey: "catvod:demo", flag: "夸克原画", episodeUrl: "episode-1" });
  assert.equal(probeCalls, 1);
  assert.equal(sessions.get(prepared.sessionId).sourceUrl, proxyUrl);
});

test("raw local pan proxies are probed and original-quality MP4 uses libmpv", async () => {
  let probeCalls = 0;
  const proxyUrl = "http://127.0.0.1:54669/spider/demo/3/proxy/quark/session-id";
  const service = new DesktopPlaybackService(
    {
      resolve: async () => ({ url: proxyUrl, headers: {}, resolvedBy: "direct" as const }),
      playerResult: async () => ({ key: "s", flag: "夸克原画", url: proxyUrl, parse: 0, playUrl: "", header: {} }),
      getConfig: () => ({ ads: [] }),
    },
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { throw new Error("不应调用嗅探"); }, cancel: () => undefined },
    new PlaybackSessionStore(),
    async (url: string) => {
      probeCalls += 1;
      return { ok: true, url, statusCode: 206, mimeType: "video/mp4", bytesRead: 32, format: "mp4", reason: "ok" };
    },
  );

  const prepared = await service.prepare({ siteKey: "catvod:demo", flag: "夸克原画", episodeUrl: "episode-1" });
  assert.equal(probeCalls, 1);
  assert.equal(prepared.engine, "mpv");
});

test("a 412 response from a pan original link is reported as an expired link for same-line re-fetch", async () => {
  const url = "https://dl-pc-zb.drive.quark.cn/file/opaque-token";
  const service = new DesktopPlaybackService(
    {
      resolve: async () => ({ url, headers: { Cookie: "session=redacted" }, resolvedBy: "direct" as const }),
      playerResult: async () => ({ key: "s", flag: "夸克原画", url, parse: 0, playUrl: "", header: {} }),
      getConfig: () => ({ ads: [] }),
    },
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { throw new Error("不应调用嗅探"); }, cancel: () => undefined },
    new PlaybackSessionStore(),
    async (url: string) => ({ ok: false, url, statusCode: 412, mimeType: "text/html", bytesRead: 32, reason: "HTTP 412" }),
  );

  await assert.rejects(
    service.prepare({ siteKey: "catvod:quark", flag: "夸克原画", episodeUrl: "quark://episode-1" }),
    (error: any) => error?.code === "MEDIA_URL_EXPIRED"
      && error?.retryable === true
      && error?.sourceImpact === "none",
  );
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

test("desktop playback routes unsupported formats and explicit compatibility mode to compatibility mode", async () => {
  const fixture = createServices("https://cdn.example.com/demo.flv");
  const prepared = await fixture.service.prepare({ siteKey: "s", flag: "line", episodeUrl: "episode-1" });
  assert.equal(prepared.engine, "mpv");

  const forced = createServices("https://cdn.example.com/demo.mp4");
  const forcedPrepared = await forced.service.prepare({
    siteKey: "s",
    flag: "line",
    episodeUrl: "episode-1",
    playbackMode: "compatibility",
  });
  assert.equal(forcedPrepared.engine, "mpv");
});

test("desktop playback keeps standard mode on web-compatible media", async () => {
  const fixture = createServices("https://cdn.example.com/demo.mp4");
  const prepared = await fixture.service.prepare({
    siteKey: "s",
    flag: "line",
    episodeUrl: "episode-1",
    playbackMode: "standard",
  });
  assert.equal(prepared.engine, "web");
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
