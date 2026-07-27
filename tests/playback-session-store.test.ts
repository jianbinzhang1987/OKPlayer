import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackSessionStore, isWebPlaybackCandidate, normalizePlaybackFormat } from "../src/desktop/media-protocol/playback-session-store.ts";

test("playback session keeps source headers in main process and exposes opaque resource URLs", () => {
  const store = new PlaybackSessionStore();
  const session = store.create({
    url: "https://media.example.com/live/master.m3u8?token=secret",
    headers: { Referer: "https://media.example.com/", Cookie: "sid=private" },
    format: "hls",
    resolvedBy: "browser-sniffer",
  }, {
    siteKey: "demo",
    vodId: "vod-1",
    vodName: "测试影片",
    episodeName: "第 1 集",
    episodeUrl: "episode-1",
  });

  const playbackUrl = store.playbackUrl(session.id);
  assert.match(playbackUrl, /^fongmi-media:\/\/session\//);
  assert.doesNotMatch(playbackUrl, /token|secret|Cookie|media\.example/);
  assert.equal(session.headers.Cookie, "sid=private");
  assert.equal(session.format, "hls");
  assert.equal(session.resolvedBy, "browser-sniffer");
});

test("playback session deduplicates rewritten HLS resources", () => {
  const store = new PlaybackSessionStore();
  const session = store.create({
    url: "https://cdn.example.com/master.m3u8",
    headers: {},
    resolvedBy: "direct",
  });

  const first = store.registerResource(session.id, "https://cdn.example.com/720/index.m3u8", "manifest", session.sourceUrl);
  const second = store.registerResource(session.id, "https://cdn.example.com/720/index.m3u8", "manifest", session.sourceUrl);
  const segment = store.registerResource(session.id, "https://cdn.example.com/720/1.ts", "segment", first.url);

  assert.equal(first.id, second.id);
  assert.notEqual(first.id, segment.id);
  assert.equal(store.getResource(session.id, segment.id).resource.url, "https://cdn.example.com/720/1.ts");
});

test("playback sessions can be counted by CatVod site prefix", () => {
  const store = new PlaybackSessionStore();
  const catVod = store.create({ url: "https://cdn.example.com/a.mp4", headers: {}, resolvedBy: "direct" }, { siteKey: "catvod:demo" });
  store.create({ url: "https://cdn.example.com/b.mp4", headers: {}, resolvedBy: "direct" }, { siteKey: "http-demo" });

  assert.equal(store.countBySitePrefix("catvod:"), 1);
  assert.equal(store.countBySitePrefix("http"), 1);
  store.close(catVod.id);
  assert.equal(store.countBySitePrefix("catvod:"), 0);
});

test("playback format selection is conservative", () => {
  assert.equal(normalizePlaybackFormat(undefined, "https://cdn.example.com/a.m3u8?token=1"), "hls");
  assert.equal(normalizePlaybackFormat("mp4", "https://cdn.example.com/no-extension"), "mp4");
  assert.equal(normalizePlaybackFormat(undefined, "https://cdn.example.com/a.mkv"), "unknown");
  assert.equal(isWebPlaybackCandidate("hls", "https://cdn.example.com/a.m3u8"), true);
  assert.equal(isWebPlaybackCandidate("flv", "https://cdn.example.com/a.flv"), false);
  assert.equal(isWebPlaybackCandidate("mp4", "/tmp/a.mp4"), false);
});
