<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import DanmakuOverlay from "./DanmakuOverlay.vue";
import type { CompatibilityFallbackMode } from "../player/playback-error-policy.ts";
import type {
  CompatibilityPlaybackFailure,
  EmbeddedPlaybackSession,
  PlaybackProgress,
  PlayerEpisode,
  PlayerLiveChannel,
  PlayerLiveLine,
} from "../player/player-types.ts";
import {
  DEFAULT_DANMAKU_SETTINGS,
  DEFAULT_SUBTITLE_SETTINGS,
  type DanmakuPresentationSettings,
  type SubtitlePresentationSettings,
} from "../player/presentation-settings.ts";

const props = withDefaults(defineProps<{
  session: EmbeddedPlaybackSession;
  defaultSpeed?: number;
  compatibilityFallbackMode?: CompatibilityFallbackMode;
  episodes?: PlayerEpisode[];
  currentEpisodeUrl?: string;
  hasPrevious?: boolean;
  hasNext?: boolean;
  liveLines?: PlayerLiveLine[];
  currentLiveLineId?: string;
  liveChannels?: PlayerLiveChannel[];
  currentLiveChannelId?: string;
  danmakuSettings?: DanmakuPresentationSettings;
  subtitleSettings?: SubtitlePresentationSettings;
}>(), {
  defaultSpeed: 1,
  compatibilityFallbackMode: "automatic",
  episodes: () => [],
  currentEpisodeUrl: "",
  hasPrevious: false,
  hasNext: false,
  liveLines: () => [],
  currentLiveLineId: "",
  liveChannels: () => [],
  currentLiveChannelId: "",
  danmakuSettings: () => ({ ...DEFAULT_DANMAKU_SETTINGS }),
  subtitleSettings: () => ({ ...DEFAULT_SUBTITLE_SETTINGS }),
});

const emit = defineEmits<{
  close: [progress: PlaybackProgress];
  progress: [progress: PlaybackProgress];
  previous: [progress: PlaybackProgress];
  next: [progress: PlaybackProgress];
  ended: [progress: PlaybackProgress];
  failure: [payload: CompatibilityPlaybackFailure];
  ready: [startupMs: number];
  buffering: [payload: { durationMs: number; cachePercent: number }];
  selectEpisode: [payload: { episodeUrl: string; progress: PlaybackProgress }];
  timeshift: [offsetSeconds: number];
  goLive: [];
  selectLiveLine: [lineId: string];
  selectLiveChannel: [channelId: string];
  reconnectLive: [];
  openLiveGuide: [progress: PlaybackProgress];
}>();

declare global {
  interface Window {
    tvApi: any;
  }
}

const status = ref<"loading" | "playing" | "paused" | "buffering" | "ended" | "error">("loading");
const errorMessage = ref("");
const position = ref(0);
const duration = ref(0);
const speed = ref(Number(props.defaultSpeed) || 1);
const volume = ref(100);
const muted = ref(false);
const episodeDrawerOpen = ref(false);
const root = ref<HTMLElement | null>(null);
const fullscreenActive = ref(false);
const nativeSurface = ref<HTMLElement | null>(null);
const nativeSurfaceAttached = ref(false);
const danmakuEnabled = ref(true);
const subtitleVisible = ref(true);
const controlsVisible = ref(true);
const aspectRatio = ref<"auto" | "16:9" | "4:3" | "stretch">("auto");
const subtitleDelay = ref(Number(props.subtitleSettings?.delaySeconds) || 0);
const alwaysOnTopActive = ref(false);
const miniModeActive = ref(false);
const playerToast = ref("");
let playerToastTimer: ReturnType<typeof setTimeout> | undefined;
let controlsTimer: ReturnType<typeof setTimeout> | undefined;

function showPlayerToast(message: string, durationMs = 2000) {
  playerToast.value = message;
  if (playerToastTimer) clearTimeout(playerToastTimer);
  playerToastTimer = setTimeout(() => {
    playerToast.value = "";
    playerToastTimer = undefined;
  }, durationMs);
}

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

async function toggleSubtitle() {
  subtitleVisible.value = !subtitleVisible.value;
  await window.tvApi.setSubtitleVisibility?.(subtitleVisible.value).catch(() => undefined);
}

async function changeAspectRatio(ratio?: "auto" | "16:9" | "4:3" | "stretch") {
  if (ratio) aspectRatio.value = ratio;
  await window.tvApi.setAspectRatio?.(aspectRatio.value).catch(() => undefined);
  const labels: Record<string, string> = {
    auto: "默认比例",
    "16:9": "16:9",
    "4:3": "4:3",
    stretch: "铺满拉伸",
  };
  showPlayerToast(`画面比例：${labels[aspectRatio.value] ?? aspectRatio.value}`);
}

async function cycleAudioTrack() {
  await window.tvApi.setAudioTrack?.("cycle").catch(() => undefined);
  showPlayerToast("已切换下一个音轨");
}

async function adjustSubtitleDelay(delta: number) {
  subtitleDelay.value = Math.round((subtitleDelay.value + delta) * 10) / 10;
  if (Object.is(subtitleDelay.value, -0)) subtitleDelay.value = 0;
  await window.tvApi.setSubtitleDelay?.(subtitleDelay.value).catch(() => undefined);
  const sign = subtitleDelay.value > 0 ? "+" : "";
  showPlayerToast(`字幕延迟：${sign}${subtitleDelay.value.toFixed(1)}s`);
}

async function toggleAlwaysOnTop() {
  const next = !alwaysOnTopActive.value;
  alwaysOnTopActive.value = Boolean(await window.tvApi.setWindowAlwaysOnTop?.(next).catch(() => false));
  showPlayerToast(alwaysOnTopActive.value ? "已开启窗口置顶" : "已取消窗口置顶");
}

