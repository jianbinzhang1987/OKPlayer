<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import DanmakuOverlay from "./DanmakuOverlay.vue";
import { loadHlsConstructor, supportsNativeHls, type HlsInstance } from "../player/hls-engine.ts";
import {
  AUTOMATIC_COMPATIBILITY_FALLBACK_DELAY_MS,
  shouldScheduleCompatibilityFallback,
  type CompatibilityFallbackMode,
} from "../player/playback-error-policy.ts";
import type { EmbeddedPlaybackSession, PlaybackProgress, PlayerEpisode } from "../player/player-types.ts";
import {
  DEFAULT_DANMAKU_SETTINGS,
  DEFAULT_SUBTITLE_SETTINGS,
  normalizeSubtitleSettings,
  type DanmakuPresentationSettings,
  type SubtitlePresentationSettings,
} from "../player/presentation-settings.ts";

const STARTUP_TIMEOUT_MS = 10_000;

const props = withDefaults(defineProps<{
  session: EmbeddedPlaybackSession;
  defaultSpeed?: number;
  compatibilityFallbackMode?: CompatibilityFallbackMode;
  episodes?: PlayerEpisode[];
  currentEpisodeUrl?: string;
  hasPrevious?: boolean;
  hasNext?: boolean;
  danmakuSettings?: DanmakuPresentationSettings;
  subtitleSettings?: SubtitlePresentationSettings;
}>(), {
  defaultSpeed: 1,
  compatibilityFallbackMode: "automatic",
  episodes: () => [],
  currentEpisodeUrl: "",
  hasPrevious: false,
  hasNext: false,
  danmakuSettings: () => ({ ...DEFAULT_DANMAKU_SETTINGS }),
  subtitleSettings: () => ({ ...DEFAULT_SUBTITLE_SETTINGS }),
});

type PlaybackSnapshot = PlaybackProgress;

const emit = defineEmits<{
  close: [progress: PlaybackSnapshot];
  fallback: [progress: PlaybackSnapshot];
  reprepare: [progress: PlaybackSnapshot];
  progress: [progress: PlaybackSnapshot];
  previous: [progress: PlaybackSnapshot];
  next: [progress: PlaybackSnapshot];
  ended: [progress: PlaybackSnapshot];
  selectEpisode: [payload: { episodeUrl: string; progress: PlaybackSnapshot }];
}>();

const root = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const subtitleTrack = ref<HTMLTrackElement>();
const status = ref<"loading" | "playing" | "paused" | "buffering" | "ended" | "error">("loading");
const errorMessage = ref("");
const speed = ref(props.defaultSpeed ?? 1);
const currentTime = ref(0);
const duration = ref(0);
const playbackEngine = ref<"native" | "hls.js">("native");
const danmakuEnabled = ref(true);
const episodeDrawerOpen = ref(false);
const controlsVisible = ref(true);
let controlsTimer: ReturnType<typeof setTimeout> | undefined;
let lastSavedAt = 0;
let disposed = false;
let restoredPosition = false;
let loadGeneration = 0;
let hls: HlsInstance | undefined;
let networkRecoveries = 0;
let mediaRecoveries = 0;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackTriggered = false;
let reprepareRequested = false;
let networkErrorRetried = false;
let startupWatchdog: ReturnType<typeof setTimeout> | undefined;
let startupWatchdogExtensions = 0;
let subtitleCueOrigins = new WeakMap<TextTrackCue, { start: number; end: number }>();

const resolvedSubtitleSettings = computed(() => normalizeSubtitleSettings(props.subtitleSettings));

const engineLabel = computed(() => props.session.format === "hls" && playbackEngine.value === "hls.js"
  ? "HLS · MSE"
  : props.session.format.toUpperCase());
const subtitleCssVariables = computed(() => ({
  "--subtitle-font-scale": String(resolvedSubtitleSettings.value.fontScale),
  "--subtitle-background-opacity": String(resolvedSubtitleSettings.value.backgroundOpacity),
}));

