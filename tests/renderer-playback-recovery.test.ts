import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const playerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
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
  const [app, player] = await Promise.all([readFile(appPath, "utf8"), readFile(playerPath, "utf8")]);
  for (const marker of [
    "autoNextEpisode",
    "handleEmbeddedEnded",
    "handleCompatibilityPlayerState",
    "onPlayerState",
    "本集播放完成，正在自动播放",
    'setSetting("autoNextEpisode"',
    'getSetting("autoNextEpisode", true)',
  ]) assert.ok(app.includes(marker), `missing auto-next marker: ${marker}`);
  assert.ok(player.includes('ended: [progress: PlaybackSnapshot]'));
  assert.ok(player.includes('emit("ended", progress)'));
  assert.ok(app.includes('@ended="handleEmbeddedEnded"'));
});

test("external player fallback is isolated behind playback IPC and only shown after internal failure", async () => {
  const [app, preload, ipc] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(ipcPath, "utf8"),
  ]);
  for (const marker of ["externalPlayerPreference", "默认外部播放器", "IINA", "VLC", "系统播放器", "externalFallbackSessionId", "openExternalPlayback"]) {
    assert.ok(app.includes(marker), `missing external fallback marker: ${marker}`);
  }
  assert.ok(preload.includes("PLAYBACK_EXTERNAL"));
  assert.ok(preload.includes("openExternalPlayback"));
  assert.ok(ipc.includes('PLAYBACK_EXTERNAL: "playback:external"'));
  assert.ok(ipc.includes("playback.openExternal(sessionId, preference)"));
});
