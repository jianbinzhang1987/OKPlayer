import test from "node:test";
import assert from "node:assert/strict";
import { resolveEpisodeNavigation, resolveFallbackPlaybackLine, resolvePlaybackEpisodeTarget, resolvePreferredPlaybackLine } from "../src/desktop/renderer/player-navigation.ts";

const lines = [
  {
    flag: "main",
    episodes: [
      { name: "第1集", url: "ep-1" },
      { name: "第2集", url: "ep-2" },
      { name: "第3集", url: "ep-3" },
    ],
  },
  {
    flag: "backup",
    episodes: [{ name: "备用1", url: "backup-1" }],
  },
];

test("episode navigation resolves previous and next episodes in the active line", () => {
  const result = resolveEpisodeNavigation(lines, "main", "ep-2");
  assert.equal(result?.flag, "main");
  assert.equal(result?.currentIndex, 1);
  assert.equal(result?.previous?.url, "ep-1");
  assert.equal(result?.next?.url, "ep-3");
});

test("episode navigation falls back to the line containing the current episode", () => {
  const result = resolveEpisodeNavigation(lines, "main", "backup-1");
  assert.equal(result?.flag, "backup");
  assert.equal(result?.currentIndex, 0);
  assert.equal(result?.previous, undefined);
  assert.equal(result?.next, undefined);
});

test("episode navigation returns undefined for unknown episodes", () => {
  assert.equal(resolveEpisodeNavigation(lines, "main", "missing"), undefined);
});

test("preferred playback line favors direct media over a share page", () => {
  const result = resolvePreferredPlaybackLine([
    { flag: "share", episodes: [{ name: "HD", url: "https://video.example.com/share/abc" }] },
    { flag: "hls", episodes: [{ name: "HD", url: "https://cdn.example.com/movie/index.m3u8" }] },
  ]);
  assert.equal(result?.flag, "hls");
});

test("netdisk lines prefer original quality regardless of the line preference", () => {
  const quarkLines = [
    { flag: "夸克原画", episodes: [{ name: "第1集", url: "encoded-quark-file" }] },
    { flag: "夸克极速", episodes: [{ name: "第1集", url: "encoded-quark-file" }] },
  ];
  assert.equal(resolvePreferredPlaybackLine(quarkLines, "stable")?.flag, "夸克原画");
  assert.equal(resolvePreferredPlaybackLine(quarkLines, "quality")?.flag, "夸克原画");
});

test("netdisk original quality outranks a direct speed line", () => {
  const lines = [
    { flag: "夸克极速", episodes: [{ name: "第1集", url: "https://cdn.example.com/movie.m3u8" }] },
    { flag: "夸克原画", episodes: [{ name: "第1集", url: "encoded-quark-file" }] },
  ];
  assert.equal(resolvePreferredPlaybackLine(lines, "stable")?.flag, "夸克原画");
});

test("non-netdisk sources keep stable preference choosing speed lines first", () => {
  const lines = [
    { flag: "超清", episodes: [{ name: "第1集", url: "share-token" }] },
    { flag: "极速", episodes: [{ name: "第1集", url: "share-token" }] },
  ];
  assert.equal(resolvePreferredPlaybackLine(lines, "stable")?.flag, "极速");
  assert.equal(resolvePreferredPlaybackLine(lines, "quality")?.flag, "超清");
});

test("empty and generic lines remain behind stable or quality-labelled lines", () => {
  const lines = [
    { flag: "空线路", episodes: [] },
    { flag: "普通线路", episodes: [{ name: "第1集", url: "share-token" }] },
    { flag: "秒播线路", episodes: [{ name: "第1集", url: "share-token" }] },
  ];
  assert.equal(resolvePreferredPlaybackLine(lines, "stable")?.flag, "秒播线路");
});

test("cross-source episode target matches normalized episode names before index", () => {
  const target = resolvePlaybackEpisodeTarget([
    { flag: "备用极速", episodes: [{ name: "EP01", url: "backup-1" }, { name: "EP02", url: "backup-2" }] },
  ], { name: "第02集", url: "origin-2" }, 0, "stable");
  assert.equal(target?.line.flag, "备用极速");
  assert.equal(target?.episode.url, "backup-2");
});

test("cross-source episode target falls back to the same episode index", () => {
  const target = resolvePlaybackEpisodeTarget([
    { flag: "备用", episodes: [{ name: "上", url: "backup-1" }, { name: "下", url: "backup-2" }] },
  ], { name: "第二话", url: "origin-2" }, 1, "stable");
  assert.equal(target?.episode.url, "backup-2");
});

test("fallback playback keeps the same episode and follows the line preference", () => {
  const fallback = resolveFallbackPlaybackLine([
    { flag: "夸克原画", episodes: [{ name: "第1集", url: "original-1" }, { name: "第2集", url: "original-2" }] },
    { flag: "夸克极速", episodes: [{ name: "第1集", url: "speed-1" }, { name: "第2集", url: "speed-2" }] },
    { flag: "备用线路", episodes: [{ name: "第1集", url: "backup-1" }, { name: "第2集", url: "backup-2" }] },
  ], "夸克原画", { name: "第2集", url: "original-2" }, [], "stable");
  assert.equal(fallback?.line.flag, "夸克极速");
  assert.equal(fallback?.episode.url, "speed-2");
});

test("fallback playback skips attempted lines and can match by episode index", () => {
  const fallback = resolveFallbackPlaybackLine([
    { flag: "主线路", episodes: [{ name: "上集", url: "main-1" }, { name: "下集", url: "main-2" }] },
    { flag: "秒播线路", episodes: [{ name: "A", url: "speed-1" }, { name: "B", url: "speed-2" }] },
    { flag: "备用线路", episodes: [{ name: "第一话", url: "backup-1" }, { name: "第二话", url: "backup-2" }] },
  ], "主线路", { name: "下集", url: "main-2" }, ["秒播线路"], "stable");
  assert.equal(fallback?.line.flag, "备用线路");
  assert.equal(fallback?.episode.url, "backup-2");
  assert.equal(resolveFallbackPlaybackLine([
    { flag: "主线路", episodes: [{ name: "第1集", url: "main-1" }] },
    { flag: "备用线路", episodes: [{ name: "第1集", url: "backup-1" }] },
  ], "主线路", { name: "第1集", url: "main-1" }, ["备用线路"]), undefined);
});
