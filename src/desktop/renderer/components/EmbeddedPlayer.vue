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
import type { EmbeddedPlaybackSession, PlaybackProgress, PlayerEpisode, PlayerLiveChannel, PlayerLiveLine } from "../player/player-types.ts";
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
  timeshift: [offsetSeconds: number];
  goLive: [];
  selectLiveLine: [lineId: string];
  selectLiveChannel: [channelId: string];
  reconnectLive: [];
  openLiveGuide: [progress: PlaybackSnapshot];
}>();

const root = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const subtitleTrack = ref<HTMLTrackElement>();
const status = ref<"loading" | "playing" | "paused" | "buffering" | "ended" | "error">("loading");
const errorMessage = ref("");
const speed = ref(props.defaultSpeed ?? 1);
const volume = ref(1);
const muted = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const playbackEngine = ref<"native" | "hls.js">("native");
const danmakuEnabled = ref(true);
const episodeDrawerOpen = ref(false);
const controlsVisible = ref(true);
const aspectRatio = ref<"auto" | "16:9" | "4:3" | "stretch">("auto");
const runtimeSubtitleDelay = ref(Number(props.subtitleSettings?.delaySeconds) || 0);
const alwaysOnTopActive = ref(false);
const miniModeActive = ref(false);
const playerToast = ref("");
let playerToastTimer: ReturnType<typeof setTimeout> | undefined;

function showPlayerToast(message: string, durationMs = 2000) {
  playerToast.value = message;
  if (playerToastTimer) clearTimeout(playerToastTimer);
  playerToastTimer = setTimeout(() => {
    playerToast.value = "";
    playerToastTimer = undefined;
  }, durationMs);
}

function changeAspectRatio(ratio?: "auto" | "16:9" | "4:3" | "stretch") {
  if (ratio) aspectRatio.value = ratio;
  const labels: Record<string, string> = {
    auto: "默认比例",
    "16:9": "16:9",
    "4:3": "4:3",
    stretch: "铺满拉伸",
  };
  showPlayerToast(`画面比例：${labels[aspectRatio.value] ?? aspectRatio.value}`);
}

function cycleAudioTrack() {
  if (hls && hls.audioTracks && hls.audioTracks.length > 1) {
    const current = Math.max(-1, Number(hls.audioTrack));
    const nextTrack = (current + 1) % hls.audioTracks.length;
    hls.audioTrack = nextTrack;
    const trackName = hls.audioTracks[nextTrack]?.name || `音轨 ${nextTrack + 1}`;
    showPlayerToast(`已切换音轨：${trackName}`);
    return;
  }
  const element = video.value;
  const audioTracks = (element as any)?.audioTracks;
  if (audioTracks && audioTracks.length > 1) {
    let currentIdx = -1;
    for (let i = 0; i < audioTracks.length; i++) {
      if (audioTracks[i].enabled) {
        currentIdx = i;
        break;
      }
    }
    const nextIdx = (currentIdx + 1) % audioTracks.length;
    for (let i = 0; i < audioTracks.length; i++) {
      audioTracks[i].enabled = (i === nextIdx);
    }
    const trackLabel = audioTracks[nextIdx]?.label || `音轨 ${nextIdx + 1}`;
    showPlayerToast(`已切换音轨：${trackLabel}`);
    return;
  }
  showPlayerToast("当前媒体仅包含单一音轨");
}

function adjustSubtitleDelay(delta: number) {
  runtimeSubtitleDelay.value = Math.round((runtimeSubtitleDelay.value + delta) * 10) / 10;
  if (Object.is(runtimeSubtitleDelay.value, -0)) runtimeSubtitleDelay.value = 0;
  applySubtitlePreferences(runtimeSubtitleDelay.value);
  const sign = runtimeSubtitleDelay.value > 0 ? "+" : "";
  showPlayerToast(`字幕延迟：${sign}${runtimeSubtitleDelay.value.toFixed(1)}s`);
}

async function toggleAlwaysOnTop() {
  const next = !alwaysOnTopActive.value;
  alwaysOnTopActive.value = Boolean(await window.tvApi.setWindowAlwaysOnTop?.(next).catch(() => false));
  showPlayerToast(alwaysOnTopActive.value ? "已开启窗口置顶" : "已取消窗口置顶");
}

