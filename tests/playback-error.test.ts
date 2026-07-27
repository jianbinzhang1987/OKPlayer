import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPlaybackFailure,
  PlaybackFailure,
  serializePlaybackFailure,
} from "../src/desktop/playback-error.ts";
import { DesktopPlaybackService } from "../src/desktop/desktop-playback-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";

test("playback failures distinguish authentication transport engines and unavailable lines", () => {
  const required = classifyPlaybackFailure(new Error("请先登录夸克网盘"));
  assert.equal(required.code, "AUTH_REQUIRED");
  assert.equal(required.sourceImpact, "none");

  const expired = classifyPlaybackFailure(new Error("夸克 Cookie 已失效"));
  assert.equal(expired.code, "AUTH_EXPIRED");
  assert.equal(expired.sourceImpact, "none");

  const range = classifyPlaybackFailure(new Error("proxy.chunk.download.incomplete"));
  assert.equal(range.code, "RANGE_PROXY_FAILED");
  assert.equal(range.sourceImpact, "none");

  const web = classifyPlaybackFailure(new Error("媒体加载失败（错误代码 4）"));
  assert.equal(web.code, "WEB_ENGINE_UNSUPPORTED");
  assert.equal(web.sourceImpact, "none");

  const line = classifyPlaybackFailure(new Error("媒体直链不可用：HTTP 404"));
  assert.equal(line.code, "LINE_UNAVAILABLE");
  assert.equal(line.sourceImpact, "degraded");
});

test("serialized playback failures preserve user-facing recovery metadata", () => {
  const serialized = serializePlaybackFailure(new PlaybackFailure("MEDIA_URL_EXPIRED", "HTTP 403"));
  assert.deepEqual(serialized, {
    code: "MEDIA_URL_EXPIRED",
    message: "HTTP 403",
    userMessage: "播放地址已过期，请重新解析或更换线路。",
    retryable: true,
    sourceImpact: "none",
  });
});

test("authentication failures do not mark the source as degraded or blocked", async () => {
  const recorded: Array<{ reason: string; impact: string | undefined }> = [];
  const source = {
    resolve: async () => { throw new Error("夸克 Cookie 已失效"); },
    playerResult: async () => { throw new Error("夸克 Cookie 已失效"); },
    getConfig: () => ({ ads: [] }),
    recordPlaybackFailure: async (_siteKey: string, reason: string, _latencyMs?: number, impact?: string) => {
      recorded.push({ reason, impact });
    },
  };
  const service = new DesktopPlaybackService(
    source,
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { throw new Error("夸克 Cookie 已失效"); }, cancel: () => undefined },
    new PlaybackSessionStore(),
  );

  await assert.rejects(
    service.prepare({ siteKey: "quark", flag: "夸克极速", episodeUrl: "episode" }),
    (error: unknown) => error instanceof PlaybackFailure && error.code === "AUTH_EXPIRED",
  );
  assert.deepEqual(recorded, []);
});

test("a dead media line is recorded as degraded instead of blocking the whole source", async () => {
  const recorded: Array<{ reason: string; impact: string | undefined }> = [];
  const source = {
    resolve: async () => ({
      url: "https://cdn.example.com/dead.m3u8",
      headers: {},
      format: "hls",
      resolvedBy: "direct" as const,
    }),
    playerResult: async () => ({ key: "dead", flag: "line", url: "", parse: 0, playUrl: "", header: {} }),
    getConfig: () => ({ ads: [] }),
    recordPlaybackFailure: async (_siteKey: string, reason: string, _latencyMs?: number, impact?: string) => {
      recorded.push({ reason, impact });
    },
  };
  const service = new DesktopPlaybackService(
    source,
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { throw new Error("不应调用嗅探"); }, cancel: () => undefined },
    new PlaybackSessionStore(),
    async (url: string) => ({
      ok: false,
      url,
      statusCode: 404,
      mimeType: "text/html",
      bytesRead: 0,
      reason: "HTTP 404",
    }),
  );

  await assert.rejects(
    service.prepare({ siteKey: "dead", flag: "线路", episodeUrl: "episode" }),
    (error: unknown) => error instanceof PlaybackFailure && error.code === "LINE_UNAVAILABLE",
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.impact, "degraded");
});

test("compatibility player startup failures use a dedicated error code", async () => {
  const sessions = new PlaybackSessionStore();
  const service = new DesktopPlaybackService(
    {
      resolve: async () => ({
        url: "https://cdn.example.com/movie.flv",
        headers: {},
        format: "flv",
        resolvedBy: "direct" as const,
      }),
      playerResult: async () => ({ key: "s", flag: "line", url: "", parse: 0, playUrl: "", header: {} }),
      getConfig: () => ({ ads: [] }),
    },
    { open: async () => { throw new Error("mpv executable not found"); }, stop: async () => undefined },
    { sniff: async () => { throw new Error("不应调用嗅探"); }, cancel: () => undefined },
    sessions,
    async (url: string) => ({
      ok: true,
      url,
      statusCode: 206,
      mimeType: "video/x-flv",
      bytesRead: 32,
      format: "flv",
      reason: "媒体内容验证通过",
    }),
  );
  const prepared = await service.prepare({ siteKey: "s", flag: "line", episodeUrl: "episode" });
  assert.equal(prepared.engine, "mpv");
  await assert.rejects(
    service.fallback(prepared.sessionId),
    (error: unknown) => error instanceof PlaybackFailure && error.code === "COMPAT_ENGINE_FAILED",
  );
});
