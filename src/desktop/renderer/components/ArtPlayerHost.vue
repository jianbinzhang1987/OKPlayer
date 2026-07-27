<script setup lang="ts">
import Artplayer from "artplayer";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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

const emit = defineEmits<{
  close: [progress: PlaybackProgress];
  fallback: [progress: PlaybackProgress];
  progress: [progress: PlaybackProgress];
  previous: [progress: PlaybackProgress];
  next: [progress: PlaybackProgress];
  ended: [progress: PlaybackProgress];
  selectEpisode: [payload: { episodeUrl: string; progress: PlaybackProgress }];
  engineFailure: [reason: string];
}>();

const root = ref<HTMLElement>();
const container = ref<HTMLDivElement>();
const episodeDrawerOpen = ref(false);
const controlsVisible = ref(true);
const errorMessage = ref("");
const status = ref<"loading" | "playing" | "paused" | "buffering" | "ended" | "error">("loading");
const currentTime = ref(0);
const danmakuEnabled = ref(true);
let art: Artplayer | undefined;
let hls: HlsInstance | undefined;
let disposed = false;
let fallbackTriggered = false;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let lastSavedAt = 0;
let restoredPosition = false;
let generation = 0;
let networkRecoveries = 0;
let mediaRecoveries = 0;

Artplayer.PLAYBACK_RATE = [0.75, 1, 1.25, 1.5, 2];

function snapshot(): PlaybackProgress {
  const position = Number.isFinite(art?.currentTime) ? Math.max(0, art?.currentTime ?? 0) : 0;
  const duration = Number.isFinite(art?.duration) ? Math.max(0, art?.duration ?? 0) : 0;
  return {
    position,
    duration,
    completed: duration > 0 && (position / duration >= 0.95 || duration - position <= 90),
  };
}

function clearFallbackTimer() {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = undefined;
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
  scheduleAutomaticFallback();
}

function disposeHls() {
  hls?.destroy();
  hls = undefined;
  networkRecoveries = 0;
  mediaRecoveries = 0;
}

async function attachHls(video: HTMLVideoElement, url: string, player: Artplayer, currentGeneration: number) {
  disposeHls();
  if (supportsNativeHls(video)) {
    video.src = url;
    return;
  }
  const Hls = await loadHlsConstructor();
  if (disposed || currentGeneration !== generation) return;
  if (!Hls.isSupported()) throw new Error("当前环境不支持 HLS.js/MSE");

  const instance = new Hls({
    enableWorker: true,
    lowLatencyMode: props.session.contentKind === "live",
    backBufferLength: 90,
    maxBufferLength: props.session.contentKind === "live" ? 20 : 45,
  });
  hls = instance;
  player.hls = instance;
  instance.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal || disposed || currentGeneration !== generation) return;
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
    showPlaybackError(`ArtPlayer HLS 播放失败${data.details ? `：${data.details}` : ""}，可使用高兼容播放器继续播放。`);
  });
  instance.loadSource(url);
  instance.attachMedia(video);
}

function restorePosition(player: Artplayer | undefined = art) {
  if (!player || player !== art || restoredPosition) return;
  const startPosition = Math.max(0, props.session.startPosition ?? 0);
  const total = Number.isFinite(player.duration) ? player.duration : 0;
  if (startPosition > 0 && (!total || startPosition < total - 5)) player.currentTime = startPosition;
  player.playbackRate = Number(props.defaultSpeed) || 1;
  restoredPosition = true;
}

function bindEvents(player: Artplayer) {
  const active = () => !disposed && player === art;
  player.on("ready", () => {
    if (!active()) return;
    restorePosition(player);
    status.value = player.playing ? "playing" : "paused";
    errorMessage.value = "";
  });
  player.on("control", (visible) => {
    if (!active()) return;
    controlsVisible.value = visible || episodeDrawerOpen.value || Boolean(errorMessage.value);
  });
  player.on("video:loadedmetadata", () => {
    if (active()) restorePosition(player);
  });
  player.on("video:timeupdate", () => {
    if (!active()) return;
    currentTime.value = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : currentTime.value;
    if (Date.now() - lastSavedAt < 15_000) return;
    lastSavedAt = Date.now();
    emit("progress", snapshot());
  });
  player.on("video:waiting", () => {
    if (active()) status.value = "buffering";
  });
  player.on("video:playing", () => {
    if (!active()) return;
    clearFallbackTimer();
    fallbackTriggered = false;
    status.value = "playing";
    errorMessage.value = "";
  });
  player.on("video:pause", () => {
    if (!active()) return;
    if (status.value !== "ended") status.value = "paused";
    emit("progress", snapshot());
  });
  player.on("video:ended", () => {
    if (!active()) return;
    status.value = "ended";
    const progress = snapshot();
    emit("progress", progress);
    emit("ended", progress);
  });
  player.on("video:error", (error) => {
    if (!active()) return;
    showPlaybackError(`ArtPlayer 媒体加载失败：${error.message || "未知错误"}。可使用高兼容播放器继续播放。`);
  });
}