const statusText = computed(() => {
  if (status.value === "loading") return playbackEngine.value === "hls.js" ? "正在初始化 HLS 播放引擎…" : "正在加载媒体…";
  if (status.value === "buffering") return "正在缓冲…";
  if (status.value === "paused") return "已暂停";
  if (status.value === "ended") return "播放完成";
  return "";
});

function clearControlsTimer() {
  if (controlsTimer) clearTimeout(controlsTimer);
  controlsTimer = undefined;
}

function scheduleControlsHide() {
  clearControlsTimer();
  if (status.value !== "playing" || episodeDrawerOpen.value || errorMessage.value) return;
  controlsTimer = setTimeout(() => {
    controlsVisible.value = false;
  }, 3_000);
}

function showControls() {
  controlsVisible.value = true;
  scheduleControlsHide();
}

function toggleEpisodeDrawer() {
  episodeDrawerOpen.value = !episodeDrawerOpen.value;
  controlsVisible.value = true;
  if (episodeDrawerOpen.value) clearControlsTimer();
  else scheduleControlsHide();
}

function snapshot() {
  const position = Number.isFinite(video.value?.currentTime) ? Math.max(0, video.value?.currentTime ?? 0) : 0;
  const total = Number.isFinite(video.value?.duration) ? Math.max(0, video.value?.duration ?? 0) : 0;
  return {
    position,
    duration: total,
    completed: total > 0 && (position / total >= 0.95 || total - position <= 90),
  };
}

function disposeHls() {
  hls?.destroy();
  hls = undefined;
  networkRecoveries = 0;
  mediaRecoveries = 0;
}
function clearFallbackTimer() {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = undefined;
}

function clearStartupWatchdog() {
  if (startupWatchdog) clearTimeout(startupWatchdog);
  startupWatchdog = undefined;
}

function armStartupWatchdog() {
  clearStartupWatchdog();
  startupWatchdog = setTimeout(() => {
    startupWatchdog = undefined;
    if (disposed || status.value !== "loading" || fallbackTriggered) return;
    const element = video.value;
    // If the element is genuinely receiving data (buffered ranges exist) it
    // is a slow-but-healthy start (e.g. a high-bitrate MP4 through the local
    // gateway), not a container Chromium cannot parse. Extend the wait a
    // couple of times before falling back, so a slow start never triggers a
    // full re-fetch. A container Chromium cannot parse never fills buffered
    // ranges, so it still falls through to the mpv kernel here.
    const hasBufferedData = element ? element.buffered.length > 0 : false;
    if (hasBufferedData && startupWatchdogExtensions < 2) {
      startupWatchdogExtensions += 1;
      armStartupWatchdog();
      return;
    }
    // The media request can hang without ever raising a media error event.
    //  - A container Chromium cannot parse (netdisk 原画 links are often
    //    Matroska): re-fetching the link cannot help — switch to the native
    //    mpv kernel on the SAME session.
    //  - A stale short-lived signed link: re-fetching helps (handled by the
    //    explicit network-error handler).
    // The mpv side has its own watchdog, so if mpv also fails the playback
    // falls through to line switching as usual.
    fallbackTriggered = true;
    emit("fallback", snapshot());
  }, STARTUP_TIMEOUT_MS);
}

function scheduleAutomaticFallback() {
  if (!shouldScheduleCompatibilityFallback({
    mode: props.compatibilityFallbackMode,
    fallbackTriggered,
    disposed,
  })) return;
  clearFallbackTimer();
  fallbackTimer = setTimeout(() => {
    fallbackTimer = undefined;
    if (disposed || status.value !== "error" || fallbackTriggered) return;
    fallbackTriggered = true;
    emit("fallback", snapshot());
  }, AUTOMATIC_COMPATIBILITY_FALLBACK_DELAY_MS);
}

