import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const containerPath = new URL("../src/desktop/renderer/components/PlayerContainer.vue", import.meta.url);
const artPlayerPath = new URL("../src/desktop/renderer/components/ArtPlayerHost.vue", import.meta.url);
const nativePlayerPath = new URL("../src/desktop/renderer/components/NativePlayerHost.vue", import.meta.url);
const playerTypesPath = new URL("../src/desktop/renderer/player/player-types.ts", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

test("player container supports ArtPlayer and the stable legacy fallback", async () => {
  const [app, container, artPlayer, nativePlayer, types, packageText] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(containerPath, "utf8"),
    readFile(artPlayerPath, "utf8"),
    readFile(nativePlayerPath, "utf8"),
    readFile(playerTypesPath, "utf8"),
    readFile(packagePath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageText) as { dependencies?: Record<string, string> };

  assert.equal(packageJson.dependencies?.artplayer, "5.4.0");
  assert.ok(app.includes('import PlayerContainer from "./components/PlayerContainer.vue"'));
  assert.ok(app.includes("<PlayerContainer"));
  assert.ok(app.includes(':engine="webPlayerEngine"'));
  assert.doesNotMatch(app, /<EmbeddedPlayer/);

  assert.ok(container.includes("defineAsyncComponent"));
  assert.ok(container.includes('import("./ArtPlayerHost.vue")'));
  assert.ok(container.includes('import EmbeddedPlayer from "./EmbeddedPlayer.vue"'));
  assert.ok(container.includes("activeEngine"));
  assert.ok(container.includes("activeEngine === 'artplayer'"));
  assert.ok(container.includes("usesNativeEngine"));
  assert.ok(container.includes("NativePlayerHost"));
  assert.ok(container.includes("data-player-engine"));
  assert.ok(container.includes("handleArtPlayerFailure"));
  assert.ok(container.includes('activeEngine.value = "legacy"'));

  assert.ok(artPlayer.includes('import Artplayer from "artplayer"'));
  assert.ok(artPlayer.includes("customType"));
  assert.ok(artPlayer.includes("attachHls"));
  assert.doesNotMatch(artPlayer, /type:\s*isHls\s*\?\s*["']hls["']\s*:\s*undefined/);
  assert.ok(artPlayer.includes("session.subtitleUrl"));
  assert.ok(artPlayer.includes('emit("progress", snapshot())'));
  assert.ok(artPlayer.includes('emit("fallback", snapshot())'));
  assert.ok(artPlayer.includes('emit("engineFailure"'));
  assert.ok(nativePlayer.includes("高兼容播放模式"));
  assert.ok(nativePlayer.includes("fallbackPlayback"));
  assert.ok(nativePlayer.includes("onPlayerState"));
  assert.ok(nativePlayer.includes("setVolume"));
  assert.ok(nativePlayer.includes("setMuted"));
  assert.ok(nativePlayer.includes("handleKeydown"));
  assert.ok(nativePlayer.includes("retryNativePlayback"));
  assert.ok(nativePlayer.includes("friendlyPlaybackError"));
  assert.ok(types.includes('export type PlaybackMode = "auto" | "standard" | "compatibility"'));
  assert.ok(types.includes('export type WebPlayerEngine = "legacy" | "artplayer"'));
  assert.ok(types.includes("normalizeWebPlayerEngine"));
  assert.ok(types.includes("normalizePlaybackMode"));
});

test("web player and compatibility fallback preferences persist through ordinary settings", async () => {
  const app = await readFile(appPath, "utf8");
  for (const marker of [
    "compatibilityFallbackMode",
    'setSetting("compatibilityFallbackMode"',
    'getSetting("compatibilityFallbackMode", "automatic")',
    "normalizeCompatibilityFallbackMode",
    "播放失败兼容策略",
    'value="manual"',
    "playbackMode",
    'setSetting("playbackMode"',
    'getSetting("playbackMode", "auto")',
    "normalizePlaybackMode",
    "playbackEnginePreferences",
    'setSetting("playbackEnginePreferences"',
    'getSetting("playbackEnginePreferences", {})',
    "rememberCompatibilityPlayback",
    "effectivePlaybackMode",
    "clearPlaybackEnginePreferences",
    "高兼容播放记忆",
    "播放模式",
    "高兼容播放",
    "webPlayerEngine",
    'setSetting("webPlayerEngine"',
    'getSetting("webPlayerEngine", "legacy")',
    "normalizeWebPlayerEngine",
    "ArtPlayer 实验版",
    "稳定播放器",
    "handleWebPlayerEngineFallback",
  ]) assert.ok(app.includes(marker), `missing player upgrade setting marker: ${marker}`);
});
