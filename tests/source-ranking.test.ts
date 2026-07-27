import assert from "node:assert/strict";
import test from "node:test";
import {
  sortSourcesByQuality,
  sourceQualityLabel,
  sourceRankingScore,
} from "../src/core/source-ranking.ts";

const now = Date.UTC(2026, 6, 27, 8, 0, 0);

test("active and recently used sources stay ahead in browse ordering", () => {
  const sources = [
    { key: "slow", name: "慢源", quality: { state: "healthy" as const, latencyMs: 300 } },
    { key: "recent", name: "最近源", quality: { state: "unknown" as const, latencyMs: 2_000 } },
    { key: "active", name: "当前源", quality: { state: "degraded" as const, latencyMs: 8_000 } },
  ];
  const ordered = sortSourcesByQuality(sources, {
    activeSiteKey: "active",
    recentSiteKeys: ["recent"],
    now,
  });
  assert.deepEqual(ordered.map((item) => item.key), ["active", "recent", "slow"]);
});

test("search ordering favors proven search success over unrelated overall success", () => {
  const proven = {
    key: "proven",
    quality: {
      state: "healthy" as const,
      latencyMs: 900,
      searchSuccessCount: 8,
      searchFailureCount: 1,
      lastSearchSuccessAt: now - 60_000,
      successCount: 8,
      failureCount: 1,
    },
  };
  const unrelated = {
    key: "unrelated",
    quality: {
      state: "healthy" as const,
      latencyMs: 300,
      searchSuccessCount: 0,
      searchFailureCount: 3,
      mediaSuccessCount: 10,
      successCount: 10,
      failureCount: 3,
    },
  };
  assert.ok(sourceRankingScore(proven, { now }, "search") > sourceRankingScore(unrelated, { now }, "search"));
});

test("favorite sources stay ahead of merely recent sources", () => {
  const sources = [
    { key: "recent", name: "最近源", quality: { state: "healthy" as const, latencyMs: 300 } },
    { key: "favorite", name: "收藏源", quality: { state: "unknown" as const, latencyMs: 2_000 } },
  ];
  const ordered = sortSourcesByQuality(sources, {
    favoriteSiteKeys: ["favorite"],
    recentSiteKeys: ["recent"],
    now,
  });
  assert.deepEqual(ordered.map((item) => item.key), ["favorite", "recent"]);
});

test("recent playback success and low latency improve browse ordering", () => {
  const recentPlayback = {
    key: "recent-playback",
    quality: {
      state: "healthy" as const,
      latencyMs: 1_200,
      lastMediaSuccessAt: now - 60_000,
      mediaSuccessCount: 2,
      mediaFailureCount: 0,
    },
  };
  const fastUnknown = {
    key: "fast-unknown",
    quality: { state: "unknown" as const, latencyMs: 200 },
  };
  const ordered = sortSourcesByQuality([fastUnknown, recentPlayback], { now }, "browse");
  assert.equal(ordered[0]?.key, "recent-playback");
  assert.equal(sourceQualityLabel(recentPlayback, now), "最近播放成功");
});

test("a recent failure lowers ranking without hiding the source", () => {
  const stable = {
    key: "stable",
    quality: { state: "healthy" as const, successCount: 3, failureCount: 1, lastSuccessAt: now - 1_000 },
  };
  const failing = {
    key: "failing",
    quality: { state: "degraded" as const, successCount: 3, failureCount: 2, lastFailureAt: now - 1_000 },
  };
  const ordered = sortSourcesByQuality([failing, stable], { now }, "browse");
  assert.deepEqual(ordered.map((item) => item.key), ["stable", "failing"]);
  assert.equal(sourceQualityLabel(failing, now), "偶有异常");
});