function showPlaybackError(message: string) {
  status.value = "error";
  errorMessage.value = message;
  controlsVisible.value = true;
  clearControlsTimer();
  scheduleAutomaticFallback();
}

/**
 * Network-level media failures (link expired, CDN rejected the request) are
 * recovered by re-fetching a fresh link for the SAME line instead of falling
 * back to the mpv kernel or switching lines. Only one reprepare is requested
 * per session to avoid ping-ponging between stale links.
 */
function requestSameLineReprepare() {
  if (reprepareRequested || disposed) return;
  clearFallbackTimer();
  reprepareRequested = true;
  emit("reprepare", snapshot());
}

function showNetworkError(message: string) {
  if (networkErrorRetried) {
    requestSameLineReprepare();
    return;
  }
  networkErrorRetried = true;
  status.value = "error";
  errorMessage.value = message;
  controlsVisible.value = true;
  clearControlsTimer();
  // One in-session retry first; the same source URL may be transiently
  // unreachable. If it fails again, the reprepare path takes over.
  setTimeout(() => {
    if (disposed || status.value !== "error" || reprepareRequested) return;
    void loadMedia();
  }, 900);
}

async function tryAutoPlay(element: HTMLVideoElement) {
  try {
    await element.play();
  } catch (error) {
    if (element.error) return;
    status.value = "paused";
    errorMessage.value = error instanceof Error ? error.message : "需要点击播放按钮开始播放";
  }
}

async function loadWithHlsJs(element: HTMLVideoElement, generation: number) {
  playbackEngine.value = "hls.js";
  if (typeof MediaSource === "undefined") {
    showPlaybackError("当前系统不支持内置 HLS 播放，可使用高兼容播放器继续播放。");
    return;
  }

  try {
    const Hls = await loadHlsConstructor();
    if (disposed || generation !== loadGeneration) return;
    if (!Hls.isSupported()) {
      showPlaybackError("当前内置播放器不支持该 HLS 内容，可使用高兼容播放器继续播放。");
      return;
    }

    const instance = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      maxBufferLength: 45,
    });
    hls = instance;
    instance.on(Hls.Events.MEDIA_ATTACHED, () => instance.loadSource(props.session.playbackUrl));
    instance.on(Hls.Events.MANIFEST_PARSED, () => void tryAutoPlay(element));
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || disposed || generation !== loadGeneration) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
        networkRecoveries += 1;
        instance.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
        mediaRecoveries += 1;
        instance.recoverMediaError();
        return;
      }
      instance.destroy();
      if (hls === instance) hls = undefined;
      // Network failures are usually a stale signed link (netdisk original
      // quality), so re-fetch the link instead of switching engines. Media
      // failures are a codec/container incompatibility — fall back to mpv.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        showNetworkError(`HLS 分片请求失败${data.details ? `：${data.details}` : ""}，正在尝试重新获取播放地址。`);
      } else {
        showPlaybackError(`HLS 内置播放失败${data.details ? `：${data.details}` : ""}，可使用高兼容播放器继续播放。`);
      }
    });
    instance.attachMedia(element);
  } catch (error) {
    if (disposed || generation !== loadGeneration) return;
    showPlaybackError(`HLS 播放引擎加载失败：${error instanceof Error ? error.message : String(error)}。可使用高兼容播放器继续播放。`);
  }
}

async function loadMedia() {
  await nextTick();
  const element = video.value;
  if (!element || disposed) return;
  const generation = ++loadGeneration;
  clearFallbackTimer();
  clearStartupWatchdog();
  fallbackTriggered = false;
  errorMessage.value = "";
  status.value = "loading";
  controlsVisible.value = true;
  episodeDrawerOpen.value = false;
  clearControlsTimer();
  playbackEngine.value = "native";
  disposeHls();
  element.pause();
  element.removeAttribute("src");
  element.load();
  restoredPosition = false;
  subtitleCueOrigins = new WeakMap<TextTrackCue, { start: number; end: number }>();
  currentTime.value = Math.max(0, props.session.startPosition ?? 0);
  element.playbackRate = speed.value;

  const isHls = props.session.format.toLowerCase() === "hls";
  if (isHls && !supportsNativeHls(element)) {
    await loadWithHlsJs(element, generation);
    return;
  }

  element.src = props.session.playbackUrl;
  element.load();
  armStartupWatchdog();
  await tryAutoPlay(element);
}

