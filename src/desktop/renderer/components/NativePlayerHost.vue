<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import type { CompatibilityFallbackMode } from "../player/playback-error-policy.ts";
import type {
  CompatibilityPlaybackFailure,
  EmbeddedPlaybackSession,
  PlaybackProgress,
  PlayerEpisode,
} from "../player/player-types.ts";

const props = withDefaults(defineProps<{
  session: EmbeddedPlaybackSession;
  defaultSpeed?: number;
  compatibilityFallbackMode?: CompatibilityFallbackMode;
  episodes?: PlayerEpisode[];
  currentEpisodeUrl?: string;
  hasPrevious?: boolean;
  hasNext?: boolean;
}>(), {
  defaultSpeed: 1,
  compatibilityFallbackMode: "automatic",
  episodes: () => [],
  currentEpisodeUrl: "",
  hasPrevious: false,
  hasNext: false,
});

const emit = defineEmits<{
  close: [progress: PlaybackProgress];
  progress: [progress: PlaybackProgress];
  previous: [progress: PlaybackProgress];
  next: [progress: PlaybackProgress];
  ended: [progress: PlaybackProgress];
  failure: [payload: CompatibilityPlaybackFailure];
  selectEpisode: [payload: { episodeUrl: string; progress: PlaybackProgress }];
}>();

declare global {
  interface Window {
    tvApi: any;
  }
}

const status = ref<"loading" | "playing" | "paused" | "ended" | "error">("loading");
const errorMessage = ref("");
const position = ref(0);
const duration = ref(0);
const speed = ref(Number(props.defaultSpeed) || 1);
const volume = ref(100);
const muted = ref(false);
const episodeDrawerOpen = ref(false);
const nativeSurface = ref<HTMLElement | null>(null);
const nativeSurfaceAttached = ref(false);
let removePlayerState: (() => void) | undefined;
let nativeSurfaceObserver: ResizeObserver | undefined;
let started = false;
let disposed = false;
let lastProgressAt = 0;
let stopRequested = false;
let playbackConfirmed = false;
let failureReported = false;
let startupWatchdog: ReturnType<typeof setTimeout> | undefined;

const STARTUP_TIMEOUT_MS = 15_000;

const progressPercent = computed(() => duration.value > 0 ? Math.min(100, Math.max(0, (position.value / duration.value) * 100)) : 0);
const statusText = computed(() => {
  if (status.value === "loading") return "正在启动高兼容播放内核…";
  if (status.value === "paused") return "已暂停";
  if (status.value === "ended") return "播放完成";
  if (status.value === "error") return errorMessage.value || "高兼容播放失败";
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
    reportCompatibilityFailure("高兼容播放内核在 15 秒内未读取到有效媒体数据，正在尝试备用线路。");
  }, STARTUP_TIMEOUT_MS);
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

async function startNativePlayback() {
  clearStartupWatchdog();
  stopRequested = false;
  status.value = "loading";
  errorMessage.value = "";
  started = false;
  playbackConfirmed = false;
  failureReported = false;
  position.value = Math.max(0, props.session.startPosition ?? 0);
  duration.value = 0;
  try {
    const playbackResult = await window.tvApi.fallbackPlayback(props.session.sessionId) as { backend?: string };
    if (playbackResult?.backend && playbackResult.backend !== "native-libmpv") {
      throw new Error("高兼容播放后端未进入应用内 libmpv 模式");
    }
    await attachNativeSurface();
    await window.tvApi.setSpeed?.(speed.value);
    if (position.value > 0) await window.tvApi.seek(position.value);
    armStartupWatchdog();
  } catch (error) {
    reportCompatibilityFailure(friendlyPlaybackError(error));
  }
}

