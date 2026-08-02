import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const playerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const policyPath = new URL("../src/desktop/renderer/player/playback-error-policy.ts", import.meta.url);
const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);

test("embedded player uses a configurable delayed compatibility fallback", async () => {
  const [player, policy, app] = await Promise.all([
    readFile(playerPath, "utf8"),
    readFile(policyPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.ok(player.includes("scheduleAutomaticFallback"));
  assert.ok(player.includes("shouldScheduleCompatibilityFallback"));
  assert.ok(player.includes('emit("fallback", snapshot())'));
  assert.ok(player.includes("短暂等待后将自动切换"));
  assert.ok(player.includes("已关闭自动切换"));
  assert.ok(player.includes("立即切换高兼容播放器"));
  assert.ok(player.includes("queueKeyboardSeek"), "rapid keyboard seeks must be coalesced in the standard player");
  assert.ok(player.includes("onSeeking"), "mouse timeline seeks must preserve playback state");
  assert.ok(player.includes("requestSameLineReprepare()"), "a stuck post-seek media pipeline must recover at the requested position");
  assert.ok(policy.includes("AUTOMATIC_COMPATIBILITY_FALLBACK_DELAY_MS = 4_000"));
  assert.ok(app.includes("compatibilityFallbackMode"));
  assert.ok(app.includes("播放失败兼容策略"));
  assert.ok(app.includes("标准播放模式无法正常加载，已切换到高兼容播放模式"));
  assert.doesNotMatch(app, /该播放源已记录为异常，后续搜索和推荐将自动隐藏/);
});