function applySubtitlePreferences() {
  const element = video.value;
  const track = element?.textTracks?.[0];
  if (!track) return;
  track.mode = "showing";
  const delay = resolvedSubtitleSettings.value.delaySeconds;
  for (const cue of Array.from(track.cues ?? [])) {
    const original = subtitleCueOrigins.get(cue) ?? { start: cue.startTime, end: cue.endTime };
    subtitleCueOrigins.set(cue, original);
    cue.startTime = Math.max(0, original.start + delay);
    cue.endTime = Math.max(cue.startTime + 0.1, original.end + delay);
  }
}

function onLoadedMetadata() {
  const element = video.value;
  if (!element) return;
  applySubtitlePreferences();
  duration.value = Number.isFinite(element.duration) ? element.duration : 0;
  element.playbackRate = speed.value;
  const startPosition = Math.max(0, props.session.startPosition ?? 0);
  if (!restoredPosition && startPosition > 0 && (!duration.value || startPosition < duration.value - 5)) {
    element.currentTime = startPosition;
    currentTime.value = startPosition;
    restoredPosition = true;
  }
}

function onTimeUpdate() {
  const element = video.value;
  if (!element) return;
  currentTime.value = Number.isFinite(element.currentTime) ? element.currentTime : 0;
  duration.value = Number.isFinite(element.duration) ? element.duration : duration.value;
  if (Date.now() - lastSavedAt >= 15_000) {
    lastSavedAt = Date.now();
    emit("progress", snapshot());
  }
}

function onPlaying() {
  clearStartupWatchdog();
  clearFallbackTimer();
  fallbackTriggered = false;
  status.value = "playing";
  errorMessage.value = "";
  scheduleControlsHide();
}

function onPaused() {
  status.value = "paused";
  controlsVisible.value = true;
  clearControlsTimer();
  emit("progress", snapshot());
}

function onEnded() {
  status.value = "ended";
  controlsVisible.value = true;
  clearControlsTimer();
  const progress = snapshot();
  emit("progress", progress);
  emit("ended", progress);
}

function previousEpisode() {
  if (props.hasPrevious) emit("previous", snapshot());
}

function nextEpisode() {
  if (props.hasNext) emit("next", snapshot());
}

function selectEpisode(episodeUrl: string) {
  if (!episodeUrl || episodeUrl === props.currentEpisodeUrl) return;
  episodeDrawerOpen.value = false;
  emit("selectEpisode", { episodeUrl, progress: snapshot() });
}

function onPlaybackError() {
  if (playbackEngine.value === "hls.js" && hls) return;
  const code = video.value?.error?.code;
  if (code === 2) {
    // MEDIA_ERR_NETWORK: the signed link likely expired between resolution
    // and the first media request — re-fetch a fresh link for the same line.
    showNetworkError("媒体网络请求失败，正在尝试重新获取播放地址。");
    return;
  }
  showPlaybackError(`媒体加载失败${code ? `（错误代码 ${code}）` : ""}，可使用高兼容播放器继续播放。`);
}

function changeSpeed() {
  if (video.value) video.value.playbackRate = speed.value;
}

function retry() {
  clearFallbackTimer();
  fallbackTriggered = false;
  void loadMedia();
}

function closePlayer() {
  emit("close", snapshot());
}

