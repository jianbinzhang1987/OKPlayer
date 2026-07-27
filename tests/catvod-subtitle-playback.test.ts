import assert from "node:assert/strict";
import test from "node:test";
import { DesktopPlaybackService } from "../src/desktop/desktop-playback-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";

test("CatVod subtitle and danmaku URLs are registered in the protected playback session", async () => {
  const source = {
    resolve: async () => ({
      url: "https://media.example.com/video.mp4",
      headers: { Referer: "https://example.com/" },
      format: "mp4",
      subtitleUrl: "https://media.example.com/subtitle.vtt",
      danmakuUrl: "https://media.example.com/danmaku.json",
      contentKind: "vod" as const,
      resolvedBy: "direct" as const,
    }),
    playerResult: async () => ({ key: "s", flag: "line", url: "", parse: 0, playUrl: "", header: {} }),
    getConfig: () => ({ ads: [] }),
  };
  const sessions = new PlaybackSessionStore();
  const service = new DesktopPlaybackService(
    source,
    { open: async () => undefined, stop: async () => undefined },
    { sniff: async () => { throw new Error("not expected"); }, cancel: () => undefined },
    sessions,
    async (url) => ({
      ok: true,
      url,
      statusCode: 206,
      mimeType: "video/mp4",
      bytesRead: 64,
      format: "mp4",
      reason: "ok",
    }),
  );

  const prepared = await service.prepare({ siteKey: "s", flag: "line", episodeUrl: "episode" });
  assert.match(prepared.subtitleUrl ?? "", /^fongmi-media:\/\/session\//);
  assert.match(prepared.danmakuUrl ?? "", /^fongmi-media:\/\/session\//);
  assert.equal(prepared.contentKind, "vod");
  const kinds = [...sessions.get(prepared.sessionId).resources.values()].map((resource) => resource.kind).sort();
  assert.deepEqual(kinds, ["danmaku", "media", "subtitle"]);
});