async function stopNativePlayback() {
  stopRequested = true;
  clearStartupWatchdog();
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
  position.value = Math.max(0, nextPosition);
  await window.tvApi.seek?.(position.value);
  emit("progress", snapshot());
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

async function closePlayer() {
  const progress = snapshot();
  emit("progress", progress);
  await detachNativeSurface();
  await stopNativePlayback();
  emit("close", progress);
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
  const opening = !episodeDrawerOpen.value;
  episodeDrawerOpen.value = opening;
  // A native child view sits above renderer DOM. Hide it while the drawer is
  // open so every episode remains clickable instead of being covered by video.
  if (opening) {
    await detachNativeSurface();
  } else if (!stopRequested && status.value !== "error") {
    await attachNativeSurface().catch((error) => {
      errorMessage.value = friendlyPlaybackError(error);
    });
  }
}

function handlePlayerState(state: { position?: number; duration?: number; paused?: boolean; stopped?: boolean; volume?: number; muted?: boolean }) {
  if (disposed || stopRequested) return;
  if (Number.isFinite(state.position)) position.value = Math.max(0, Number(state.position));
  if (Number.isFinite(state.duration)) duration.value = Math.max(0, Number(state.duration));
  if (Number.isFinite(state.volume)) volume.value = Math.max(0, Math.min(100, Number(state.volume)));
  if (typeof state.muted === "boolean") muted.value = state.muted;
  if (state.stopped === true) {
    if (!started) return;
    if (!playbackConfirmed && position.value <= 0 && duration.value <= 0) {
      reportCompatibilityFailure("高兼容播放内核未能打开当前媒体，正在尝试备用线路。");
      return;
    }
    clearStartupWatchdog();
    status.value = "ended";
    const progress = snapshot();
    emit("progress", progress);
    emit("ended", progress);
    return;
  }

  started = true;
  if (!playbackConfirmed && (position.value > 0 || duration.value > 0)) {
    playbackConfirmed = true;
    clearStartupWatchdog();
  }
  status.value = playbackConfirmed ? (state.paused ? "paused" : "playing") : "loading";
  if (playbackConfirmed && Date.now() - lastProgressAt >= 15_000) {
    lastProgressAt = Date.now();
    emit("progress", snapshot());
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (episodeDrawerOpen.value && event.key === "Escape") {
    event.preventDefault();
    episodeDrawerOpen.value = false;
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
    position.value = Math.max(0, position.value - 10);
    void window.tvApi.seek?.(position.value);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    position.value = duration.value > 0 ? Math.min(duration.value, position.value + 10) : position.value + 10;
    void window.tvApi.seek?.(position.value);
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
watch(() => props.defaultSpeed, (value) => {
  speed.value = Number(value) || 1;
  void changeSpeed();
});

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  removePlayerState = window.tvApi.onPlayerState?.(handlePlayerState);
  if (nativeSurface.value && typeof ResizeObserver !== "undefined") {
    nativeSurfaceObserver = new ResizeObserver(() => void resizeNativeSurface());
    nativeSurfaceObserver.observe(nativeSurface.value);
  }
  void startNativePlayback();
});

onBeforeUnmount(() => {
  disposed = true;
  clearStartupWatchdog();
  window.removeEventListener("keydown", handleKeydown);
  removePlayerState?.();
  nativeSurfaceObserver?.disconnect();
  nativeSurfaceObserver = undefined;
  void detachNativeSurface();
  if (!stopRequested) void stopNativePlayback();
});
</script>

<template>
  <section class="native-player-host" :class="`state-${status}`">
    <header class="native-player-topbar">
      <div class="native-player-title">
        <small>高兼容播放模式</small>
        <strong>{{ session.title }} · {{ session.episode }}</strong>
      </div>
      <em>{{ statusText }}</em>
      <button class="native-control-button native-back-button" title="停止播放并返回影片详情" @click="closePlayer"><AppIcon name="back" :size="16" />返回详情</button>
    </header>

    <main ref="nativeSurface" class="native-player-stage" :class="{ 'native-surface-attached': nativeSurfaceAttached }">
      <div v-if="!nativeSurfaceAttached" class="native-player-card">
        <AppIcon name="play" :size="44" />
        <h2>正在使用高兼容播放内核</h2>
        <p>视频画面由应用内兼容内核承载，播放控制、选集和进度仍由当前页面统一管理。</p>
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
      <button class="native-control-button" :disabled="!hasPrevious" @click="previousEpisode"><AppIcon name="rewind" :size="16" />上一集</button>
      <button class="native-control-button" :disabled="!hasNext" @click="nextEpisode">下一集<AppIcon name="forward" :size="16" /></button>
      <span class="native-time">{{ formatTime(position) }}</span>
      <input class="native-progress" type="range" min="0" :max="Math.max(duration, position, 1)" :value="position" :style="{ '--progress': `${progressPercent}%` }" @input="seekTo" />
      <span class="native-time">{{ formatTime(duration) }}</span>
      <select v-model.number="speed" class="native-speed" @change="changeSpeed"><option :value="0.75">0.75×</option><option :value="1">1.0×</option><option :value="1.25">1.25×</option><option :value="1.5">1.5×</option><option :value="2">2.0×</option></select>
      <button class="native-control-button compact" :disabled="status === 'loading'" @click="toggleMute">{{ muted || volume <= 0 ? '静音' : '音量' }}</button>
      <input class="native-volume" type="range" min="0" max="100" v-model.number="volume" :title="`音量 ${Math.round(volume)}%`" @input="changeVolume" />
      <button class="native-control-button" @click="toggleEpisodeDrawer"><AppIcon name="grid" :size="16" />选集</button>
    </footer>

    <aside v-if="episodeDrawerOpen" class="native-episode-drawer">
      <header><strong>选集</strong><button class="native-icon-button" @click="toggleEpisodeDrawer"><AppIcon name="close" :size="15" /></button></header>
      <button v-for="episode in episodes" :key="episode.url" :class="{ active: episode.url === currentEpisodeUrl }" @click="selectEpisode(episode.url)">{{ episode.name }}</button>
    </aside>
  </section>
</template>

<style scoped>
.native-player-host { position: fixed; inset: 0; display: flex; flex-direction: column; background: #05070b; color: #fff; overflow: hidden; }
.native-player-topbar { height: 68px; display: flex; align-items: center; gap: 14px; padding: 0 20px; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(7,10,16,.92); }
.native-player-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.native-player-topbar small { color: rgba(255,255,255,.52); letter-spacing: .12em; font-size: 11px; }
.native-player-topbar strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.native-player-topbar em { color: rgba(255,255,255,.68); font-style: normal; font-size: 13px; }
.native-player-stage { flex: 1; display: grid; place-items: center; padding: 28px; background: radial-gradient(circle at 50% 30%, rgba(10,132,255,.18), transparent 36%), #05070b; }
.native-player-card { width: min(520px, 90vw); display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; color: rgba(255,255,255,.78); }
.native-player-card h2 { margin: 4px 0 0; color: #fff; }
.native-player-card p { margin: 0; line-height: 1.6; }
.native-player-error { color: #ffb4ab; }
.native-error-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.native-player-controls { height: 78px; display: flex; align-items: center; gap: 10px; padding: 0 18px; border-top: 1px solid rgba(255,255,255,.08); background: rgba(7,10,16,.94); }
.native-icon-button,.native-control-button { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.native-icon-button { width: 36px; height: 36px; }
.native-control-button { height: 38px; padding: 0 12px; }
.native-back-button { flex: 0 0 auto; }
.native-control-button.compact { min-width: 54px; padding: 0 10px; }
.native-control-button:disabled { opacity: .45; }
.native-time { min-width: 48px; color: rgba(255,255,255,.68); font-variant-numeric: tabular-nums; text-align: center; font-size: 12px; }
.native-progress { flex: 1; accent-color: #0a84ff; }
.native-volume { width: 92px; accent-color: #0a84ff; }
.native-speed { height: 38px; border: 1px solid rgba(255,255,255,.12); border-radius: 10px; background: rgba(255,255,255,.08); color: #fff; padding: 0 8px; }
.native-episode-drawer { position: absolute; right: 18px; bottom: 88px; width: min(360px, calc(100vw - 36px)); max-height: min(520px, calc(100vh - 160px)); overflow: auto; border: 1px solid rgba(255,255,255,.12); border-radius: 16px; background: rgba(16,20,28,.96); padding: 12px; box-shadow: 0 18px 60px rgba(0,0,0,.45); }
.native-episode-drawer header { display: flex; align-items: center; justify-content: space-between; padding: 0 0 10px; }
.native-episode-drawer button:not(.native-icon-button) { width: 100%; margin-bottom: 8px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.05); color: rgba(255,255,255,.82); text-align: left; }
.native-episode-drawer button.active { border-color: rgba(10,132,255,.6); background: rgba(10,132,255,.18); color: #fff; }
</style>