function useFallback() {
  if (fallbackTriggered) return;
  clearFallbackTimer();
  fallbackTriggered = true;
  emit("fallback", snapshot());
}

async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await root.value?.requestFullscreen();
}

function handleKeydown(event: KeyboardEvent) {
  const element = video.value;
  if (!element) return;
  showControls();
  if (event.key === "Escape" && episodeDrawerOpen.value) {
    event.preventDefault();
    episodeDrawerOpen.value = false;
    scheduleControlsHide();
    return;
  }
  if (event.key === "Escape" && !document.fullscreenElement) {
    event.preventDefault();
    closePlayer();
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    if (element.paused) void element.play();
    else element.pause();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    element.currentTime = Math.max(0, element.currentTime - 10);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    element.currentTime = Math.min(Number.isFinite(element.duration) ? element.duration : Infinity, element.currentTime + 10);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    element.volume = Math.min(1, element.volume + 0.05);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    element.volume = Math.max(0, element.volume - 0.05);
  } else if (event.key === "PageUp") {
    event.preventDefault();
    previousEpisode();
  } else if (event.key === "PageDown") {
    event.preventDefault();
    nextEpisode();
  }
}

watch(() => [props.session.playbackUrl, props.session.format], () => void loadMedia());
watch(() => props.session.danmakuUrl, () => { danmakuEnabled.value = true; });
watch(() => props.subtitleSettings, () => applySubtitlePreferences(), { deep: true });

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  void loadMedia();
});

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration += 1;
  clearControlsTimer();
  clearFallbackTimer();
  clearStartupWatchdog();
  disposeHls();
  window.removeEventListener("keydown", handleKeydown);
  const element = video.value;
  if (element) {
    element.pause();
    element.removeAttribute("src");
    element.load();
  }
});
</script>

