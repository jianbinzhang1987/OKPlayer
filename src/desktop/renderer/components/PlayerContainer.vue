<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import NativePlayerHost from "./NativePlayerHost.vue";
import type {
  EmbeddedPlaybackSession,
  PlaybackProgress,
  PlayerEpisode,
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
});

const emit = defineEmits<{
  close: [progress: PlaybackProgress];
  fallback: [progress: PlaybackProgress];
  progress: [progress: PlaybackProgress];
  previous: [progress: PlaybackProgress];
  next: [progress: PlaybackProgress];
  ended: [progress: PlaybackProgress];
  selectEpisode: [payload: { episodeUrl: string; progress: PlaybackProgress }];
  engineFallback: [reason: string];
}>();

const activeEngine = ref<WebPlayerEngine>(props.engine);
const usesNativeEngine = computed(() => props.session.engine === "mpv");
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
  <div class="player-container" :data-player-engine="usesNativeEngine ? 'native' : activeEngine">
    <NativePlayerHost
      v-if="usesNativeEngine"
      :session="props.session"
      :default-speed="props.defaultSpeed"
      :episodes="props.episodes"
      :current-episode-url="props.currentEpisodeUrl"
      :has-previous="props.hasPrevious"
      :has-next="props.hasNext"
      @progress="emit('progress', $event)"
      @previous="emit('previous', $event)"
      @next="emit('next', $event)"
      @ended="emit('ended', $event)"
      @select-episode="emit('selectEpisode', $event)"
      @close="emit('close', $event)"
    />
    <ArtPlayerHost
      v-else-if="activeEngine === 'artplayer'"
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
      :danmaku-settings="props.danmakuSettings"
      :subtitle-settings="props.subtitleSettings"
      @progress="emit('progress', $event)"
      @previous="emit('previous', $event)"
      @next="emit('next', $event)"
      @ended="emit('ended', $event)"
      @select-episode="emit('selectEpisode', $event)"
      @close="emit('close', $event)"
      @fallback="emit('fallback', $event)"
    />
  </div>
</template>

<style scoped>
.player-container {
  position: fixed;
  inset: 0;
  z-index: 200;
}
</style>