async function toggleMiniMode() {
  const next = !miniModeActive.value;
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture().catch(() => undefined);
  }
  miniModeActive.value = Boolean(await window.tvApi.setWindowMiniMode?.(next).catch(() => false));
  alwaysOnTopActive.value = miniModeActive.value;
  showPlayerToast(miniModeActive.value ? "已进入小窗模式" : "已退出小窗模式");
}

async function togglePictureInPicture() {
  if (!video.value || !document.pictureInPictureEnabled) return;
  try {
    if (document.pictureInPictureElement === video.value) {
      await document.exitPictureInPicture();
    } else {
      await video.value.requestPictureInPicture();
    }
  } catch {
    showPlayerToast("画中画模式不可用");
  }
}

const progressPercent = computed(() => duration.value > 0 ? Math.min(100, Math.max(0, (currentTime.value / duration.value) * 100)) : 0);
const currentLiveClock = ref("");
let liveClockTimer: ReturnType<typeof setInterval> | undefined;

function updateLiveClock() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  currentLiveClock.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
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
let keyboardSeekTimer: ReturnType<typeof setTimeout> | undefined;
let seekRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let queuedKeyboardSeekPosition: number | undefined;
let activeSeekTarget: number | undefined;
let seekResumeRequested = false;
let seekRecoveryAttempts = 0;

const WEB_SEEK_DEBOUNCE_MS = 100;
const WEB_SEEK_RECOVERY_TIMEOUT_MS = 8_000;

const resolvedSubtitleSettings = computed(() => normalizeSubtitleSettings(props.subtitleSettings));
const isLive = computed(() => props.session.contentKind === "live");
const liveMode = computed(() => props.session.liveMode ?? "live");
const isRealtimeLive = computed(() => isLive.value && liveMode.value === "live");
const isReplay = computed(() => isLive.value && liveMode.value !== "live");
const liveProgrammeText = computed(() => {
  if (!isLive.value) return "";
  if (props.session.programmeTitle) {
    const ending = props.session.programmeEndAt ? ` · 至 ${formatClock(props.session.programmeEndAt)}` : "";
    return `${props.session.programmeTitle}${ending}`;
  }
  return liveMode.value === "catchup" ? "节目回看" : liveMode.value === "timeshift" ? "直播时移" : "实时直播";
});

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