<template>
  <section
    ref="root"
    class="embedded-player"
    :class="{ 'controls-hidden': !controlsVisible && !episodeDrawerOpen }"
    :style="subtitleCssVariables"
    aria-label="内置播放器"
    @mousemove="showControls"
    @mouseleave="scheduleControlsHide"
  >
    <header class="embedded-player-header">
      <div class="mac-window-controls-safe-area" aria-hidden="true"></div>
      <button class="player-header-button player-back-button" title="返回详情" @click="closePlayer">
        <AppIcon name="back" :size="21" />
      </button>
      <div class="player-title">
        <strong>{{ session.title }}</strong>
        <span>{{ session.episode }}</span>
      </div>
      <div class="player-header-actions">
        <span class="format-chip">{{ engineLabel }}</span>
        <button class="player-header-button" title="上一集（Page Up）" :disabled="!hasPrevious" @click="previousEpisode">
          <AppIcon name="rewind" :size="18" />
        </button>
        <button class="player-header-button" title="下一集（Page Down）" :disabled="!hasNext" @click="nextEpisode">
          <AppIcon name="forward" :size="18" />
        </button>
        <button class="player-header-button text-action" :class="{ active: episodeDrawerOpen }" @click="toggleEpisodeDrawer">
          <AppIcon name="film" :size="17" />选集
        </button>
        <button v-if="session.danmakuUrl" class="player-header-button text-action" :class="{ active: danmakuEnabled }" @click="danmakuEnabled = !danmakuEnabled">弹幕</button>
        <label class="speed-control">
          <span>倍速</span>
          <select v-model.number="speed" @change="changeSpeed">
            <option :value="0.75">0.75×</option>
            <option :value="1">1.0×</option>
            <option :value="1.25">1.25×</option>
            <option :value="1.5">1.5×</option>
            <option :value="2">2.0×</option>
          </select>
        </label>
        <button class="player-header-button text-action" @click="useFallback">高兼容播放</button>
        <button class="player-header-button" title="全屏" @click="toggleFullscreen">
          <AppIcon name="grid" :size="19" />
        </button>
        <button class="player-header-button" title="关闭播放器" @click="closePlayer">
          <AppIcon name="close" :size="20" />
        </button>
      </div>
    </header>

    <div class="video-stage">
      <video
        ref="video"
        controls
        autoplay
        playsinline
        crossorigin="anonymous"
        @dblclick.prevent="toggleFullscreen"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @loadstart="status = 'loading'"
        @waiting="status = 'buffering'; showControls()"
        @playing="onPlaying"
        @pause="onPaused"
        @ended="onEnded"
        @error="onPlaybackError"
      >
        <track
          v-if="session.subtitleUrl"
          ref="subtitleTrack"
          :key="session.subtitleUrl"
          kind="subtitles"
          srclang="zh"
          label="CatVod 字幕"
          :src="session.subtitleUrl"
          default
          @load="applySubtitlePreferences"
        />
      </video>

      <DanmakuOverlay :danmaku-url="session.danmakuUrl" :current-time="currentTime" :enabled="danmakuEnabled" :visible="status !== 'error'" :settings="danmakuSettings" />

      <div v-if="statusText && status !== 'error'" class="player-status">
        <div v-if="status === 'loading' || status === 'buffering'" class="player-spinner"></div>
        <span>{{ statusText }}</span>
      </div>

      <div v-if="status === 'error'" class="player-error-card">
        <div class="player-error-icon"><AppIcon name="info" :size="26" /></div>
        <h2>内置播放失败</h2>
        <p>{{ errorMessage }}</p>
        <small v-if="compatibilityFallbackMode === 'automatic'" class="fallback-countdown-note">短暂等待后将自动切换；重新加载或手动切换均可取消等待。</small>
        <small v-else class="fallback-countdown-note">已关闭自动切换，可重新加载或手动使用高兼容播放器。</small>
        <div>
          <button class="retry-button" @click="retry"><AppIcon name="refresh" :size="16" />重新加载</button>
          <button class="fallback-button" @click="useFallback"><AppIcon name="play" :size="16" />立即切换高兼容播放器</button>
        </div>
      </div>

      <button v-if="episodeDrawerOpen" class="episode-drawer-backdrop" aria-label="关闭选集" @click="toggleEpisodeDrawer"></button>
      <aside v-if="episodeDrawerOpen" class="episode-drawer" aria-label="选集列表">
        <div class="episode-drawer-heading">
          <div><small>EPISODES</small><strong>选择剧集</strong></div>
          <button class="player-header-button" title="关闭选集" @click="toggleEpisodeDrawer"><AppIcon name="close" :size="18" /></button>
        </div>
        <div class="episode-drawer-list">
          <button
            v-for="(episode, index) in episodes ?? []"
            :key="episode.url"
            :class="{ active: episode.url === currentEpisodeUrl }"
            @click="selectEpisode(episode.url)"
          >
            <span>{{ String(index + 1).padStart(2, '0') }}</span>
            <strong>{{ episode.name }}</strong>
            <em v-if="episode.url === currentEpisodeUrl">正在播放</em>
          </button>
        </div>
      </aside>
    </div>

    <footer class="player-hint">
      <span>空格暂停/继续</span>
      <span>← → 快退/快进 10 秒</span>
      <span>↑ ↓ 调整音量</span>
      <span>Page Up / Down 切集</span>
      <span>Esc 返回</span>
      <span class="time-indicator">{{ Math.floor(currentTime) }}s / {{ Math.floor(duration) }}s</span>
    </footer>
  </section>
</template>

<style scoped>
.embedded-player {
  --native-controls-safe-height: 74px;
  --player-hint-gap: 14px;
  position: fixed;
  inset: 0;
  z-index: 200;
  overflow: hidden;
  color: #f5f5f7;
  background: #050608;
}