async function toggleMiniMode() {
  const next = !miniModeActive.value;
  miniModeActive.value = Boolean(await window.tvApi.setWindowMiniMode?.(next).catch(() => false));
  alwaysOnTopActive.value = miniModeActive.value;
  showPlayerToast(miniModeActive.value ? "已进入小窗模式" : "已退出小窗模式");
  await nextTick();
  await resizeNativeSurface();
  setTimeout(() => void resizeNativeSurface(), 260);
}

const currentLiveClock = ref("");
let liveClockTimer: ReturnType<typeof setInterval> | undefined;

function updateLiveClock() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  currentLiveClock.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let removePlayerState: (() => void) | undefined;
let nativeSurfaceObserver: ResizeObserver | undefined;
let started = false;
let disposed = false;
let lastProgressAt = 0;
let stopRequested = false;
let playbackConfirmed = false;
let failureReported = false;
let startupWatchdog: ReturnType<typeof setTimeout> | undefined;
let nativeSeekTimer: ReturnType<typeof setTimeout> | undefined;
let nativeSeekInFlight = false;
let queuedSeekPosition: number | undefined;
let optimisticSeekPosition: number | undefined;
let optimisticSeekStateUntil = 0;
let closing = false;
let startupStartedAt = 0;
let readyReported = false;
let bufferingStartedAt = 0;
let bufferingActive = false;

const VOD_STARTUP_TIMEOUT_MS = 15_000;
const LIVE_STARTUP_TIMEOUT_MS = 8_000;
const NATIVE_SEEK_DEBOUNCE_MS = 80;
const OPTIMISTIC_SEEK_STATE_WINDOW_MS = 1_000;

const isLive = computed(() => props.session.contentKind === "live");
const liveMode = computed(() => props.session.liveMode ?? "live");
const isRealtimeLive = computed(() => isLive.value && liveMode.value === "live");
const isReplay = computed(() => isLive.value && liveMode.value !== "live");
const progressPercent = computed(() => duration.value > 0 ? Math.min(100, Math.max(0, (position.value / duration.value) * 100)) : 0);
const liveProgrammeText = computed(() => {
  if (!isLive.value) return "";
  if (props.session.programmeTitle) {
    const ending = props.session.programmeEndAt ? ` · 至 ${formatClock(props.session.programmeEndAt)}` : "";
    return `${props.session.programmeTitle}${ending}`;
  }
  return liveMode.value === "catchup" ? "节目回看" : liveMode.value === "timeshift" ? "直播时移" : "实时直播";
});
const statusText = computed(() => {
  if (status.value === "loading") return isLive.value ? `正在连接“${props.session.title}”…` : "正在启动高兼容播放内核…";
  if (status.value === "paused") return "已暂停";
  if (status.value === "buffering") return "正在缓冲直播数据…";
  if (status.value === "ended") return "播放完成";
  if (status.value === "error") return errorMessage.value || "高兼容播放失败";
  if (isReplay.value) return liveMode.value === "timeshift" ? "直播时移播放中" : "节目回看中";
  return "高兼容播放中";
});

function snapshot(): PlaybackProgress {
  const completed = duration.value > 0 && (position.value / duration.value >= 0.95 || duration.value - position.value <= 90);
  return {
    position: Math.max(0, position.value),
    duration: Math.max(0, duration.value),
    completed,
  };
}

function friendlyPlaybackError(error: unknown): string {
  if (typeof error === "object" && error !== null && "userMessage" in error) {
    const userMessage = String((error as { userMessage?: unknown }).userMessage ?? "").trim();
    if (userMessage) return userMessage;
  }
  if (error instanceof Error && error.message) return error.message;
  return String(error || "播放失败");
}