async function createPlayer() {
  await nextTick();
  if (!container.value || disposed) return;
  const currentGeneration = ++generation;
  destroyPlayer();
  restoredPosition = false;
  fallbackTriggered = false;
  errorMessage.value = "";
  status.value = "loading";
  currentTime.value = Math.max(0, props.session.startPosition ?? 0);
  controlsVisible.value = true;

  try {
    const isHls = props.session.format.toLowerCase() === "hls";
    const subtitleSettings = normalizeSubtitleSettings(props.subtitleSettings);
    const player = new Artplayer({
      container: container.value,
      url: props.session.playbackUrl,
      ...(isHls ? { type: "hls" as const } : {}),
      lang: "zh-cn",
      autoplay: true,
      mutex: true,
      hotkey: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: false,
      fullscreenWeb: false,
      pip: true,
      miniProgressBar: true,
      playsInline: true,
      isLive: props.session.contentKind === "live",
      theme: "#0a84ff",
      moreVideoAttr: {
        preload: "auto",
        crossOrigin: "anonymous",
      },
      ...(props.session.subtitleUrl ? {
        subtitle: {
          url: props.session.subtitleUrl,
          name: "中文字幕",
          type: "vtt",
          encoding: "utf-8",
          offset: subtitleSettings.delaySeconds,
          style: {
            color: "#fff",
            fontSize: `${Math.round(20 * subtitleSettings.fontScale)}px`,
            backgroundColor: `rgba(0,0,0,${subtitleSettings.backgroundOpacity})`,
            textShadow: "0 2px 5px rgba(0,0,0,.85)",
          },
        },
      } : {}),
      ...(isHls ? {
        customType: {
          hls: (video, url, instance) => attachHls(video, url, instance, currentGeneration),
        },
      } : {}),
    });
    if (disposed || currentGeneration !== generation) {
      player.destroy(false);
      return;
    }
    art = player;
    bindEvents(player);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit("engineFailure", `ArtPlayer 初始化失败：${reason}`);
  }
}

function destroyPlayer() {
  clearFallbackTimer();
  disposeHls();
  const player = art;
  art = undefined;
  player?.destroy(false);
}

function retry() {
  clearFallbackTimer();
  fallbackTriggered = false;
  void createPlayer();
}

function useFallback() {
  if (fallbackTriggered) return;
  clearFallbackTimer();
  fallbackTriggered = true;
  emit("fallback", snapshot());
}

function closePlayer() {
  emit("close", snapshot());
}

function previousEpisode() {
  if (props.hasPrevious) emit("previous", snapshot());
}

function nextEpisode() {
  if (props.hasNext) emit("next", snapshot());
}

function toggleEpisodeDrawer() {
  episodeDrawerOpen.value = !episodeDrawerOpen.value;
  controlsVisible.value = true;
}

function selectEpisode(episodeUrl: string) {
  if (!episodeUrl || episodeUrl === props.currentEpisodeUrl) return;
  episodeDrawerOpen.value = false;
  emit("selectEpisode", { episodeUrl, progress: snapshot() });
}

async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await root.value?.requestFullscreen();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && episodeDrawerOpen.value) {
    event.preventDefault();
    episodeDrawerOpen.value = false;
    return;
  }
  if (event.key === "Escape" && art && !document.fullscreenElement) {
    event.preventDefault();
    closePlayer();
  } else if (event.key === "PageUp") {
    event.preventDefault();
    previousEpisode();
  } else if (event.key === "PageDown") {
    event.preventDefault();
    nextEpisode();
  }
}

watch(() => [props.session.playbackUrl, props.session.format, props.session.subtitleUrl], () => void createPlayer());
watch(() => props.session.danmakuUrl, () => { danmakuEnabled.value = true; });
watch(() => props.defaultSpeed, (value) => {
  if (art && Number.isFinite(Number(value))) art.playbackRate = Number(value);
});

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  void createPlayer();
});