.embedded-player-header {
  --mac-window-controls-safe-width: 96px;
  position: absolute;
  inset: 0 0 auto;
  z-index: 6;
  display: flex;
  height: 64px;
  align-items: center;
  gap: 14px;
  padding: 0 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
  background: linear-gradient(180deg, rgba(8, 10, 14, 0.96), rgba(8, 10, 14, 0.72));
  box-shadow: 0 16px 30px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(18px);
  transition: opacity 180ms ease, transform 180ms ease;
  -webkit-app-region: drag;
}

.mac-window-controls-safe-area {
  display: none;
  width: 0;
  height: 100%;
  flex: 0 0 0;
  pointer-events: none;
}

:global(html[data-platform="darwin"]) .mac-window-controls-safe-area {
  display: block;
  width: var(--mac-window-controls-safe-width);
  flex-basis: var(--mac-window-controls-safe-width);
}

.player-header-button,
.speed-control,
.speed-control select {
  -webkit-app-region: no-drag;
}

.player-back-button {
  flex: 0 0 auto;
}

.player-header-button {
  display: grid;
  min-width: 38px;
  height: 38px;
  padding: 0 10px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  color: rgba(245, 245, 247, 0.78);
  background: rgba(255, 255, 255, 0.055);
}

.player-header-button:hover {
  color: white;
  background: rgba(255, 255, 255, 0.11);
}

.player-header-button:disabled {
  cursor: default;
  opacity: 0.32;
  background: rgba(255, 255, 255, 0.035);
}

.player-header-button.active {
  border-color: rgba(10, 132, 255, 0.42);
  color: #82bdff;
  background: rgba(10, 132, 255, 0.16);
}

.text-action {
  width: auto;
  font-size: var(--font-small, 12px);
  white-space: nowrap;
}

.player-title {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: 2px;
}

.player-title strong,
.player-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-title strong {
  font-size: var(--font-body, 14px);
  font-weight: 650;
}

.player-title span {
  color: rgba(245, 245, 247, 0.62);
  font-size: var(--font-caption, 11px);
}

.player-header-actions {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.embedded-player:fullscreen .mac-window-controls-safe-area {
  display: none;
}

.format-chip {
  padding: 5px 8px;
  border: 1px solid rgba(10, 132, 255, 0.25);
  border-radius: 7px;
  color: #72b5ff;
  font-size: var(--font-caption, 11px);
  font-weight: 700;
  background: rgba(10, 132, 255, 0.1);
}

.speed-control {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 9px 0 11px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  color: rgba(245, 245, 247, 0.65);
  font-size: var(--font-caption, 11px);
  background: rgba(255, 255, 255, 0.055);
}

.speed-control select {
  border: 0;
  color: white;
  background: transparent;
}

.video-stage {
  position: absolute;
  inset: 0;
  display: grid;
  min-height: 0;
  place-items: center;
  overflow: hidden;
  background: #000;
}

.video-stage video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.video-stage video::cue {
  font-size: calc(1em * var(--subtitle-font-scale, 1));
  color: #fff;
  background-color: rgba(0, 0, 0, var(--subtitle-background-opacity, .45));
  text-shadow: 0 2px 5px rgba(0, 0, 0, .9);
}

.player-status {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 15px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  color: rgba(245, 245, 247, 0.84);
  font-size: var(--font-small, 12px);
  background: rgba(17, 19, 24, 0.82);
  backdrop-filter: blur(18px);
}

.player-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.22);
  border-top-color: white;
  border-radius: 50%;
  animation: player-spin 0.8s linear infinite;
}

.player-error-card {
  position: absolute;
  display: grid;
  width: min(440px, calc(100% - 40px));
  justify-items: center;
  padding: 30px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  text-align: center;
  background: rgba(21, 23, 29, 0.94);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(24px);
}

.player-error-icon {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  border-radius: 14px;
  color: #ffb340;
  background: rgba(255, 159, 10, 0.12);
}

.player-error-card h2 {
  margin: 16px 0 7px;
  font-size: var(--font-section-title, 20px);
}

