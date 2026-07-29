import assert from "node:assert/strict";
import test from "node:test";
import { classifyQualityFailure, qualityHidesSource, sourceQualityMetrics, type SourceQualityRecord } from "../src/core/source-quality.ts";

function record(state: SourceQualityRecord["state"], stage: SourceQualityRecord["stage"], failureCount = 0): SourceQualityRecord {
  return {
    configSource: "config",
    siteKey: "site",
    fingerprint: "fingerprint",
    state,
    stage,
    reason: "test",
    latencyMs: 0,
    checkedAt: 1,
    failureCount,
    successCount: 0,
  };
}

test("temporary home search and runtime failures remain visible", () => {
  assert.equal(qualityHidesSource(record("degraded", "home")), false);
  assert.equal(qualityHidesSource(record("blocked", "search")), false);
  assert.equal(qualityHidesSource(record("blocked", "runtime")), false);
});

test("only static runtime incompatibility hides a source", () => {
  assert.equal(qualityHidesSource(record("blocked", "static")), true);
  assert.equal(qualityHidesSource(record("blocked", "detail", 1)), false);
  assert.equal(qualityHidesSource(record("blocked", "player", 3)), false);
  assert.equal(qualityHidesSource(record("blocked", "media", 8)), false);
});

test("only strict playback failures are classified as blocked", () => {
  assert.equal(classifyQualityFailure("The operation was aborted due to timeout"), "degraded");
  assert.equal(classifyQualityFailure("fetch failed"), "degraded");
  assert.equal(classifyQualityFailure("媒体直链不可用：HTTP 404"), "blocked");
  assert.equal(classifyQualityFailure("详情接口未返回可播放剧集"), "blocked");
});

test("quality metrics track search and playback independently", () => {
  const search = sourceQualityMetrics(undefined, "search", "success", 100);
  assert.equal(search.lastSearchSuccessAt, 100);
  assert.equal(search.searchSuccessCount, 1);
  assert.equal(search.mediaSuccessCount, 0);

  const mediaFailure = sourceQualityMetrics({ ...record("healthy", "media"), ...search }, "media", "failure", 200);
  assert.equal(mediaFailure.lastSearchSuccessAt, 100);
  assert.equal(mediaFailure.searchSuccessCount, 1);
  assert.equal(mediaFailure.mediaFailureCount, 1);
  assert.equal(mediaFailure.lastFailureAt, 200);

  const preserved = sourceQualityMetrics({ ...record("checking", "static"), ...mediaFailure }, "static", "preserve", 300);
  assert.equal(preserved.lastFailureAt, 200);
  assert.equal(preserved.mediaFailureCount, 1);
});
