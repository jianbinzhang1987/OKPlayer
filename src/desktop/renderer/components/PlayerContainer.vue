<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import NativePlayerHost from "./NativePlayerHost.vue";
import type {
  CompatibilityPlaybackFailure,
  EmbeddedPlaybackSession,
  PlaybackProgress,
  PlayerEpisode,
  PlayerLiveChannel,
  PlayerLiveLine,
  WebPlayerEngine,
} from "../player/player-types.ts";
import type { CompatibilityFallbackMode } from "../player/playback-error-policy.ts";
import type { DanmakuPresentationSettings, SubtitlePresentationSettings } from "../player/presentation-settings.ts";

const props = withDefaults(defineProps<{
  engine?: WebPlayerEngine;
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
  engine: "legacy",
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
});

const emit = defineEmits<{
  close: [progress: PlaybackProgress];
  fallback: [progress: PlaybackProgress];
  reprepare: [progress: PlaybackProgress];
  progress: [progress: PlaybackProgress];
  previous: [progress: PlaybackProgress];
  next: [progress: PlaybackProgress];
  ended: [progress: PlaybackProgress];
  compatibilityFailure: [payload: CompatibilityPlaybackFailure];
  ready: [startupMs: number];
  buffering: [payload: { durationMs: number; cachePercent: number }];
  selectEpisode: [payload: { episodeUrl: string; progress: PlaybackProgress }];
  engineFallback: [reason: string];
  timeshift: [offsetSeconds: number];
  goLive: [];
  selectLiveLine: [lineId: string];
  selectLiveChannel: [channelId: string];
  reconnectLive: [];
  openLiveGuide: [progress: PlaybackProgress];
}>();

const activeEngine = ref<WebPlayerEngine>(props.engine);
const usesNativeEngine = computed(() => props.session.engine === "mpv");
// Live playback uses the stable Web shell because it owns the dedicated
// channel, line, timeshift and live-edge controls. ArtPlayer remains a VOD option.
const effectiveWebEngine = computed<WebPlayerEngine>(() => props.session.contentKind === "live" ? "legacy" : activeEngine.value);
const ArtPlayerHost = defineAsyncComponent(async () => {
  try {
    return (await import("./ArtPlayerHost.vue")).default;
  } catch (error) {
    handleArtPlayerFailure(`ArtPlayer 组件加载失败：${error instanceof Error ? error.message : String(error)}`);
    return EmbeddedPlayer;
  }
});

watch(() => props.engine, (engine) => {
  activeEngine.value = engine;
});

function handleArtPlayerFailure(reason: string) {
  activeEngine.value = "legacy";
  emit("engineFallback", reason);
}
</script>

<template>
  <div class="player-container" :data-player-engine="usesNativeEngine ? 'native' : effectiveWebEngine">
    <NativePlayerHost
      v-if="usesNativeEngine"
      :session="props.session"
      :default-speed="props.defaultSpeed"
      :compatibility-fallback-mode="props.compatibilityFallbackMode"
      :episodes="props.episodes"
      :current-episode-url="props.currentEpisodeUrl"
      :has-previous="props.hasPrevious"
      :has-next="props.hasNext"
      :live-lines="props.liveLines"
      :current-live-line-id="props.currentLiveLineId"
      :live-channels="props.liveChannels"
      :current-live-channel-id="props.currentLiveChannelId"
      :danmaku-settings="props.danmakuSettings"
      :subtitle-settings="props.subtitleSettings"
      @progress="emit('progress', $event)"
      @previous="emit('previous', $event)"
      @next="emit('next', $event)"
      @ended="emit('ended', $event)"
      @failure="emit('compatibilityFailure', $event)"
      @ready="emit('ready', $event)"
      @buffering="emit('buffering', $event)"
      @select-episode="emit('selectEpisode', $event)"
      @timeshift="emit('timeshift', $event)"
      @go-live="emit('goLive')"
      @select-live-line="emit('selectLiveLine', $event)"
      @select-live-channel="emit('selectLiveChannel', $event)"
      @reconnect-live="emit('reconnectLive')"
      @open-live-guide="emit('openLiveGuide', $event)"
      @close="emit('close', $event)"
    />
    <ArtPlayerHost
      v-else-if="effectiveWebEngine === 'artplayer'"
      :session="props.session"
      :default-speed="props.defaultSpeed"
      :compatibility-fallback-mode="props.compatibilityFallbackMode"
      :episodes="props.episodes"
      :current-episode-url="props.currentEpisodeUrl"
      :has-previous="props.hasPrevious"
      :has-next="props.hasNext"
      :danmaku-settings="props.danmakuSettings"
      :subtitle-settings="props.subtitleSettings"
      @progress="emit('progress', $event)"
      @previous="emit('previous', $event)"
      @next="emit('next', $event)"
      @ended="emit('ended', $event)"
      @select-episode="emit('selectEpisode', $event)"
      @close="emit('close', $event)"
      @fallback="emit('fallback', $event)"
      @engine-failure="handleArtPlayerFailure"
    />
    <EmbeddedPlayer
      v-else
      :session="props.session"
      :default-speed="props.defaultSpeed"
      :compatibility-fallback-mode="props.compatibilityFallbackMode"
      :episodes="props.episodes"
      :current-episode-url="props.currentEpisodeUrl"
      :has-previous="props.hasPrevious"
      :has-next="props.hasNext"
      :live-lines="props.liveLines"
      :current-live-line-id="props.currentLiveLineId"
      :live-channels="props.liveChannels"
      :current-live-channel-id="props.currentLiveChannelId"
      :danmaku-settings="props.danmakuSettings"
      :subtitle-settings="props.subtitleSettings"
      @progress="emit('progress', $event)"
      @previous="emit('previous', $event)"
      @next="emit('next', $event)"
      @ended="emit('ended', $event)"
      @select-episode="emit('selectEpisode', $event)"
      @timeshift="emit('timeshift', $event)"
      @go-live="emit('goLive')"
      @select-live-line="emit('selectLiveLine', $event)"
      @select-live-channel="emit('selectLiveChannel', $event)"
      @reconnect-live="emit('reconnectLive')"
      @open-live-guide="emit('openLiveGuide', $event)"
      @close="emit('close', $event)"
      @fallback="emit('fallback', $event)"
      @reprepare="emit('reprepare', $event)"
    />
  </div>
</template>

<style scoped>
.player-container {
  position: fixed;
  inset: 0;
  z-index: 200;
  transition: inset 0.25s cubic-bezier(0.16, 1, 0.3, 1), width 0.25s cubic-bezier(0.16, 1, 0.3, 1), height 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.player-container:has(.is-mini-mode),
.player-container.is-mini-mode {
  inset: auto 24px 24px auto;
  width: 480px;
  height: 270px;
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
</style>