function formatClock(value: number) {
  if (!Number.isFinite(value)) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
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

function toggleEpisodeDrawer() {
  episodeDrawerOpen.value = !episodeDrawerOpen.value;
  controlsVisible.value = true;
  if (episodeDrawerOpen.value) clearControlsTimer();
  else scheduleControlsHide();
}

function snapshot() {
  const mediaPosition = Number.isFinite(video.value?.currentTime) ? Math.max(0, video.value?.currentTime ?? 0) : 0;
  const position = activeSeekTarget !== undefined && mediaPosition + 3 < activeSeekTarget
    ? activeSeekTarget
    : mediaPosition;
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

function clearSeekRecovery() {
  if (keyboardSeekTimer) clearTimeout(keyboardSeekTimer);
  if (seekRecoveryTimer) clearTimeout(seekRecoveryTimer);
  keyboardSeekTimer = undefined;
  seekRecoveryTimer = undefined;
  queuedKeyboardSeekPosition = undefined;
  activeSeekTarget = undefined;
  seekResumeRequested = false;
  seekRecoveryAttempts = 0;
}

function clampWebSeekPosition(element: HTMLVideoElement, value: number) {
  const target = Math.max(0, Number(value) || 0);
  return Number.isFinite(element.duration) ? Math.min(element.duration, target) : target;
}

function armSeekRecovery() {
  if (seekRecoveryTimer) clearTimeout(seekRecoveryTimer);
  seekRecoveryTimer = setTimeout(() => {
    seekRecoveryTimer = undefined;
    const element = video.value;
    const target = activeSeekTarget;
    if (!element || target === undefined || disposed || reprepareRequested) return;
    if (seekRecoveryAttempts < 2) {
      seekRecoveryAttempts += 1;
      element.currentTime = clampWebSeekPosition(element, target);
      if (seekResumeRequested) void element.play().catch(() => undefined);
      armSeekRecovery();
      return;
    }
    // A fresh opaque media session preserves the requested position while
    // clearing a Chromium network pipeline that remained stuck after seeking.
    requestSameLineReprepare();
  }, WEB_SEEK_RECOVERY_TIMEOUT_MS);
}

function seekWebPlayer(target: number, resume: boolean) {
  const element = video.value;
  if (!element) return;
  activeSeekTarget = clampWebSeekPosition(element, target);
  seekResumeRequested = resume;
  seekRecoveryAttempts = 0;
  currentTime.value = activeSeekTarget;
  element.currentTime = activeSeekTarget;
  status.value = "buffering";
  showControls();
  armSeekRecovery();
}

function queueKeyboardSeek(delta: number) {
  const element = video.value;
  if (!element) return;
  const base = queuedKeyboardSeekPosition ?? activeSeekTarget ?? element.currentTime;
  queuedKeyboardSeekPosition = clampWebSeekPosition(element, base + delta);
  currentTime.value = queuedKeyboardSeekPosition;
  if (keyboardSeekTimer) clearTimeout(keyboardSeekTimer);
  keyboardSeekTimer = setTimeout(() => {
    keyboardSeekTimer = undefined;
    const target = queuedKeyboardSeekPosition;
    queuedKeyboardSeekPosition = undefined;
    if (target !== undefined) seekWebPlayer(target, !element.paused);
  }, WEB_SEEK_DEBOUNCE_MS);
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
  clearSeekRecovery();
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
  element.volume = Math.max(0, Math.min(1, volume.value));
  element.muted = muted.value;

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

function applySubtitlePreferences(delayOverride?: number) {
  const element = video.value;
  const track = element?.textTracks?.[0];
  if (!track) return;
  track.mode = "showing";
  const delay = typeof delayOverride === "number" ? delayOverride : runtimeSubtitleDelay.value;
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
  const startPosition = Math.max(0, activeSeekTarget ?? props.session.startPosition ?? 0);
  if ((activeSeekTarget !== undefined || !restoredPosition) && startPosition > 0 && (!duration.value || startPosition < duration.value - 5)) {
    element.currentTime = startPosition;
    currentTime.value = startPosition;
    restoredPosition = true;
  }
}

function onTimeUpdate() {
  const element = video.value;
  if (!element) return;
  const mediaPosition = Number.isFinite(element.currentTime) ? element.currentTime : 0;
  currentTime.value = activeSeekTarget !== undefined && mediaPosition + 3 < activeSeekTarget
    ? activeSeekTarget
    : mediaPosition;
  duration.value = Number.isFinite(element.duration) ? element.duration : duration.value;
  if (Date.now() - lastSavedAt >= 15_000) {
    lastSavedAt = Date.now();
    emit("progress", snapshot());
  }
}

function onSeeking() {
  const element = video.value;
  if (!element) return;
  if (activeSeekTarget === undefined) seekResumeRequested = !element.paused || status.value === "playing" || status.value === "buffering";
  activeSeekTarget = clampWebSeekPosition(element, element.currentTime);
  currentTime.value = activeSeekTarget;
  status.value = "buffering";
  showControls();
  armSeekRecovery();
}

function onSeeked() {
  const element = video.value;
  if (!element) return;
  const seekedPosition = clampWebSeekPosition(element, element.currentTime);
  if (activeSeekTarget === undefined || Math.abs(seekedPosition - activeSeekTarget) <= 3) activeSeekTarget = seekedPosition;
  currentTime.value = activeSeekTarget;
  if (seekResumeRequested && element.paused) void element.play().catch(() => undefined);
  armSeekRecovery();
}

function onPlaying() {
  const element = video.value;
  if (element && activeSeekTarget !== undefined && element.currentTime + 3 < activeSeekTarget) {
    element.currentTime = clampWebSeekPosition(element, activeSeekTarget);
    if (seekResumeRequested) void element.play().catch(() => undefined);
    armSeekRecovery();
    return;
  }
  if (seekRecoveryTimer) clearTimeout(seekRecoveryTimer);
  seekRecoveryTimer = undefined;
  activeSeekTarget = undefined;
  seekResumeRequested = false;
  seekRecoveryAttempts = 0;
  clearStartupWatchdog();
  clearFallbackTimer();
  fallbackTriggered = false;
  status.value = "playing";
  errorMessage.value = "";
  scheduleControlsHide();
}

function onPaused() {
  if (activeSeekTarget !== undefined && seekResumeRequested) {
    status.value = "buffering";
    controlsVisible.value = true;
    clearControlsTimer();
    window.setTimeout(() => {
      const element = video.value;
      if (!disposed && element && activeSeekTarget !== undefined && seekResumeRequested && element.paused) {
        void element.play().catch(() => undefined);
      }
    }, 120);
    return;
  }
  status.value = "paused";
  controlsVisible.value = true;
  clearControlsTimer();
  emit("progress", snapshot());
}

function onEnded() {
  if (activeSeekTarget !== undefined) {
    armSeekRecovery();
    return;
  }
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

function requestTimeshift(offsetSeconds: number) {
  if (isRealtimeLive.value && props.session.timeshiftAvailable) emit("timeshift", Math.max(60, Math.floor(offsetSeconds)));
}

function requestGoLive() {
  if (isReplay.value) emit("goLive");
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

function togglePlayback() {
  const element = video.value;
  if (!element) return;
  if (element.paused) void element.play();
  else element.pause();
}

function syncVolumeState() {
  const element = video.value;
  if (!element) return;
  volume.value = Math.max(0, Math.min(1, element.volume));
  muted.value = element.muted;
}

function changeVolume() {
  const element = video.value;
  if (!element) return;
  element.volume = Math.max(0, Math.min(1, Number(volume.value) || 0));
  if (element.volume > 0) element.muted = false;
  syncVolumeState();
}

function toggleMute() {
  const element = video.value;
  if (!element) return;
  element.muted = !element.muted;
  syncVolumeState();
}

function requestLiveGuide() {
  if (isLive.value) emit("openLiveGuide", snapshot());
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
  if (miniModeActive.value) void window.tvApi.setWindowMiniMode?.(false).catch(() => undefined);
  if (alwaysOnTopActive.value) void window.tvApi.setWindowAlwaysOnTop?.(false).catch(() => undefined);
  emit("close", snapshot());
}

function useFallback() {
  if (fallbackTriggered) return;
  clearFallbackTimer();
  fallbackTriggered = true;
  emit("fallback", snapshot());
}

async function toggleFullscreen() {
  const element = root.value;
  if (!element) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await element.requestFullscreen();
  await nextTick();
  element.focus({ preventScroll: true });
}

function handleKeydown(event: KeyboardEvent) {
  const element = video.value;
  if (!element) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
    if (event.key === "Escape") target.blur();
    else return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
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
    if (isRealtimeLive.value) requestTimeshift(5 * 60);
    else queueKeyboardSeek(-10);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    if (!isRealtimeLive.value) queueKeyboardSeek(10);
  } else if (event.key.toLowerCase() === "l" && isReplay.value) {
    event.preventDefault();
    requestGoLive();
  } else if (event.key.toLowerCase() === "m") {
    event.preventDefault();
    toggleMute();
  } else if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    void toggleFullscreen();
  } else if (event.key.toLowerCase() === "t") {
    event.preventDefault();
    void toggleAlwaysOnTop();
  } else if (event.key.toLowerCase() === "p") {
    event.preventDefault();
    void togglePictureInPicture();
  } else if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    const order: Array<"auto" | "16:9" | "4:3" | "stretch"> = ["auto", "16:9", "4:3", "stretch"];
    const nextIdx = (order.indexOf(aspectRatio.value) + 1) % order.length;
    changeAspectRatio(order[nextIdx]);
  } else if (event.key.toLowerCase() === "a") {
    event.preventDefault();
    cycleAudioTrack();
  } else if (event.key === "[") {
    event.preventDefault();
    adjustSubtitleDelay(-0.5);
  } else if (event.key === "]") {
    event.preventDefault();
    adjustSubtitleDelay(0.5);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    element.volume = Math.min(1, element.volume + 0.05);
    element.muted = false;
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
watch(() => props.subtitleSettings?.delaySeconds, (delay) => {
  if (typeof delay === "number") {
    runtimeSubtitleDelay.value = delay;
    applySubtitlePreferences(delay);
  }
});

onMounted(() => {
  document.addEventListener("keydown", handleKeydown, true);
  void window.tvApi.getWindowAlwaysOnTop?.().then((val: boolean) => {
    alwaysOnTopActive.value = Boolean(val);
  });
  void window.tvApi.getWindowMiniMode?.().then((val: boolean) => {
    miniModeActive.value = Boolean(val);
  });
  updateLiveClock();
  liveClockTimer = setInterval(updateLiveClock, 1000);
  void loadMedia();
});

onBeforeUnmount(() => {
  if (liveClockTimer) clearInterval(liveClockTimer);
  if (miniModeActive.value) void window.tvApi.setWindowMiniMode?.(false).catch(() => undefined);
  if (alwaysOnTopActive.value) void window.tvApi.setWindowAlwaysOnTop?.(false).catch(() => undefined);
  if (playerToastTimer) clearTimeout(playerToastTimer);
  disposed = true;
  loadGeneration += 1;
  clearControlsTimer();
  clearFallbackTimer();
  clearStartupWatchdog();
  clearSeekRecovery();
  disposeHls();
  document.removeEventListener("keydown", handleKeydown, true);
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
    :class="{ 'controls-hidden': !controlsVisible && !episodeDrawerOpen, 'is-mini-mode': miniModeActive }"
    :style="subtitleCssVariables"
    aria-label="内置播放器"
    tabindex="-1"
    @mousemove="showControls"
    @mouseleave="scheduleControlsHide"
  >
    <header class="embedded-player-header">
      <div class="mac-window-controls-safe-area" aria-hidden="true"></div>
      <button class="player-header-button player-back-button" :title="isLive ? '停止播放并返回直播频道' : '返回详情'" @click="closePlayer">
        <AppIcon name="back" :size="21" />
      </button>
      <div class="player-title">
        <strong>{{ session.title }}</strong>
        <span>{{ isLive ? liveProgrammeText : session.episode }}</span>
      </div>
      <div class="player-header-actions">
        <span class="format-chip">{{ engineLabel }}</span>
        <button class="player-header-button" :title="isLive ? '上一个频道（Page Up）' : '上一集（Page Up）'" :disabled="!hasPrevious" @click="previousEpisode">
          <AppIcon name="rewind" :size="18" />
        </button>
        <button class="player-header-button" :title="isLive ? '下一个频道（Page Down）' : '下一集（Page Down）'" :disabled="!hasNext" @click="nextEpisode">
          <AppIcon name="forward" :size="18" />
        </button>
        <button v-if="!isLive" class="player-header-button text-action" :class="{ active: episodeDrawerOpen }" @click="toggleEpisodeDrawer">
          <AppIcon name="film" :size="17" />选集
        </button>
        <button v-if="!isLive && session.danmakuUrl" class="player-header-button text-action" :class="{ active: danmakuEnabled }" @click="danmakuEnabled = !danmakuEnabled">弹幕</button>
        <label v-if="!isLive" class="speed-control">
          <span>倍速</span>
          <select v-model.number="speed" @change="changeSpeed">
            <option :value="0.75">0.75×</option>
            <option :value="1">1.0×</option>
            <option :value="1.25">1.25×</option>
            <option :value="1.5">1.5×</option>
            <option :value="2">2.0×</option>
          </select>
        </label>
        <label class="speed-control">
          <span>比例</span>
          <select v-model="aspectRatio" @change="() => changeAspectRatio()">
            <option value="auto">默认</option>
            <option value="16:9">16:9</option>
            <option value="4:3">4:3</option>
            <option value="stretch">铺满</option>
          </select>
        </label>
        <button class="player-header-button text-action" title="切换音轨（A）" @click="cycleAudioTrack">音轨</button>
        <button class="player-header-button text-action" :class="{ active: alwaysOnTopActive }" :title="alwaysOnTopActive ? '取消置顶（T）' : '置顶播放（T）'" @click="toggleAlwaysOnTop"><AppIcon name="pin" :size="15" />置顶</button>
        <button class="player-header-button text-action" :class="{ active: miniModeActive }" :title="miniModeActive ? '退出小窗模式' : '小窗模式播放'" @click="toggleMiniMode">小窗</button>
        <button class="player-header-button text-action" @click="useFallback">高兼容播放</button>
        <button class="player-header-button" title="全屏" @click="toggleFullscreen">
          <AppIcon name="grid" :size="19" />
        </button>
        <button class="player-header-button" title="关闭播放器" @click="closePlayer">
          <AppIcon name="close" :size="20" />
        </button>
      </div>
    </header>

    <div v-if="playerToast" class="player-toast" role="status">{{ playerToast }}</div>

    <div class="video-stage">
      <video
        ref="video"
        class="video-element"
        :class="[`aspect-${aspectRatio}`]"
        controls
        autoplay
        playsinline
        crossorigin="anonymous"
        @dblclick.prevent="toggleFullscreen"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @seeking="onSeeking"
        @seeked="onSeeked"
        @loadstart="status = 'loading'"
        @waiting="status = 'buffering'; showControls()"
        @playing="onPlaying"
        @pause="onPaused"
        @volumechange="syncVolumeState"
        @ended="onEnded"
        @error="onPlaybackError"
        @enterpictureinpicture="miniModeActive = true"
        @leavepictureinpicture="miniModeActive = false"
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

      <DanmakuOverlay v-if="!isLive" :danmaku-url="session.danmakuUrl" :current-time="currentTime" :enabled="danmakuEnabled" :visible="status !== 'error'" :settings="danmakuSettings" />

      <div v-if="isLive" class="web-live-controls">
        <span class="web-live-badge"><i></i>{{ liveMode === 'live' ? '直播中' : liveMode === 'catchup' ? '节目回看' : '直播时移' }} · {{ currentLiveClock }}</span>
        <button :title="status === 'paused' ? '继续播放（空格）' : '暂停播放（空格）'" @click="togglePlayback"><AppIcon :name="status === 'paused' ? 'play' : 'pause'" :size="15" />{{ status === 'paused' ? '播放' : '暂停' }}</button>
        <select v-if="isRealtimeLive && liveChannels.length > 1" class="web-live-channel-select" :value="currentLiveChannelId" aria-label="直播频道" @change="selectLiveChannel">
          <option v-for="channel in liveChannels" :key="channel.id" :value="channel.id" :disabled="channel.disabled">{{ channel.name }}</option>
        </select>
        <select v-if="isRealtimeLive && liveLines.length" :value="currentLiveLineId" aria-label="直播线路" @change="selectLiveLine">
          <option v-for="line in liveLines" :key="line.id" :value="line.id" :disabled="line.disabled">{{ line.name }}{{ line.status ? ` · ${line.status}` : '' }}</option>
        </select>
        <button v-if="isRealtimeLive" @click="requestLiveReconnect"><AppIcon name="refresh" :size="15" />刷新直播</button>
        <template v-if="isRealtimeLive && session.timeshiftAvailable">
          <button @click="requestTimeshift(5 * 60)">回看 5 分</button>
          <button @click="requestTimeshift(15 * 60)">回看 15 分</button>
          <button @click="requestTimeshift(30 * 60)">回看 30 分</button>
        </template>
        <button v-if="isLive" @click="requestLiveGuide"><AppIcon name="grid" :size="15" />节目单</button>
        <button title="全屏切换（F）" @click="toggleFullscreen"><AppIcon name="grid" :size="15" />全屏</button>
        <button title="静音切换（M）" @click="toggleMute">{{ muted || volume <= 0 ? '静音' : '音量' }}</button>
        <input class="web-live-volume" type="range" min="0" max="1" step="0.05" v-model.number="volume" :title="`音量 ${Math.round(volume * 100)}%`" @input="changeVolume" />
        <button v-if="isReplay" class="go-live-button" @click="requestGoLive"><i></i>回到直播</button>
      </div>

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
      <span v-if="isRealtimeLive && session.timeshiftAvailable">← 回看 5 分钟</span>
      <span v-else-if="!isRealtimeLive">← → 快退/快进 10 秒</span>
      <span>↑ ↓ 调整音量</span>
      <span>Page Up / Down {{ isLive ? '切换频道' : '切集' }}</span>
      <span v-if="isReplay">L 回到直播</span>
      <span>Esc 返回</span>
      <span v-if="!isRealtimeLive" class="time-indicator">{{ Math.floor(currentTime) }}s / {{ Math.floor(duration) }}s</span>
      <span v-else class="time-indicator live-time-indicator"><i></i>LIVE · {{ currentLiveClock }}</span>
    </footer>

    <div
      class="persistent-mini-progress"
      :class="{ visible: !controlsVisible && !miniModeActive && status !== 'error' }"
      role="progressbar"
      :aria-valuenow="Math.round(currentTime)"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(duration)"
    >
      <div
        class="persistent-mini-progress-fill"
        :class="{ 'is-live': isRealtimeLive }"
        :style="{ width: isRealtimeLive ? '100%' : `${progressPercent}%` }"
      ></div>
    </div>
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
  outline: none;
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
  container-type: size;
}

.video-stage video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.video-stage video.aspect-auto {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.video-stage video.aspect-stretch {
  width: 100%;
  height: 100%;
  object-fit: fill;
}

.video-stage video.aspect-16-9 {
  width: min(100cqw, calc(100cqh * 16 / 9));
  height: min(100cqh, calc(100cqw * 9 / 16));
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: 16 / 9;
  object-fit: fill;
}

.video-stage video.aspect-4-3 {
  width: min(100cqw, calc(100cqh * 4 / 3));
  height: min(100cqh, calc(100cqw * 3 / 4));
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: 4 / 3;
  object-fit: fill;
}

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

.embedded-player.is-mini-mode .embedded-player-header {
  height: 44px;
  padding: 0 10px;
  gap: 8px;
}
.embedded-player.is-mini-mode .player-title span,
.embedded-player.is-mini-mode .format-chip,
.embedded-player.is-mini-mode .speed-control,
.embedded-player.is-mini-mode .player-hint {
  display: none;
}
.embedded-player.is-mini-mode .player-toast {
  top: 48px;
  font-size: 12px;
  padding: 5px 12px;
}

.video-stage video::cue {
  font-size: calc(1em * var(--subtitle-font-scale, 1));
  color: #fff;
  background-color: rgba(0, 0, 0, var(--subtitle-background-opacity, .45));
  text-shadow: 0 2px 5px rgba(0, 0, 0, .9);
}

.web-live-controls {
  position: absolute;
  right: 18px;
  bottom: calc(var(--native-controls-safe-height) + var(--player-hint-gap) + 48px);
  left: 18px;
  z-index: 6;
  display: flex;
  flex-wrap: wrap;
  min-height: 44px;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 12px;
  background: rgba(8,10,14,.82);
  box-shadow: 0 10px 28px rgba(0,0,0,.24);
  backdrop-filter: blur(16px);
  transition: opacity 180ms ease, transform 180ms ease;
}
.web-live-controls button,.web-live-controls select { height: 32px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; color: #fff; background: rgba(255,255,255,.07); padding: 0 10px; }
.web-live-controls button { display: inline-flex; align-items: center; gap: 6px; }
.web-live-controls select { min-width: 126px; max-width: 210px; }
.web-live-volume { width: 92px; accent-color: #0a84ff; }
.web-live-badge { display: inline-flex; align-items: center; gap: 7px; padding: 0 5px; color: #79dfa0; font-size: 12px; font-weight: 700; letter-spacing: .08em; white-space: nowrap; }
.web-live-badge i,.go-live-button i,.live-time-indicator i { width: 7px; height: 7px; border-radius: 50%; background: #ff5252; box-shadow: 0 0 0 3px rgba(255,82,82,.15); }
.go-live-button { margin-left: auto; }
.live-time-indicator { display: inline-flex; align-items: center; justify-content: flex-end; gap: 7px; color: #79dfa0; font-weight: 700; letter-spacing: .08em; }

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

.controls-hidden .player-hint,
.controls-hidden .web-live-controls {
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
  .web-live-controls { align-content: center; }
  .web-live-controls button,.web-live-controls select,.web-live-volume { flex: 0 0 auto; }
}

@keyframes player-spin {
  to { transform: rotate(360deg); }
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
</style>
