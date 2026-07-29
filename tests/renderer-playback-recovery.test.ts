import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const playerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const nativePlayerPath = new URL("../src/desktop/renderer/components/NativePlayerHost.vue", import.meta.url);
const preloadPath = new URL("../src/desktop/preload.ts", import.meta.url);
const ipcPath = new URL("../src/desktop/register-ipc.ts", import.meta.url);

test("renderer searches normalized alternative sources after line fallback is exhausted", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    "resolveAlternativeSourcePlayback",
    'searchDetailed(item.vodName, undefined, "all-configs", 1)',
    "rankAlternativeSourceCandidates",
    "resolvePlaybackEpisodeTarget",
    "autoFallbackSource",
    "线路均失败后自动换来源",
    'setSetting("autoFallbackSource"',
    'getSetting("autoFallbackSource", true)',
  ]) assert.ok(source.includes(marker), `missing cross-source recovery marker: ${marker}`);
});

test("embedded and compatibility playback both support automatic next episode", async () => {
  const [app, player, nativePlayer] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(playerPath, "utf8"),
    readFile(nativePlayerPath, "utf8"),
  ]);
  for (const marker of [
    "autoNextEpisode",
    "handleEmbeddedEnded",
    "本集播放完成，正在自动播放",
    'setSetting("autoNextEpisode"',
    'getSetting("autoNextEpisode", true)',
  ]) assert.ok(app.includes(marker), `missing auto-next marker: ${marker}`);
  assert.ok(player.includes('ended: [progress: PlaybackSnapshot]'));
  assert.ok(player.includes('emit("ended", progress)'));
  assert.ok(nativePlayer.includes("onPlayerState"));
  assert.ok(nativePlayer.includes('emit("ended", progress)'));
  assert.ok(app.includes('@ended="handleEmbeddedEnded"'));
});

test("external player fallback is disabled and playback stays inside the app", async () => {
  const [app, nativePlayer, preload, ipc] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(nativePlayerPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(ipcPath, "utf8"),
  ]);
  for (const marker of ["外部播放器", "已禁用", "仅应用内播放", "应用将只使用内置播放器"]) {
    assert.ok(app.includes(marker), `missing disabled external player marker: ${marker}`);
  }
  assert.ok(!app.includes("使用外部播放器进行最后尝试"));
  assert.ok(!nativePlayer.includes("使用外部播放器最后尝试"));
  assert.ok(preload.includes("PLAYBACK_EXTERNAL"));
  assert.ok(ipc.includes('PLAYBACK_EXTERNAL: "playback:external"'));
  assert.ok(ipc.includes("外部播放器已禁用"));
  assert.ok(!ipc.includes("playback.openExternal(sessionId, preference)"));
});