function nativeSurfaceRect() {
  const element = nativeSurface.value;
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return undefined;
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

async function attachNativeSurface() {
  await nextTick();
  const rect = nativeSurfaceRect();
  if (!rect) throw new Error("播放器画面区域尚未准备完成");
  if (typeof window.tvApi.attachNativePlayerView !== "function") throw new Error("当前版本不支持应用内原生视频视图");
  const response = await window.tvApi.attachNativePlayerView(rect);
  nativeSurfaceAttached.value = response?.ok === true && response?.backend === "native-libmpv";
  if (response?.fallback || response?.backend === "mpv-ipc") {
    return;
  }
  if (!nativeSurfaceAttached.value) throw new Error(response?.message || "原生视频视图挂载失败");
}

async function resizeNativeSurface() {
  if (!nativeSurfaceAttached.value) return;
  const rect = nativeSurfaceRect();
  if (rect) await window.tvApi.resizeNativePlayerView?.(rect).catch(() => undefined);
}

async function detachNativeSurface() {
  nativeSurfaceAttached.value = false;
  await window.tvApi.detachNativePlayerView?.().catch(() => undefined);
}

function clearStartupWatchdog() {
  if (!startupWatchdog) return;
  clearTimeout(startupWatchdog);
  startupWatchdog = undefined;
}

function reportCompatibilityFailure(reason: string) {
  clearStartupWatchdog();
  stopRequested = true;
  void window.tvApi.stop?.().catch(() => undefined);
  status.value = "error";
  errorMessage.value = reason;
  if (failureReported || props.compatibilityFallbackMode !== "automatic") return;
  failureReported = true;
  emit("failure", { progress: snapshot(), reason });
}

function armStartupWatchdog() {
  clearStartupWatchdog();
  startupWatchdog = setTimeout(() => {
    if (disposed || stopRequested || playbackConfirmed) return;
    reportCompatibilityFailure(isLive.value
      ? "直播线路在 8 秒内没有输出有效画面，正在自动重连或切换备用线路。"
      : "高兼容播放内核在 15 秒内未读取到有效媒体数据，正在尝试备用线路。");
  }, isLive.value ? LIVE_STARTUP_TIMEOUT_MS : VOD_STARTUP_TIMEOUT_MS);
}

function formatClock(value: number) {
  if (!Number.isFinite(value)) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "00:00";
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clampSeekPosition(value: number) {
  const normalized = Math.max(0, Number(value) || 0);
  return duration.value > 0 ? Math.min(duration.value, normalized) : normalized;
}

function cancelQueuedNativeSeek() {
  if (nativeSeekTimer) clearTimeout(nativeSeekTimer);
  nativeSeekTimer = undefined;
  queuedSeekPosition = undefined;
  optimisticSeekPosition = undefined;
  optimisticSeekStateUntil = 0;
}

function queueNativeSeek(value: number) {
  const target = clampSeekPosition(value);
  // Holding an arrow key can otherwise send dozens of absolute mpv seeks per
  // second. Keep 10-second steps precise in the UI, then send only the latest
  // target once the key burst settles.
  queuedSeekPosition = target;
  optimisticSeekPosition = target;
  optimisticSeekStateUntil = Date.now() + OPTIMISTIC_SEEK_STATE_WINDOW_MS;
  position.value = target;
  if (nativeSeekTimer) clearTimeout(nativeSeekTimer);
  nativeSeekTimer = setTimeout(() => {
    nativeSeekTimer = undefined;
    void flushQueuedNativeSeek();
  }, NATIVE_SEEK_DEBOUNCE_MS);
}

async function flushQueuedNativeSeek() {
  if (nativeSeekInFlight || stopRequested) return;
  const target = queuedSeekPosition;
  queuedSeekPosition = undefined;
  if (target === undefined) return;
  nativeSeekInFlight = true;
  try {
    await window.tvApi.seek?.(target);
    position.value = target;
    emit("progress", snapshot());
  } catch (error) {
    reportCompatibilityFailure(`跳转播放位置失败：${friendlyPlaybackError(error)}`);
  } finally {
    nativeSeekInFlight = false;
    if (queuedSeekPosition !== undefined && !stopRequested) queueNativeSeek(queuedSeekPosition);
  }
}

async function startNativePlayback() {
  clearStartupWatchdog();
  cancelQueuedNativeSeek();
  stopRequested = false;
  status.value = "loading";
  errorMessage.value = "";
  started = false;
  playbackConfirmed = false;
  failureReported = false;
  readyReported = false;
  startupStartedAt = Date.now();
  position.value = Math.max(0, props.session.startPosition ?? 0);
  duration.value = 0;
  try {
    // During a channel change the existing Cocoa child view otherwise stays
    // above the renderer while libmpv replaces the stream, which looks like a
    // frozen black screen. Remove it first so the player shell can show a clear
    // switching state, then attach a fresh surface after the new load starts.
    if (nativeSurfaceAttached.value) await detachNativeSurface();
    const playbackResult = await window.tvApi.fallbackPlayback(props.session.sessionId) as { backend?: string };
    if (playbackResult?.backend === "native-libmpv") {
      await attachNativeSurface();
    } else {
      nativeSurfaceAttached.value = false;
    }
    await window.tvApi.setSpeed?.(speed.value);
    if (position.value > 0) await window.tvApi.seek(position.value);
    if (props.session.subtitleUrl) {
      void window.tvApi.addSubtitle?.(props.session.subtitleUrl).catch(() => undefined);
    }
    if (props.subtitleSettings?.delaySeconds) {
      void window.tvApi.setSubtitleDelay?.(props.subtitleSettings.delaySeconds).catch(() => undefined);
    }
    armStartupWatchdog();
  } catch (error) {
    reportCompatibilityFailure(friendlyPlaybackError(error));
  }
}

async function stopNativePlayback() {
  stopRequested = true;
  clearStartupWatchdog();
  cancelQueuedNativeSeek();
  await window.tvApi.stop?.().catch(() => undefined);
}

async function togglePlayback() {
  if (status.value === "paused") {
    await window.tvApi.play?.();
    status.value = "playing";
    return;
  }
  await window.tvApi.pause?.();
  status.value = "paused";
  emit("progress", snapshot());
}

async function seekTo(event: Event) {
  const target = event.target as HTMLInputElement;
  const nextPosition = Number(target.value);
  if (!Number.isFinite(nextPosition)) return;
  queueNativeSeek(nextPosition);
}

async function changeSpeed() {
  await window.tvApi.setSpeed?.(speed.value).catch(() => undefined);
}

async function changeVolume() {
  volume.value = Math.max(0, Math.min(100, Math.round(Number(volume.value) || 0)));
  muted.value = volume.value <= 0 ? true : muted.value;
  await window.tvApi.setVolume?.(volume.value).catch(() => undefined);
  await window.tvApi.setMuted?.(muted.value).catch(() => undefined);
}

async function toggleMute() {
  muted.value = !muted.value;
  await window.tvApi.setMuted?.(muted.value).catch(() => undefined);
}

function requestTimeshift(offsetSeconds: number) {
  if (!isRealtimeLive.value || !props.session.timeshiftAvailable) return;
  emit("timeshift", Math.max(60, Math.floor(offsetSeconds)));
}

function requestGoLive() {
  if (!isReplay.value) return;
  emit("goLive");
}

function selectLiveLine(event: Event) {
  const lineId = (event.target as HTMLSelectElement).value;
  if (lineId && lineId !== props.currentLiveLineId) emit("selectLiveLine", lineId);
}

function selectLiveChannel(event: Event) {
  const channelId = (event.target as HTMLSelectElement).value;
  if (channelId && channelId !== props.currentLiveChannelId) emit("selectLiveChannel", channelId);
}

function requestLiveReconnect() {
  if (isRealtimeLive.value) emit("reconnectLive");
}

function requestLiveGuide() {
  if (isLive.value) emit("openLiveGuide", snapshot());
}

async function readFullscreenState(): Promise<boolean> {
  if (typeof window.tvApi.getWindowFullscreen === "function") {
    return Boolean(await window.tvApi.getWindowFullscreen().catch(() => false));
  }
  return Boolean(document.fullscreenElement);
}

async function setFullscreen(enabled: boolean): Promise<void> {
  if (typeof window.tvApi.setWindowFullscreen === "function") {
    fullscreenActive.value = Boolean(await window.tvApi.setWindowFullscreen(enabled).catch(() => false));
  } else if (enabled) {
    await root.value?.requestFullscreen();
    fullscreenActive.value = Boolean(document.fullscreenElement);
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
    fullscreenActive.value = false;
  }
  await nextTick();
  root.value?.focus({ preventScroll: true });
  await resizeNativeSurface();
}

async function toggleFullscreen() {
  await setFullscreen(!(await readFullscreenState()));
}

async function syncFullscreenState() {
  fullscreenActive.value = await readFullscreenState();
  if (fullscreenActive.value) queueMicrotask(() => root.value?.focus({ preventScroll: true }));
}

function closePlayer() {
  if (closing) return;
  closing = true;
  if (miniModeActive.value) void window.tvApi.setWindowMiniMode?.(false).catch(() => undefined);
  if (alwaysOnTopActive.value) void window.tvApi.setWindowAlwaysOnTop?.(false).catch(() => undefined);
  const progress = snapshot();
  emit("progress", progress);
  stopRequested = true;
  // Notify the parent immediately. Native view detach/stop may occasionally
  // wait on the platform video surface, which must not make the Back button
  // appear unresponsive.
  emit("close", progress);
  void Promise.allSettled([
    detachNativeSurface(),
    stopNativePlayback(),
  ]);
}

async function retryNativePlayback() {
  await stopNativePlayback();
  void startNativePlayback();
}

async function previousEpisode() {
  if (!props.hasPrevious) return;
  const progress = snapshot();
  emit("progress", progress);
  status.value = "loading";
  errorMessage.value = "";
  emit("previous", progress);
}

async function nextEpisode() {
  if (!props.hasNext) return;
  const progress = snapshot();
  emit("progress", progress);
  status.value = "loading";
  errorMessage.value = "";
  emit("next", progress);
}

async function selectEpisode(episodeUrl: string) {
  if (!episodeUrl || episodeUrl === props.currentEpisodeUrl) return;
  const progress = snapshot();
  episodeDrawerOpen.value = false;
  emit("progress", progress);
  await detachNativeSurface();
  await stopNativePlayback();
  emit("selectEpisode", { episodeUrl, progress });
}

async function toggleEpisodeDrawer() {
  if (isLive.value || props.episodes.length === 0) return;
  const opening = !episodeDrawerOpen.value;
  episodeDrawerOpen.value = opening;
  controlsVisible.value = true;
  // A native child view sits above renderer DOM. Hide it while the drawer is
  // open so every episode remains clickable instead of being covered by video.
  if (opening) {
    clearControlsTimer();
    await detachNativeSurface();
  } else {
    scheduleControlsHide();
    if (!stopRequested && status.value !== "error") {
      await attachNativeSurface().catch((error) => {
        errorMessage.value = friendlyPlaybackError(error);
      });
    }
  }
}

async function closeEpisodeDrawer() {
  if (!episodeDrawerOpen.value) return;
  episodeDrawerOpen.value = false;
  controlsVisible.value = true;
  scheduleControlsHide();
  if (!stopRequested && status.value !== "error") {
    await attachNativeSurface().catch((error) => {
      errorMessage.value = friendlyPlaybackError(error);
    });
  }
}

function flushBufferingMetric(cachePercent = 0): void {
  if (!bufferingActive) return;
  const durationMs = Math.max(0, Date.now() - bufferingStartedAt);
  bufferingActive = false;
  bufferingStartedAt = 0;
  if (durationMs >= 250) emit("buffering", { durationMs, cachePercent: Math.max(0, Math.min(100, cachePercent)) });
}

function handlePlayerState(state: { position?: number; duration?: number; paused?: boolean; stopped?: boolean; volume?: number; muted?: boolean; buffering?: boolean; cachePercent?: number; videoReady?: boolean }) {
  if (disposed || stopRequested) return;
  if (Number.isFinite(state.position)) {
    if (optimisticSeekPosition === undefined || Date.now() >= optimisticSeekStateUntil) {
      optimisticSeekPosition = undefined;
      position.value = Math.max(0, Number(state.position));
    }
  }
  if (Number.isFinite(state.duration)) duration.value = Math.max(0, Number(state.duration));
  if (Number.isFinite(state.volume)) volume.value = Math.max(0, Math.min(100, Number(state.volume)));
  if (typeof state.muted === "boolean") muted.value = state.muted;
  if (state.stopped === true) {
    flushBufferingMetric(Number.isFinite(state.cachePercent) ? Number(state.cachePercent) : 0);
    if (!started) return;
    if (!playbackConfirmed && position.value <= 0 && duration.value <= 0) {
      reportCompatibilityFailure("高兼容播放内核未能打开当前媒体，正在尝试备用线路。");
      return;
    }
    clearStartupWatchdog();
    status.value = "ended";
    controlsVisible.value = true;
    clearControlsTimer();
    const progress = snapshot();
    emit("progress", progress);
    emit("ended", progress);
    return;
  }

  started = true;
  if (!playbackConfirmed && (state.videoReady === true || position.value > 0 || duration.value > 0)) {
    playbackConfirmed = true;
    clearStartupWatchdog();
    if (!readyReported) {
      readyReported = true;
      emit("ready", Math.max(1, Date.now() - startupStartedAt));
    }
  }
  if (playbackConfirmed && state.buffering === true && !bufferingActive) {
    bufferingActive = true;
    bufferingStartedAt = Date.now();
  } else if (bufferingActive && state.buffering !== true) {
    flushBufferingMetric(Number.isFinite(state.cachePercent) ? Number(state.cachePercent) : 0);
  }
  const previousStatus = status.value;
  status.value = playbackConfirmed
    ? state.buffering === true
      ? "buffering"
      : state.paused ? "paused" : "playing"
    : "loading";
  if (status.value === "playing") {
    if (previousStatus !== "playing") {
      scheduleControlsHide();
    }
  } else {
    controlsVisible.value = true;
    clearControlsTimer();
  }
  if (playbackConfirmed && Date.now() - lastProgressAt >= 15_000) {
    lastProgressAt = Date.now();
    emit("progress", snapshot());
  }
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
    if (event.key === "Escape") target.blur();
    else return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  showControls();
  if (episodeDrawerOpen.value && event.key === "Escape") {
    event.preventDefault();
    void closeEpisodeDrawer();
    return;
  }
  if (event.key === "Escape" && (fullscreenActive.value || document.fullscreenElement)) {
    event.preventDefault();
    void setFullscreen(false);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    void closePlayer();
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    void togglePlayback();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (isRealtimeLive.value) {
      requestTimeshift(5 * 60);
      return;
    }
    queueNativeSeek(position.value - 10);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    if (isRealtimeLive.value) return;
    queueNativeSeek(position.value + 10);
    return;
  }
  if (event.key.toLowerCase() === "l" && isReplay.value) {
    event.preventDefault();
    requestGoLive();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    volume.value = Math.min(100, volume.value + 5);
    if (volume.value > 0) muted.value = false;
    void changeVolume();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    volume.value = Math.max(0, volume.value - 5);
    if (volume.value <= 0) muted.value = true;
    void changeVolume();
    return;
  }
  if (event.key.toLowerCase() === "m") {
    event.preventDefault();
    void toggleMute();
    return;
  }
  if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (event.key.toLowerCase() === "t") {
    event.preventDefault();
    void toggleAlwaysOnTop();
    return;
  }
  if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    const order: Array<"auto" | "16:9" | "4:3" | "stretch"> = ["auto", "16:9", "4:3", "stretch"];
    const nextIdx = (order.indexOf(aspectRatio.value) + 1) % order.length;
    void changeAspectRatio(order[nextIdx]);
    return;
  }
  if (event.key.toLowerCase() === "a") {
    event.preventDefault();
    void cycleAudioTrack();
    return;
  }
  if (event.key === "[") {
    event.preventDefault();
    void adjustSubtitleDelay(-0.5);
    return;
  }
  if (event.key === "]") {
    event.preventDefault();
    void adjustSubtitleDelay(0.5);
    return;
  }
  if (event.key === "PageUp") {
    event.preventDefault();
    void previousEpisode();
    return;
  }
  if (event.key === "PageDown") {
    event.preventDefault();
    void nextEpisode();
  }
}

watch(() => props.session.sessionId, () => void startNativePlayback());
watch(() => props.session.danmakuUrl, () => { danmakuEnabled.value = true; });
watch(() => props.session.subtitleUrl, (url) => {
  if (url) void window.tvApi.addSubtitle?.(url).catch(() => undefined);
});
watch(() => props.subtitleSettings?.delaySeconds, (delay) => {
  if (typeof delay === "number") {
    subtitleDelay.value = delay;
    void window.tvApi.setSubtitleDelay?.(delay).catch(() => undefined);
  }
});
watch(() => props.defaultSpeed, (value) => {
  speed.value = Number(value) || 1;
  void changeSpeed();
});

onMounted(() => {
  document.addEventListener("keydown", handleKeydown, true);
  document.addEventListener("fullscreenchange", syncFullscreenState);
  window.addEventListener("resize", syncFullscreenState);
  void syncFullscreenState();
  void window.tvApi.getWindowAlwaysOnTop?.().then((val: boolean) => {
    alwaysOnTopActive.value = Boolean(val);
  });
  void window.tvApi.getWindowMiniMode?.().then((val: boolean) => {
    miniModeActive.value = Boolean(val);
  });
  removePlayerState = window.tvApi.onPlayerState?.(handlePlayerState);
  if (nativeSurface.value && typeof ResizeObserver !== "undefined") {
    nativeSurfaceObserver = new ResizeObserver(() => void resizeNativeSurface());
    nativeSurfaceObserver.observe(nativeSurface.value);
  }
  updateLiveClock();
  liveClockTimer = setInterval(updateLiveClock, 1000);
  void startNativePlayback();
});

onBeforeUnmount(() => {
  if (liveClockTimer) clearInterval(liveClockTimer);
  if (miniModeActive.value) void window.tvApi.setWindowMiniMode?.(false).catch(() => undefined);
  if (alwaysOnTopActive.value) void window.tvApi.setWindowAlwaysOnTop?.(false).catch(() => undefined);
  if (playerToastTimer) clearTimeout(playerToastTimer);
  flushBufferingMetric();
  disposed = true;
  clearStartupWatchdog();
  clearControlsTimer();
  cancelQueuedNativeSeek();
  document.removeEventListener("keydown", handleKeydown, true);
  document.removeEventListener("fullscreenchange", syncFullscreenState);
  window.removeEventListener("resize", syncFullscreenState);
  removePlayerState?.();
  nativeSurfaceObserver?.disconnect();
  nativeSurfaceObserver = undefined;
  void detachNativeSurface();
  if (!stopRequested) void stopNativePlayback();
});
</script>

<template>
  <section
    ref="root"
    class="native-player-host"
    :class="[`state-${status}`, { 'is-fullscreen': fullscreenActive, 'is-mini-mode': miniModeActive, 'controls-hidden': !controlsVisible && !episodeDrawerOpen }]"
    tabindex="-1"
    @mousemove="showControls"
    @mouseleave="scheduleControlsHide"
  >
    <header class="native-player-topbar">
      <div class="mac-window-controls-safe-area" aria-hidden="true"></div>
      <div class="native-player-title">
        <small>{{ isLive ? (liveMode === 'live' ? 'LIVE · 实时直播' : liveMode === 'catchup' ? 'REPLAY · 节目回看' : 'TIMESHIFT · 直播时移') : '高兼容播放模式' }}</small>
        <strong>{{ session.title }}<template v-if="isLive"> · {{ liveProgrammeText }}</template><template v-else> · {{ session.episode }}</template></strong>
      </div>
      <em>{{ statusText }}</em>
      <button v-if="!isLive && session.danmakuUrl" class="native-control-button text-action" :class="{ active: danmakuEnabled }" @click="danmakuEnabled = !danmakuEnabled">弹幕</button>
      <button v-if="session.subtitleUrl" class="native-control-button text-action" :class="{ active: subtitleVisible }" @click="toggleSubtitle">字幕</button>
      <button class="native-control-button text-action" :class="{ active: alwaysOnTopActive }" :title="alwaysOnTopActive ? '取消置顶（T）' : '置顶播放（T）'" @click="toggleAlwaysOnTop"><AppIcon name="pin" :size="14" />置顶</button>
      <button class="native-control-button text-action" :class="{ active: miniModeActive }" :title="miniModeActive ? '退出小窗模式' : '小窗模式播放'" @click="toggleMiniMode">小窗</button>
      <button class="native-control-button native-back-button" :title="isLive ? '停止播放并返回直播频道' : '停止播放并返回影片详情'" @click="closePlayer"><AppIcon name="back" :size="16" />{{ isLive ? '返回直播' : '返回详情' }}</button>
    </header>

    <div v-if="playerToast" class="player-toast" role="status">{{ playerToast }}</div>

    <DanmakuOverlay
      v-if="!isLive"
      :danmaku-url="session.danmakuUrl"
      :current-time="position"
      :enabled="danmakuEnabled"
      :visible="status !== 'error'"
      :settings="danmakuSettings"
    />

    <main
      ref="nativeSurface"
      class="native-player-stage"
      :class="{ 'native-surface-attached': nativeSurfaceAttached }"
      @dblclick.prevent="toggleFullscreen"
    >
      <div v-if="!nativeSurfaceAttached" class="native-player-card">
        <AppIcon name="play" :size="44" />
        <h2>{{ isLive ? `正在连接 ${session.title}` : '正在使用高兼容播放内核' }}</h2>
        <p>{{ isLive ? '播放器保持在当前页面内切换频道；若线路没有输出画面，将自动重连或尝试备用线路。' : '视频画面由应用内兼容内核承载，播放控制、选集和进度仍由当前页面统一管理。' }}</p>
        <span v-if="errorMessage" class="native-player-error">{{ errorMessage }}</span>
        <div v-if="status === 'error'" class="native-error-actions">
          <button class="native-control-button" @click="retryNativePlayback">重新尝试高兼容播放</button>
        </div>
      </div>
    </main>

    <footer class="native-player-controls">
      <button class="native-control-button" :disabled="status === 'loading' || status === 'error'" @click="togglePlayback">
        <AppIcon :name="status === 'paused' ? 'play' : 'pause'" :size="16" />{{ status === 'paused' ? '播放' : '暂停' }}
      </button>
      <select v-if="isRealtimeLive && liveChannels.length > 1" class="native-live-channel-select" :value="currentLiveChannelId" aria-label="直播频道" @change="selectLiveChannel">
        <option v-for="channel in liveChannels" :key="channel.id" :value="channel.id" :disabled="channel.disabled">{{ channel.name }}</option>
      </select>
      <button class="native-control-button" :disabled="!hasPrevious" :title="isLive ? '上一个频道（Page Up）' : '上一集（Page Up）'" @click="previousEpisode"><AppIcon name="rewind" :size="16" />{{ isLive ? '上个频道' : '上一集' }}</button>
      <button class="native-control-button" :disabled="!hasNext" :title="isLive ? '下一个频道（Page Down）' : '下一集（Page Down）'" @click="nextEpisode">{{ isLive ? '下个频道' : '下一集' }}<AppIcon name="forward" :size="16" /></button>
      <select v-if="isRealtimeLive && liveLines.length" class="native-live-line-select" :value="currentLiveLineId" aria-label="直播线路" @change="selectLiveLine">
        <option v-for="line in liveLines" :key="line.id" :value="line.id" :disabled="line.disabled">{{ line.name }}{{ line.status ? ` · ${line.status}` : '' }}</option>
      </select>
      <button v-if="isRealtimeLive" class="native-control-button compact" title="重新连接当前直播线路" @click="requestLiveReconnect"><AppIcon name="refresh" :size="15" />刷新直播</button>
      <template v-if="isRealtimeLive && session.timeshiftAvailable">
        <button class="native-control-button compact" @click="requestTimeshift(5 * 60)">回看 5 分</button>
        <button class="native-control-button compact" @click="requestTimeshift(15 * 60)">回看 15 分</button>
        <button class="native-control-button compact" @click="requestTimeshift(30 * 60)">回看 30 分</button>
      </template>
      <button v-if="isLive" class="native-control-button" title="打开当前频道节目单" @click="requestLiveGuide"><AppIcon name="grid" :size="15" />节目单</button>
      <button v-if="isReplay" class="native-control-button live-edge-button" @click="requestGoLive"><span class="live-dot"></span>回到直播</button>
      <div v-if="isRealtimeLive" class="native-live-time-status">
        <span class="native-live-dot"></span>
        <span class="native-live-text">实时直播</span>
        <span class="native-live-clock">{{ currentLiveClock }}</span>
      </div>
      <span v-if="!isRealtimeLive" class="native-time">{{ formatTime(position) }}</span>
      <input v-if="!isRealtimeLive" class="native-progress" type="range" min="0" :max="Math.max(duration, position, 1)" :value="position" :style="{ '--progress': `${progressPercent}%` }" @input="seekTo" />
      <span v-if="!isRealtimeLive" class="native-time">{{ formatTime(duration) }}</span>
      <select v-if="!isLive" v-model.number="speed" class="native-speed" @change="changeSpeed"><option :value="0.75">0.75×</option><option :value="1">1.0×</option><option :value="1.25">1.25×</option><option :value="1.5">1.5×</option><option :value="2">2.0×</option></select>
      <span v-else class="native-live-badge">直播</span>
      <select v-model="aspectRatio" class="native-speed native-aspect-ratio" aria-label="画面比例" title="画面比例（R）" @change="() => changeAspectRatio()"><option value="auto">默认比例</option><option value="16:9">16:9</option><option value="4:3">4:3</option><option value="stretch">铺满拉伸</option></select>
      <button class="native-control-button compact" title="切换音轨（A）" @click="cycleAudioTrack">音轨</button>
      <button class="native-control-button compact" :title="fullscreenActive ? '退出全屏（F）' : '进入全屏（F）'" @click="toggleFullscreen"><AppIcon name="grid" :size="15" />{{ fullscreenActive ? '退出全屏' : '全屏' }}</button>
      <button class="native-control-button compact" :disabled="status === 'loading'" title="静音切换（M）" @click="toggleMute">{{ muted || volume <= 0 ? '静音' : '音量' }}</button>
      <input class="native-volume" type="range" min="0" max="100" v-model.number="volume" :title="`音量 ${Math.round(volume)}%`" @input="changeVolume" />
      <button v-if="!isLive && episodes.length" class="native-control-button" @click="toggleEpisodeDrawer"><AppIcon name="grid" :size="16" />选集</button>
    </footer>

    <div
      class="persistent-mini-progress"
      :class="{ visible: !controlsVisible && !miniModeActive && status !== 'error' }"
      role="progressbar"
      :aria-valuenow="Math.round(position)"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(duration)"
    >
      <div
        class="persistent-mini-progress-fill"
        :class="{ 'is-live': isRealtimeLive }"
        :style="{ width: isRealtimeLive ? '100%' : `${progressPercent}%` }"
      ></div>
    </div>

    <div v-if="episodeDrawerOpen" class="native-episode-drawer-backdrop" @click="closeEpisodeDrawer"></div>
    <aside v-if="episodeDrawerOpen" class="native-episode-drawer">
      <header><strong>选集</strong><button class="native-icon-button" @click="closeEpisodeDrawer"><AppIcon name="close" :size="15" /></button></header>
      <button v-for="episode in episodes" :key="episode.url" :class="{ active: episode.url === currentEpisodeUrl }" @click="selectEpisode(episode.url)">{{ episode.name }}</button>
    </aside>
  </section>
</template>

<style scoped>
.native-player-host {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #05070b;
  color: #fff;
  overflow: hidden;
  outline: none;
}
.native-player-host.controls-hidden {
  cursor: none;
}
.native-player-topbar {
  --mac-window-controls-safe-width: 96px;
  position: absolute;
  inset: 0 0 auto;
  z-index: 6;
  height: 68px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 20px;
  border-bottom: 1px solid rgba(255,255,255,.08);
  background: linear-gradient(180deg, rgba(7,10,16,.96), rgba(7,10,16,.75));
  backdrop-filter: blur(16px);
  transition: opacity 180ms ease, transform 180ms ease;
  -webkit-app-region: drag;
}
.mac-window-controls-safe-area { display: none; width: 0; height: 100%; flex: 0 0 0; pointer-events: none; }
:global(html[data-platform="darwin"]) .mac-window-controls-safe-area { display: block; width: var(--mac-window-controls-safe-width); flex-basis: var(--mac-window-controls-safe-width); }
.native-player-host.is-fullscreen .mac-window-controls-safe-area,
.native-player-host:fullscreen .mac-window-controls-safe-area { display: none; }
.native-player-topbar .native-control-button,
.native-player-topbar .native-back-button { -webkit-app-region: no-drag; }
.native-player-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.native-player-topbar small { color: rgba(255,255,255,.52); letter-spacing: .12em; font-size: 11px; }
.native-player-topbar strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.native-player-topbar em { color: rgba(255,255,255,.68); font-style: normal; font-size: 13px; }
.native-player-stage {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  padding: 28px;
  background: radial-gradient(circle at 50% 30%, rgba(10,132,255,.18), transparent 36%), #05070b;
}
.native-player-card { width: min(520px, 90vw); display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; color: rgba(255,255,255,.78); }
.native-player-card h2 { margin: 4px 0 0; color: #fff; }
.native-player-card p { margin: 0; line-height: 1.6; }
.native-player-error { color: #ffb4ab; }
.native-error-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.native-player-controls {
  position: absolute;
  inset: auto 0 0;
  z-index: 6;
  min-height: 78px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-top: 1px solid rgba(255,255,255,.08);
  background: linear-gradient(0deg, rgba(7,10,16,.96), rgba(7,10,16,.75));
  backdrop-filter: blur(16px);
  transition: opacity 180ms ease, transform 180ms ease;
}
.controls-hidden .native-player-topbar {
  pointer-events: none;
  opacity: 0;
  transform: translateY(-12px);
}
.controls-hidden .native-player-controls {
  pointer-events: none;
  opacity: 0;
  transform: translateY(12px);
}
.native-icon-button,.native-control-button { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.native-icon-button { width: 36px; height: 36px; }
.native-control-button { height: 38px; padding: 0 12px; }
.native-back-button { flex: 0 0 auto; }
.native-control-button.compact { min-width: 54px; padding: 0 10px; }
.native-control-button.active { border-color: rgba(10,132,255,.6); background: rgba(10,132,255,.18); color: #82bdff; }
.live-edge-button { border-color: rgba(255,90,90,.3); }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: #ff5252; box-shadow: 0 0 0 3px rgba(255,82,82,.15); }
.native-control-button:disabled { opacity: .45; }
.native-time { min-width: 48px; color: rgba(255,255,255,.68); font-variant-numeric: tabular-nums; text-align: center; font-size: 12px; }
.native-progress { flex: 1; accent-color: #0a84ff; }
.native-volume { width: 92px; accent-color: #0a84ff; }
.native-speed,.native-live-line-select,.native-live-channel-select { height: 38px; border: 1px solid rgba(255,255,255,.12); border-radius: 10px; background: rgba(255,255,255,.08); color: #fff; padding: 0 8px; }
.native-live-channel-select { min-width: 150px; max-width: 230px; }
.native-live-line-select { min-width: 122px; max-width: 190px; }
.native-live-badge { flex: 1 1 52px; color: #72d99a; font-size: 12px; letter-spacing: .12em; text-align: center; }
@media (max-width: 1180px) {
  .native-player-controls { gap: 8px; padding: 8px 12px; }
  .native-control-button { padding: 0 9px; }
  .native-live-channel-select { min-width: 128px; max-width: 170px; }
  .native-live-line-select { min-width: 108px; max-width: 150px; }
  .native-volume { width: 76px; }
}
.native-episode-drawer-backdrop { position: absolute; inset: 0; z-index: 7; }
.native-episode-drawer { position: absolute; right: 18px; bottom: 88px; z-index: 8; width: min(360px, calc(100vw - 36px)); max-height: min(520px, calc(100vh - 160px)); overflow: auto; border: 1px solid rgba(255,255,255,.12); border-radius: 16px; background: rgba(16,20,28,.96); padding: 12px; box-shadow: 0 18px 60px rgba(0,0,0,.45); }
.native-episode-drawer header { display: flex; align-items: center; justify-content: space-between; padding: 0 0 10px; }
.native-episode-drawer button:not(.native-icon-button) { width: 100%; margin-bottom: 8px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.05); color: rgba(255,255,255,.82); text-align: left; }
.native-episode-drawer button.active { border-color: rgba(10,132,255,.6); background: rgba(10,132,255,.18); color: #fff; }
.player-toast {
  position: absolute;
  top: 76px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 99;
  background: rgba(15, 18, 26, 0.94);
  color: #fff;
  padding: 8px 20px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  font-size: 14px;
  font-weight: 500;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  backdrop-filter: blur(10px);
}
.native-player-host.is-mini-mode .native-player-topbar {
  height: 44px;
  padding: 0 10px;
  gap: 8px;
}
.native-player-host.is-mini-mode .native-player-title small,
.native-player-host.is-mini-mode .native-player-topbar em,
.native-player-host.is-mini-mode .native-live-badge,
.native-player-host.is-mini-mode .native-speed,
.native-player-host.is-mini-mode .native-aspect-ratio,
.native-player-host.is-mini-mode .native-live-channel-select,
.native-player-host.is-mini-mode .native-live-line-select,
.native-player-host.is-mini-mode .native-volume {
  display: none;
}
.native-player-host.is-mini-mode .native-player-controls {
  min-height: 48px;
  padding: 6px 10px;
  gap: 6px;
  flex-wrap: nowrap;
}
.native-player-host.is-mini-mode .player-toast {
  top: 48px;
  font-size: 12px;
  padding: 5px 12px;
}

.persistent-mini-progress {
  position: absolute;
  inset: auto 0 0 0;
  height: 2px;
  background: rgba(255, 255, 255, 0.16);
  z-index: 10;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
}

.persistent-mini-progress.visible {
  opacity: 1;
}

.persistent-mini-progress-fill {
  height: 100%;
  background: #0a84ff;
  transition: width 150ms linear;
}

.persistent-mini-progress-fill.is-live {
  background: linear-gradient(90deg, #ff3b30, #ff453a);
  box-shadow: 0 0 6px rgba(255, 59, 48, 0.6);
}

.native-live-time-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.9);
}

.native-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #30d158;
  box-shadow: 0 0 6px rgba(48, 209, 88, 0.8);
  animation: pulse-live 2s infinite ease-in-out;
}

@keyframes pulse-live {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}

.native-live-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.72);
}

.native-live-clock {
  font-weight: 600;
  color: #fff;
}
</style>