.player-error-card p {
  margin: 0;
  color: rgba(245, 245, 247, 0.7);
  font-size: var(--font-body, 14px);
  line-height: 1.7;
}

.fallback-countdown-note {
  margin-top: 10px;
  color: rgba(245, 245, 247, 0.48);
  font-size: var(--font-caption, 11px);
  line-height: 1.6;
}

.player-error-card > div:last-child {
  display: flex;
  gap: 10px;
  margin-top: 22px;
}

.retry-button,
.fallback-button {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 15px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  color: white;
}

.retry-button {
  background: rgba(255, 255, 255, 0.08);
}

.fallback-button {
  border-color: rgba(10, 132, 255, 0.42);
  background: #087be8;
}

.player-hint {
  position: absolute;
  right: 0;
  bottom: calc(var(--native-controls-safe-height) + var(--player-hint-gap));
  left: 0;
  z-index: 6;
  display: flex;
  height: 38px;
  align-items: center;
  gap: 18px;
  padding: 0 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(245, 245, 247, 0.5);
  font-size: var(--font-caption, 11px);
  background: linear-gradient(0deg, rgba(8, 10, 14, 0.94), rgba(8, 10, 14, 0.7));
  backdrop-filter: blur(16px);
  pointer-events: none;
  transition: opacity 180ms ease, transform 180ms ease;
}

.embedded-player.controls-hidden {
  cursor: none;
}

.controls-hidden .embedded-player-header {
  pointer-events: none;
  opacity: 0;
  transform: translateY(-12px);
}

.controls-hidden .player-hint {
  pointer-events: none;
  opacity: 0;
  transform: translateY(10px);
}

.episode-drawer-backdrop {
  position: absolute;
  inset: 0;
  z-index: 7;
  border: 0;
  background: rgba(0, 0, 0, 0.34);
  backdrop-filter: blur(2px);
}

.episode-drawer {
  position: absolute;
  inset: 0 0 0 auto;
  z-index: 8;
  display: grid;
  width: min(380px, 38vw);
  grid-template-rows: auto minmax(0, 1fr);
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(15, 17, 22, 0.96);
  box-shadow: -24px 0 60px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(24px);
}

.episode-drawer-heading {
  display: flex;
  min-height: 72px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 18px 0 22px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.episode-drawer-heading > div {
  display: grid;
  gap: 3px;
}

.episode-drawer-heading small {
  color: rgba(245, 245, 247, 0.42);
  font-size: var(--font-caption, 11px);
  font-weight: 700;
  letter-spacing: 0.12em;
}

.episode-drawer-heading strong {
  font-size: var(--font-section-title, 20px);
}

.episode-drawer-list {
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 14px;
  overflow: auto;
}

.episode-drawer-list button {
  display: grid;
  min-height: 52px;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  color: rgba(245, 245, 247, 0.78);
  text-align: left;
  background: rgba(255, 255, 255, 0.045);
}

.episode-drawer-list button:hover {
  color: white;
  background: rgba(255, 255, 255, 0.085);
}

.episode-drawer-list button.active {
  border-color: rgba(10, 132, 255, 0.38);
  color: white;
  background: rgba(10, 132, 255, 0.16);
}

.episode-drawer-list button > span {
  color: rgba(245, 245, 247, 0.38);
  font-size: var(--font-caption, 11px);
  font-variant-numeric: tabular-nums;
}

.episode-drawer-list button strong {
  overflow: hidden;
  font-size: var(--font-body, 14px);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.episode-drawer-list button em {
  color: #82bdff;
  font-size: var(--font-caption, 11px);
  font-style: normal;
}

.time-indicator {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 900px) {
  .format-chip,
  .speed-control > span,
  .player-hint > span:not(.time-indicator) {
    display: none;
  }

  .episode-drawer {
    width: min(360px, 72vw);
  }
}

@keyframes player-spin {
  to { transform: rotate(360deg); }
}
</style>
