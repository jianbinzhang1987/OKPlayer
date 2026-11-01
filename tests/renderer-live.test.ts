import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const livePagePath = new URL("../src/desktop/renderer/components/LivePage.vue", import.meta.url);
const preloadPath = new URL("../src/desktop/preload.ts", import.meta.url);
const nativePlayerPath = new URL("../src/desktop/renderer/components/NativePlayerHost.vue", import.meta.url);
const embeddedPlayerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const playerContainerPath = new URL("../src/desktop/renderer/components/PlayerContainer.vue", import.meta.url);

test("renderer exposes an independent IPTV page instead of routing live into the VOD library", async () => {
  const [app, livePage, preload] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(livePagePath, "utf8"),
    readFile(preloadPath, "utf8"),
  ]);

  assert.match(app, /page === 'live'/);
  assert.match(app, /<LivePage/);
  assert.match(app, /contentKind === "live"/);
  assert.match(app, /saveLiveRecent/);
  assert.match(app, /sourceManagementTab/);
  assert.match(app, /loadLiveConfig/);
  assert.match(app, /activeLiveConfig/);
  assert.match(app, /点播源与直播源独立管理/);
  assert.match(livePage, /全部频道/);
  assert.match(livePage, /收藏频道/);
  assert.match(livePage, /最近观看/);
  assert.match(livePage, /channel\.lines\.length > 1/);
  assert.match(livePage, /cloneLiveChannel/);
  assert.match(livePage, /headers: \{ \.\.\.line\.headers \}/);
  assert.match(livePage, /defaultLiveSourceId/);
  assert.match(preload, /listLiveSources/);
  assert.match(preload, /searchLiveChannels/);
  assert.match(preload, /loadLiveEpgGuide/);
  assert.match(preload, /saveLiveEpgMapping/);
  assert.match(preload, /resolveLiveCatchup/);
  assert.match(preload, /saveLiveCatchupHistory/);
  assert.match(preload, /saveLiveFavorite/);
  assert.match(preload, /inspectLiveChannel/);
  assert.match(preload, /recordLiveLineFeedback/);
  assert.match(preload, /CONFIG_LOAD_LIVE/);
  assert.match(livePage, /节目单已匹配/);
  assert.match(livePage, /channelEpg\(channel\)\?\.current/);
  assert.match(livePage, /live-epg-drawer/);
  assert.match(livePage, /saveEpgMapping/);
  assert.match(livePage, /人工修正频道映射/);
  assert.match(livePage, /playCatchup/);
  assert.match(livePage, /getLiveCatchupHistory/);
  assert.match(livePage, /startPosition: resumePosition/);
  assert.match(livePage, /realtimeChannel/);
  assert.match(livePage, /manualLineSelection: Boolean\(selectedLineByChannel\.value\[channel\.id\]\)/);
  assert.match(livePage, /'回看'/);
  assert.match(livePage, /bufferingCount/);
  assert.match(livePage, /failoverSuccessCount/);
  assert.match(livePage, /UDP/);
  assert.match(livePage, /RTSP/);
  assert.match(livePage, /epgDateOptions/);
  assert.match(livePage, /epgDrawerSchedule/);
  assert.match(livePage, /继续使用 .* 的缓存/);
  assert.match(livePage, /defineExpose\(\{ openProgrammeGuide \}\)/);
  assert.match(livePage, /channelCount: allChannels\.value\.length/);
});

test("live playback uses a direct protected session and does not write VOD history", async () => {
  const app = await readFile(appPath, "utf8");
  const start = app.indexOf("async function playLiveChannel");
  const end = app.indexOf("async function play(\n", start);
  assert.ok(start >= 0 && end > start);
  const livePlayback = app.slice(start, end);
  assert.match(livePlayback, /directMedia:/);
  assert.match(livePlayback, /contentKind: "live"/);
  assert.match(livePlayback, /playbackMode: "compatibility"/);
  assert.match(livePlayback, /inspectLiveChannel/);
  assert.match(livePlayback, /lineToProbe/);
  assert.match(livePlayback, /canStartLiveLineWithoutProbe/);
  assert.match(livePlayback, /!request\.manualLineSelection/);
  assert.match(livePlayback, /request\.manualLineSelection \|\| request\.forcePreferredLine/);
  assert.match(app, /if \(forcePreferred\)/);
  assert.match(livePlayback, /preflightMs/);
  assert.match(livePlayback, /prepareMs/);
  assert.match(livePlayback, /inspectLiveChannel\?\.\(request\.sourceId, request\.channel\.id, false, lineToProbe\)/);
  assert.match(livePlayback, /const isCatchup = request\.mode === "catchup"/);
  assert.match(livePlayback, /const isTimeshift = request\.mode === "timeshift"/);
  assert.match(livePlayback, /if \(!isReplay\)/);
  assert.match(livePlayback, /mode: isCatchup \? "catchup" : isTimeshift \? "timeshift" : "live"/);
  assert.match(livePlayback, /health\?\.state !== "unavailable"/);
  assert.match(livePlayback, /recordLiveLineFeedback/);
  assert.match(livePlayback, /stableFeedbackRecorded/);
  assert.match(livePlayback, /handleLiveBuffering/);
  assert.match(livePlayback, /bufferingWindowDurationMs/);
  assert.match(livePlayback, /durationMs >= 5_000/);
  assert.match(livePlayback, /forcePreferredLine: true/);
  assert.match(livePlayback, /当前直播线路持续卡顿，正在切换备用线路/);
  assert.match(livePlayback, /failover-success/);
  assert.match(livePlayback, /failover-failure/);
  assert.match(livePlayback, /isDisabledLiveProtocol/);
  assert.match(livePlayback, /headers: \{ \.\.\.line\.headers \}/);
  assert.match(livePlayback, /const previousSessionId = playing\.value\?\.sessionId/);
  assert.match(livePlayback, /previousSessionId !== prepared\.sessionId/);
  assert.match(livePlayback, /rememberLivePlaybackChannel/);
  assert.doesNotMatch(livePlayback, /previousSessionId[\s\S]{0,180}playing\.value = null/);
  assert.doesNotMatch(livePlayback, /saveHistory/);
});