onBeforeUnmount(() => {
  disposed = true;
  generation += 1;
  window.removeEventListener("keydown", handleKeydown);
  destroyPlayer();
});
</script>

<template>
  <section ref="root" class="art-player-host" :class="{ 'controls-hidden': !controlsVisible && !episodeDrawerOpen }" aria-label="ArtPlayer 内置播放器">
    <div ref="container" class="art-player-surface"></div>
    <DanmakuOverlay :danmaku-url="session.danmakuUrl" :current-time="currentTime" :enabled="danmakuEnabled" :visible="status !== 'error'" :settings="danmakuSettings" />

    <header class="art-player-header">
      <div class="mac-window-controls-safe-area" aria-hidden="true"></div>
      <button class="player-header-button" title="返回详情" @click="closePlayer"><AppIcon name="back" :size="21" /></button>
      <div class="player-title"><strong>{{ session.title }}</strong><span>{{ session.episode }}</span></div>
      <div class="player-header-actions">
        <span class="format-chip">ART · {{ session.format.toUpperCase() }}</span>
        <button class="player-header-button" title="上一集（Page Up）" :disabled="!hasPrevious" @click="previousEpisode"><AppIcon name="rewind" :size="18" /></button>
        <button class="player-header-button" title="下一集（Page Down）" :disabled="!hasNext" @click="nextEpisode"><AppIcon name="forward" :size="18" /></button>
        <button class="player-header-button text-action" :class="{ active: episodeDrawerOpen }" @click="toggleEpisodeDrawer"><AppIcon name="film" :size="17" />选集</button>
        <button v-if="session.danmakuUrl" class="player-header-button text-action" :class="{ active: danmakuEnabled }" @click="danmakuEnabled = !danmakuEnabled">弹幕</button>
        <button class="player-header-button text-action" @click="useFallback">高兼容播放</button>
        <button class="player-header-button" title="全屏" @click="toggleFullscreen"><AppIcon name="grid" :size="19" /></button>
        <button class="player-header-button" title="关闭播放器" @click="closePlayer"><AppIcon name="close" :size="20" /></button>
      </div>
    </header>

    <div v-if="status === 'error'" class="player-error-card">
      <div class="player-error-icon"><AppIcon name="info" :size="26" /></div>
      <h2>ArtPlayer 播放失败</h2>
      <p>{{ errorMessage }}</p>
      <small v-if="compatibilityFallbackMode === 'automatic'">短暂等待后将自动切换高兼容播放器。</small>
      <small v-else>已关闭自动切换，可重新加载或手动使用高兼容播放器。</small>
      <div><button class="retry-button" @click="retry"><AppIcon name="refresh" :size="16" />重新加载</button><button class="fallback-button" @click="useFallback"><AppIcon name="play" :size="16" />立即切换高兼容播放器</button></div>
    </div>

    <button v-if="episodeDrawerOpen" class="episode-drawer-backdrop" aria-label="关闭选集" @click="toggleEpisodeDrawer"></button>
    <aside v-if="episodeDrawerOpen" class="episode-drawer" aria-label="选集列表">
      <div class="episode-drawer-heading"><div><small>EPISODES</small><strong>选择剧集</strong></div><button class="player-header-button" title="关闭选集" @click="toggleEpisodeDrawer"><AppIcon name="close" :size="18" /></button></div>
      <div class="episode-drawer-list">
        <button v-for="(episode, index) in episodes" :key="episode.url" :class="{ active: episode.url === currentEpisodeUrl }" @click="selectEpisode(episode.url)">
          <span>{{ String(index + 1).padStart(2, '0') }}</span><strong>{{ episode.name }}</strong><em v-if="episode.url === currentEpisodeUrl">正在播放</em>
        </button>
      </div>
    </aside>
  </section>
</template>

