import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);

test("renderer persists a user-facing stable or original line preference", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    "linePreference",
    "默认线路偏好",
    "稳定优先",
    "原画优先",
    'setSetting("linePreference"',
    'getSetting("linePreference", "stable")',
    "preferredPlaybackLine",
    "· 推荐",
  ]) assert.ok(source.includes(marker), `missing line preference marker: ${marker}`);
});

test("playback history stores and restores the selected line", async () => {
  const source = await readFile(appPath, "utf8");
  assert.ok(source.includes("flag: current.flag"));
  assert.ok(source.includes("flag,\n      position: Math.max(0, startPosition)"));
  assert.ok(source.includes("history.flag"));
  assert.ok(source.includes("line.flag === history.flag"));
});

test("renderer automatically retries the same episode on another line when enabled", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    "autoFallbackLine",
    "播放失败自动换线路",
    'setSetting("autoFallbackLine"',
    'getSetting("autoFallbackLine", true)',
    "playbackAllowsLineFallback",
    "resolveFallbackPlaybackLine",
    "attemptedFlags",
    "正在自动尝试",
  ]) assert.ok(source.includes(marker), `missing automatic line fallback marker: ${marker}`);
  assert.ok(source.indexOf("if (playbackNeedsPanLogin") < source.indexOf("const fallback = autoFallbackLine.value"));
  assert.ok(source.includes("await play(fallback.line.flag, fallback.episode, startPosition, [...attemptedFlags, flag], attemptedSiteKeys)"));
});