test("native live playback returns immediately and hides VOD-only controls", async () => {
  const nativePlayer = await readFile(nativePlayerPath, "utf8");
  const closeStart = nativePlayer.indexOf("function closePlayer()");
  const closeEnd = nativePlayer.indexOf("async function retryNativePlayback", closeStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  const closeBlock = nativePlayer.slice(closeStart, closeEnd);
  assert.match(closeBlock, /emit\("close", progress\)/);
  assert.match(closeBlock, /Promise\.allSettled/);
  assert.doesNotMatch(closeBlock, /await detachNativeSurface/);
  assert.match(nativePlayer, /isLive \? '返回直播' : '返回详情'/);
  assert.match(nativePlayer, /requestTimeshift\(5 \* 60\)/);
  assert.match(nativePlayer, /回到直播/);
  assert.match(nativePlayer, /isRealtimeLive/);
  assert.match(nativePlayer, /v-if="!isLive && episodes\.length"/);
  assert.match(nativePlayer, /void closeEpisodeDrawer\(\)/);
  assert.match(nativePlayer, /emit\("ready"/);
  assert.match(nativePlayer, /paused-for-cache|buffering/);
  assert.match(nativePlayer, /emit\("buffering"/);
  assert.match(nativePlayer, /上个频道/);
  assert.match(nativePlayer, /下个频道/);
  assert.match(nativePlayer, /直播线路/);
  assert.match(nativePlayer, /直播频道/);
  assert.match(nativePlayer, /selectLiveChannel/);
  assert.match(nativePlayer, /LIVE_STARTUP_TIMEOUT_MS = 8_000/);
  assert.match(nativePlayer, /state\.videoReady === true/);
  assert.match(nativePlayer, /if \(nativeSurfaceAttached\.value\) await detachNativeSurface\(\)/);
  assert.match(nativePlayer, /刷新直播/);
  assert.match(nativePlayer, /v-if="isLive" class="native-control-button" title="打开当前频道节目单"/);
  assert.match(nativePlayer, /toggleFullscreen/);
  assert.match(nativePlayer, /fullscreenchange/);
  assert.match(nativePlayer, /event\.key\.toLowerCase\(\) === "f"/);
  assert.match(nativePlayer, /event\.key\.toLowerCase\(\) === "m"/);
  assert.match(nativePlayer, /flex-wrap: wrap/);
});

test("web live playback uses live-only controls and hides VOD-only actions", async () => {
  const [embeddedPlayer, playerContainer, app] = await Promise.all([
    readFile(embeddedPlayerPath, "utf8"),
    readFile(playerContainerPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.match(playerContainer, /props\.session\.contentKind === "live" \? "legacy"/);
  assert.match(playerContainer, /selectLiveLine/);
  assert.match(playerContainer, /selectLiveChannel/);
  assert.match(playerContainer, /liveChannels/);
  assert.match(playerContainer, /reconnectLive/);
  assert.match(playerContainer, /openLiveGuide/);
  assert.match(embeddedPlayer, /v-if="!isLive" class="player-header-button text-action"/);
  assert.match(embeddedPlayer, /v-if="!isLive && session\.danmakuUrl"/);
  assert.match(embeddedPlayer, /v-if="!isLive" class="speed-control"/);
  assert.match(embeddedPlayer, /web-live-controls/);
  assert.match(embeddedPlayer, /回看 5 分/);
  assert.match(embeddedPlayer, /v-if="isLive" @click="requestLiveGuide"/);
  assert.match(embeddedPlayer, /web-live-volume/);
  assert.match(embeddedPlayer, /toggleMute/);
  assert.match(embeddedPlayer, /event\.key\.toLowerCase\(\) === "f"/);
  assert.match(embeddedPlayer, /event\.key\.toLowerCase\(\) === "m"/);
  assert.match(embeddedPlayer, /回到直播/);
  assert.match(embeddedPlayer, /Page Up \/ Down \{\{ isLive \? '切换频道'/);
  assert.match(app, /selectLivePlaybackLine/);
  assert.match(app, /selectLivePlaybackChannel/);
  assert.match(app, /ensureLivePlaybackCatalog/);
  assert.match(app, /live-opening-layer/);
  assert.match(app, /reconnectLivePlayback/);
  assert.match(app, /switchLiveChannel/);
  assert.match(app, /openLiveProgrammeGuide/);
});