<style scoped>
.art-player-host { position: fixed; inset: 0; z-index: 200; overflow: hidden; color: #f5f5f7; background: #000; }
.art-player-surface { position: absolute; inset: 0; }
.art-player-header { --mac-window-controls-safe-width: 96px; position: absolute; inset: 0 0 auto; z-index: 12; display: flex; height: 64px; align-items: center; gap: 14px; padding: 0 18px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(180deg,rgba(8,10,14,.96),rgba(8,10,14,.68)); backdrop-filter: blur(18px); transition: opacity 180ms ease,transform 180ms ease; -webkit-app-region: drag; }
.mac-window-controls-safe-area { display: none; width: 0; height: 100%; flex: 0 0 0; pointer-events: none; }
:global(html[data-platform="darwin"]) .mac-window-controls-safe-area { display: block; width: var(--mac-window-controls-safe-width); flex-basis: var(--mac-window-controls-safe-width); }
.art-player-host:fullscreen .mac-window-controls-safe-area { display: none; }
.player-header-button { display: grid; min-width: 38px; height: 38px; padding: 0 10px; place-items: center; border: 1px solid rgba(255,255,255,.1); border-radius: 10px; color: rgba(245,245,247,.78); background: rgba(255,255,255,.055); -webkit-app-region: no-drag; }
.player-header-button:hover { color: #fff; background: rgba(255,255,255,.11); }
.player-header-button:disabled { opacity: .32; }
.player-header-button.active { border-color: rgba(10,132,255,.42); color: #82bdff; background: rgba(10,132,255,.16); }
.text-action { width: auto; display: flex; gap: 6px; white-space: nowrap; font-size: 12px; }
.player-title { display: grid; min-width: 0; flex: 1; gap: 2px; }
.player-title strong,.player-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.player-title strong { font-size: 14px; font-weight: 650; }
.player-title span { color: rgba(245,245,247,.62); font-size: 11px; }
.player-header-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.format-chip { padding: 5px 8px; border: 1px solid rgba(10,132,255,.25); border-radius: 7px; color: #72b5ff; font-size: 11px; font-weight: 700; background: rgba(10,132,255,.1); }
.controls-hidden .art-player-header { pointer-events: none; opacity: 0; transform: translateY(-12px); }
.player-error-card { position: absolute; z-index: 14; inset: 50% auto auto 50%; display: grid; width: min(440px,calc(100% - 40px)); justify-items: center; padding: 30px; border: 1px solid rgba(255,255,255,.12); border-radius: 20px; text-align: center; background: rgba(21,23,29,.95); box-shadow: 0 22px 60px rgba(0,0,0,.42); transform: translate(-50%,-50%); backdrop-filter: blur(24px); }
.player-error-icon { display: grid; width: 48px; height: 48px; place-items: center; border-radius: 14px; color: #ffb340; background: rgba(255,159,10,.12); }
.player-error-card h2 { margin: 16px 0 7px; }
.player-error-card p { margin: 0; color: rgba(245,245,247,.72); line-height: 1.7; }
.player-error-card small { margin-top: 10px; color: rgba(245,245,247,.48); }
.player-error-card > div:last-child { display: flex; gap: 10px; margin-top: 22px; }
.retry-button,.fallback-button { display: flex; align-items: center; gap: 7px; height: 38px; padding: 0 15px; border: 1px solid rgba(255,255,255,.12); border-radius: 10px; color: #fff; }
.retry-button { background: rgba(255,255,255,.08); }
.fallback-button { border-color: rgba(10,132,255,.42); background: #087be8; }
.episode-drawer-backdrop { position: absolute; inset: 0; z-index: 15; border: 0; background: rgba(0,0,0,.34); backdrop-filter: blur(2px); }
.episode-drawer { position: absolute; inset: 0 0 0 auto; z-index: 16; display: grid; width: min(380px,38vw); grid-template-rows: auto minmax(0,1fr); border-left: 1px solid rgba(255,255,255,.1); background: rgba(15,17,22,.96); box-shadow: -24px 0 60px rgba(0,0,0,.42); backdrop-filter: blur(24px); }
.episode-drawer-heading { display: flex; min-height: 72px; align-items: center; justify-content: space-between; gap: 16px; padding: 0 18px 0 22px; border-bottom: 1px solid rgba(255,255,255,.08); }
.episode-drawer-heading > div { display: grid; gap: 3px; }
.episode-drawer-heading small { color: rgba(245,245,247,.42); font-size: 11px; font-weight: 700; letter-spacing: .12em; }
.episode-drawer-list { display: grid; align-content: start; gap: 8px; padding: 14px; overflow: auto; }
.episode-drawer-list button { display: grid; min-height: 52px; grid-template-columns: 34px minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid transparent; border-radius: 12px; color: rgba(245,245,247,.78); text-align: left; background: rgba(255,255,255,.045); }
.episode-drawer-list button.active { border-color: rgba(10,132,255,.38); color: #fff; background: rgba(10,132,255,.16); }
.episode-drawer-list button strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.episode-drawer-list button em { color: #82bdff; font-size: 11px; font-style: normal; }
@media (max-width: 900px) { .format-chip { display: none; } .episode-drawer { width: min(360px,72vw); } }
</style>
