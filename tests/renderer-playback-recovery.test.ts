import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const playerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const playerContainerPath = new URL("../src/desktop/renderer/components/PlayerContainer.vue", import.meta.url);
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

test("compatibility playback loads media before attaching the native surface and can fall back to a stable line", async () => {
  const [app, nativePlayer] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(nativePlayerPath, "utf8"),
  ]);
  const loadIndex = nativePlayer.indexOf("fallbackPlayback(props.session.sessionId)");
  const attachIndex = nativePlayer.indexOf("await attachNativeSurface()", loadIndex);
  assert.ok(loadIndex >= 0 && attachIndex > loadIndex, "native media must load before the surface is attached");
  for (const marker of [
    "STARTUP_TIMEOUT_MS",
    "reportCompatibilityFailure",
    'emit("failure", { progress: snapshot(), reason })',
  ]) assert.ok(nativePlayer.includes(marker), `missing compatibility failure marker: ${marker}`);
  assert.ok(app.includes("handleCompatibilityPlaybackFailure"));
  assert.ok(app.includes("const attemptedFlags = current.attemptedFlags ?? []"));
  assert.ok(app.includes('resolveFallbackPlaybackLine(item?.flags, current.flag, currentEpisode, attemptedFlags, "stable")'));
  assert.ok(app.includes("[...attemptedFlags, current.flag]"));
  assert.ok(app.includes('@compatibility-failure="handleCompatibilityPlaybackFailure"'));
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

test("netdisk playback re-fetches a fresh link for the same line after link expiry", async () => {
  const [app, player, container] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(playerPath, "utf8"),
    readFile(playerContainerPath, "utf8"),
  ]);
  // Same-line re-fetch after link-expiry or a transient resolve timeout,
  // before falling back to another line.
  assert.ok(app.includes('const failureCode = (e as RendererPlaybackFailure)?.code;'));
  assert.ok(app.includes('failureCode === "MEDIA_URL_EXPIRED" || failureCode === "SOURCE_RESOLVE_FAILED"'));
  assert.ok(app.includes("sameLineRetries === 0"));
  assert.ok(app.includes("attemptedSiteKeys, 1)"));
  assert.ok(app.includes("sameLineRetries = 0,"));
  assert.ok(app.includes("网盘播放地址已失效，正在重新获取后继续播放…"));
  assert.ok(app.includes("播放地址解析超时，正在重试当前线路…"));
  assert.ok(app.includes("handleWebPlayerReprepare"));
  assert.ok(app.includes("播放地址可能已过期，正在重新获取后继续播放…"));
  assert.ok(app.includes('@reprepare="handleWebPlayerReprepare"'));
  // Web engine emits a reprepare request for network-level media failures.
  assert.ok(player.includes("reprepare: [progress: PlaybackSnapshot]"));
  assert.ok(player.includes('emit("reprepare", snapshot())'));
  assert.ok(player.includes("requestSameLineReprepare"));
  assert.ok(player.includes("showNetworkError"));
  assert.ok(player.includes("MEDIA_ERR_NETWORK"));
  assert.ok(container.includes("reprepare: [progress: PlaybackProgress]"));
  assert.ok(container.includes("@reprepare=\"emit('reprepare', $event)\""));
  // A hanging media request without an error event switches to the native
  // mpv kernel (e.g. netdisk 原画 links that turn out to be Matroska) instead
  // of staying stuck on the loading screen.
  assert.ok(player.includes("STARTUP_TIMEOUT_MS"));
  assert.ok(player.includes("armStartupWatchdog"));
  assert.ok(player.includes('status.value !== "loading"'));
  assert.ok(player.includes('emit("fallback", snapshot())'));
});

test("netdisk credentials are pre-checked before playback and prompt login when expired", async () => {
  const app = await readFile(appPath, "utf8");
  assert.ok(app.includes("shouldPromptPanLoginBeforePlayback"));
  assert.ok(app.includes('status.accountState === "expired"'));
  assert.ok(app.includes('status.accountState === "not-configured"'));
  assert.ok(app.includes("precheckProvider"));
  assert.ok(app.includes("detectPanPlaybackProvider(item, flag, episode)"));
  assert.ok(app.includes("await startPanLogin(precheckProvider)"));
  // The 401/403 backstop during playback stays in place.
  assert.ok(app.includes("playbackNeedsPanLogin(e)"));
});
