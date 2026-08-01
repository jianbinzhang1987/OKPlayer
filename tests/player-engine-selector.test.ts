import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePlaybackMode,
  selectPlaybackEngine,
} from "../src/desktop/player-engine-selector.ts";

test("netdisk original-quality mp4 prefers libmpv while HLS stays on the web engine", () => {
  assert.equal(selectPlaybackEngine({
    format: "mp4",
    sourceUrl: "https://video-play-c-zb.pds.quark.cn/movie",
    headers: { Cookie: "redacted", Referer: "https://pan.quark.cn" },
    siteKey: "catvod:quark",
    flag: "夸克原画",
  }), "mpv");
  assert.equal(selectPlaybackEngine({
    format: "hls",
    sourceUrl: "https://video-play-c-zb.pds.quark.cn/movie.m3u8",
    headers: { Cookie: "redacted", "User-Agent": "FongMi" },
    siteKey: "catvod:quark",
    flag: "夸克原画",
  }), "web");
  assert.equal(selectPlaybackEngine({
    format: "mp4",
    sourceUrl: "https://bdd0.baidupcs.com/file/opaque-token",
    headers: { "User-Agent": "AndroidXMedia/1.5.1" },
    siteKey: "catvod:nodejs_duoduo",
    flag: "百度原画",
  }), "mpv");
});

test("explicit compatibility mode still forces the native mpv kernel", () => {
  assert.equal(selectPlaybackEngine({
    format: "mp4",
    sourceUrl: "https://video-play-c-zb.pds.quark.cn/movie",
    headers: { Cookie: "redacted" },
    siteKey: "catvod:quark",
    flag: "夸克原画",
    playbackMode: "compatibility",
  }), "mpv");
});

test("standard mode keeps web-compatible media on the web engine", () => {
  assert.equal(selectPlaybackEngine({
    format: "mp4",
    sourceUrl: "https://cdn.example.com/movie.mp4",
    headers: {},
    siteKey: "normal",
    flag: "直连",
    playbackMode: "standard",
  }), "web");
});

test("formats the web engine cannot play still route to mpv", () => {
  assert.equal(selectPlaybackEngine({
    format: "mkv",
    sourceUrl: "https://cdn.example.com/movie.mkv",
    headers: {},
    siteKey: "normal",
    flag: "直连",
  }), "mpv");
  assert.equal(selectPlaybackEngine({
    format: "flv",
    sourceUrl: "https://cdn.example.com/movie.flv",
    headers: {},
    siteKey: "normal",
    flag: "直连",
  }), "mpv");
  assert.equal(selectPlaybackEngine({
    format: "mpeg-ts",
    sourceUrl: "https://cdn.example.com/stream.ts",
    headers: {},
    siteKey: "normal",
    flag: "直连",
  }), "mpv");
});

test("unknown formats start on the web engine instead of guessing mpv", () => {
  assert.equal(selectPlaybackEngine({
    format: "unknown",
    sourceUrl: "https://video-play-c-zb.pds.quark.cn/opaque-token",
    headers: {},
    siteKey: "catvod:quark",
    flag: "夸克原画",
  }), "web");
});

test("playback mode normalization accepts only known values", () => {
  assert.equal(normalizePlaybackMode("standard"), "standard");
  assert.equal(normalizePlaybackMode("compatibility"), "compatibility");
  assert.equal(normalizePlaybackMode("auto"), "auto");
  assert.equal(normalizePlaybackMode(undefined), "auto");
  assert.equal(normalizePlaybackMode("whatever"), "auto");
});
