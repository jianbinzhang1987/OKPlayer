<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { parseDanmakuPayload, type DanmakuItem } from "../player/danmaku.ts";
import { DEFAULT_DANMAKU_SETTINGS, normalizeDanmakuSettings, type DanmakuPresentationSettings } from "../player/presentation-settings.ts";

const props = withDefaults(defineProps<{
  danmakuUrl?: string;
  currentTime?: number;
  visible?: boolean;
  enabled?: boolean;
  settings?: DanmakuPresentationSettings;
}>(), {
  danmakuUrl: "",
  currentTime: 0,
  visible: true,
  enabled: true,
  settings: () => ({ ...DEFAULT_DANMAKU_SETTINGS }),
});

const items = ref<DanmakuItem[]>([]);
const loading = ref(false);
const error = ref("");
let requestGeneration = 0;

const resolvedSettings = computed(() => normalizeDanmakuSettings(props.settings));
const activeItems = computed(() => {
  if (!props.enabled || !props.visible || !items.value.length) return [];
  const now = Number(props.currentTime ?? 0);
  const settings = resolvedSettings.value;
  const duration = Math.max(2.5, 6 / settings.speed);
  const blocked = settings.blockedWords.map((word) => word.toLowerCase());
  return items.value
    .filter((item) => item.time <= now && now < item.time + duration)
    .filter((item) => !blocked.some((word) => item.text.toLowerCase().includes(word)))
    .slice(-settings.maxActive)
    .map((item, index) => ({
      ...item,
      key: `${item.time}:${item.mode}:${item.text}:${index}`,
      lane: Math.abs(hashText(`${item.text}:${item.time}`)) % 8,
      order: index,
      duration,
    }));
});

async function loadDanmaku(url: string): Promise<void> {
  const currentGeneration = ++requestGeneration;
  items.value = [];
  error.value = "";
  if (!url) return;
  loading.value = true;
  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (currentGeneration !== requestGeneration) return;
    items.value = parseDanmakuPayload(text, contentType);
    if (!items.value.length) error.value = "未识别到可显示弹幕";
  } catch (caught) {
    if (currentGeneration !== requestGeneration) return;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (currentGeneration === requestGeneration) loading.value = false;
  }
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

watch(() => props.danmakuUrl, (url) => void loadDanmaku(url), { immediate: true });

onBeforeUnmount(() => {
  requestGeneration += 1;
});
</script>

<template>
  <div v-if="danmakuUrl && enabled" class="danmaku-overlay" aria-label="弹幕层">
    <span
      v-for="item in activeItems"
      :key="item.key"
      class="danmaku-item"
      :class="[`mode-${item.mode}`]"
      :style="{
        top: item.mode === 'top' ? `${8 + item.lane * 7}%` : item.mode === 'bottom' ? 'auto' : `${8 + item.lane * 8}%`,
        bottom: item.mode === 'bottom' ? `${10 + item.lane * 7}%` : 'auto',
        color: item.color ?? '#fff',
        animationDelay: `${Math.min(0.5, item.order * 0.03)}s`,
        animationDuration: `${item.mode === 'scroll' ? item.duration : Math.max(2.2, 4.2 / resolvedSettings.speed)}s`,
        opacity: resolvedSettings.opacity,
        fontSize: `clamp(${Math.round(16 * resolvedSettings.fontScale)}px, ${2.1 * resolvedSettings.fontScale}vw, ${Math.round(25 * resolvedSettings.fontScale)}px)`,
      }"
    >{{ item.text }}</span>
    <span v-if="loading" class="danmaku-status">正在加载弹幕…</span>
    <span v-else-if="error && !activeItems.length" class="danmaku-status muted">弹幕暂不可用</span>
  </div>
</template>

<style scoped>
.danmaku-overlay {
  position: absolute;
  inset: 64px 0 74px;
  z-index: 9;
  overflow: hidden;
  pointer-events: none;
  contain: paint;
}

.danmaku-item {
  position: absolute;
  left: 100%;
  max-width: 72%;
  padding: 2px 8px;
  border-radius: 999px;
  color: #fff;
  font-size: clamp(16px, 2.1vw, 25px);
  font-weight: 650;
  line-height: 1.35;
  white-space: nowrap;
  text-shadow: 0 2px 5px rgba(0, 0, 0, .95), 0 0 2px rgba(0, 0, 0, .9);
  animation: danmaku-scroll 6s linear forwards;
  will-change: transform;
}

.danmaku-item.mode-top,
.danmaku-item.mode-bottom {
  left: 50%;
  text-align: center;
  transform: translateX(-50%);
  animation: danmaku-fixed 4.2s ease-out forwards;
}

.danmaku-status {
  position: absolute;
  right: 18px;
  bottom: 12px;
  padding: 5px 9px;
  border-radius: 999px;
  color: rgba(245, 245, 247, .72);
  font-size: 11px;
  background: rgba(0, 0, 0, .42);
}

.danmaku-status.muted { opacity: .68; }

@keyframes danmaku-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(calc(-100vw - 100%)); }
}

@keyframes danmaku-fixed {
  0% { opacity: 0; transform: translate(-50%, -4px); }
  12% { opacity: 1; transform: translate(-50%, 0); }
  82% { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, -4px); }
}
</style>
