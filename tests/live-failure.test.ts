import assert from "node:assert/strict";
import test from "node:test";
import { classifyLiveFailure } from "../src/core/live/live-failure.ts";

test("live failure classification separates authentication region limits throttling and origin errors", () => {
  assert.equal(classifyLiveFailure("HTTP 401", 401).category, "authentication");
  assert.equal(classifyLiveFailure("not available in your region", 403).category, "geo-restriction");
  assert.equal(classifyLiveFailure("HTTP 451", 451).category, "geo-restriction");
  assert.equal(classifyLiveFailure("HTTP 429", 429).category, "rate-limit");
  assert.equal(classifyLiveFailure("HTTP 503", 503).category, "origin");
  assert.equal(classifyLiveFailure("socket timeout").category, "network");
  assert.equal(classifyLiveFailure("返回内容不是有效 HLS 清单").category, "invalid-media");
  assert.equal(classifyLiveFailure("DRM 保护：Widevine").category, "drm");
});

test("temporary live failures remain retryable while invalid media is definitive", () => {
  assert.equal(classifyLiveFailure("HTTP 503", 503).definitive, false);
  assert.equal(classifyLiveFailure("HTTP 429", 429).definitive, false);
  assert.equal(classifyLiveFailure("HTTP 404", 404).definitive, true);
  assert.equal(classifyLiveFailure("HTTP 451", 451).definitive, true);
});
