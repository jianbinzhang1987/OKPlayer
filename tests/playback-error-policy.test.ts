import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATIC_COMPATIBILITY_FALLBACK_DELAY_MS,
  normalizeCompatibilityFallbackMode,
  shouldScheduleCompatibilityFallback,
} from "../src/desktop/renderer/player/playback-error-policy.ts";

test("compatibility fallback policy normalizes persisted values", () => {
  assert.equal(normalizeCompatibilityFallbackMode("manual"), "manual");
  assert.equal(normalizeCompatibilityFallbackMode("automatic"), "automatic");
  assert.equal(normalizeCompatibilityFallbackMode("unexpected"), "automatic");
  assert.equal(normalizeCompatibilityFallbackMode(undefined), "automatic");
});

test("compatibility fallback only schedules for an active automatic session", () => {
  assert.equal(AUTOMATIC_COMPATIBILITY_FALLBACK_DELAY_MS, 4_000);
  assert.equal(shouldScheduleCompatibilityFallback({ mode: "automatic", fallbackTriggered: false, disposed: false }), true);
  assert.equal(shouldScheduleCompatibilityFallback({ mode: "manual", fallbackTriggered: false, disposed: false }), false);
  assert.equal(shouldScheduleCompatibilityFallback({ mode: "automatic", fallbackTriggered: true, disposed: false }), false);
  assert.equal(shouldScheduleCompatibilityFallback({ mode: "automatic", fallbackTriggered: false, disposed: true }), false);
});
