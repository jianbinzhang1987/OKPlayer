<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AppIcon from "./AppIcon.vue";

type LiveLine = {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  format?: string;
  parse: boolean;
  priority: number;
  health?: {
    state: "unknown" | "available" | "degraded" | "unavailable";
    score: number;
    checkedAt: number;
    latencyMs?: number;
    playbackSuccessCount?: number;
    playbackFailureCount?: number;
    stablePlaybackSeconds?: number;
    averageStartupMs?: number;
    bufferingCount?: number;
    failoverSuccessCount?: number;
    reason?: string;
  };
};

type LiveChannel = {
  id: string;
  sourceId: string;
  groupId: string;
  name: string;
  number?: string;
  logo?: string;
  tvgId?: string;
  tvgName?: string;
  lines: LiveLine[];
  catchup?: { type?: string; regex?: string; source?: string; replace?: string };
};

type LiveGroup = {
  id: string;
  sourceId: string;
  name: string;
  passwordProtected: boolean;
  channels: LiveChannel[];
};

type LiveSource = {
  id: string;
  name: string;
  sourceUrl?: string;
  format: "m3u" | "txt" | "json" | "embedded";
  groups: LiveGroup[];
  loadedAt: number;
};

type LiveSourceSummary = {
  id: string;
  name: string;
  sourceUrl?: string;
  format?: string;
  boot: boolean;
  loaded: boolean;
  groupCount: number;
  channelCount: number;
  lineCount: number;
  loadedAt?: number;
  error?: string;
};

type LiveFavoriteRecord = {
  sourceId: string;
  channelId: string;
  channelName: string;
  logo?: string;
  createdAt: number;
};

type LiveRecentRecord = {
  sourceId: string;
  channelId: string;
  channelName: string;
  lineId?: string;
  watchedAt: number;
};

type EpgProgramme = {
  id: string;
  channelId: string;
  startAt: number;
  endAt: number;
  title: string;
  subtitle?: string;
  description?: string;
  categories: string[];
  icon?: string;
};

type EpgChannelDefinition = {
  id: string;
  names: string[];
  icon?: string;
};

type LiveChannelEpg = {
  liveChannelId: string;
  epgChannelId?: string;
  matchMethod?: "manual" | "tvg-id" | "tvg-name" | "channel-name" | "normalized-name";
  confidence: number;
  current?: EpgProgramme;
  next?: EpgProgramme;
  schedule: EpgProgramme[];
};

type LiveEpgGuide = {
  sourceId: string;
  loadedAt: number;
  expiresAt: number;
  epgSourceCount: number;
  epgChannelCount: number;
  programmeCount: number;
  matchedChannelCount: number;
  channels: Record<string, LiveChannelEpg>;
  epgChannels: EpgChannelDefinition[];
  warnings: string[];
};

const emit = defineEmits<{
  play: [payload: {
    sourceId: string;
    sourceName: string;
    channel: LiveChannel;
    realtimeChannel?: LiveChannel;
    lineId?: string;
    realtimeLineId?: string;
    mode?: "live" | "catchup" | "timeshift";
    startPosition?: number;
    programme?: EpgProgramme;
    channelCount?: number;
    manualLineSelection?: boolean;
  }];
  status: [message: string];
  error: [error: unknown];
}>();

const summaries = ref<LiveSourceSummary[]>([]);
const source = ref<LiveSource | null>(null);
const selectedSourceId = ref("");
const savedSourceId = ref("");
const selectedGroupId = ref("all");
const query = ref("");
const loading = ref(false);
const favorites = ref<LiveFavoriteRecord[]>([]);
const recent = ref<LiveRecentRecord[]>([]);
const selectedLineByChannel = ref<Record<string, string>>({});
const brokenLogos = ref(new Set<string>());
const epgGuide = ref<LiveEpgGuide | null>(null);
const epgLoading = ref(false);
const epgMessage = ref("");
const lineQualityMessage = ref("");
const epgDrawerChannelId = ref("");
const epgMappingChannelId = ref("");
const epgMappingSaving = ref(false);
const selectedEpgDate = ref("");
const catchupLoadingProgrammeId = ref("");
const clockNow = ref(Date.now());
let clockTimer: ReturnType<typeof window.setInterval> | undefined;

const favoriteKeys = computed(() => new Set(favorites.value.map((item) => `${item.sourceId}:${item.channelId}`)));
const recentLineByChannel = computed(() => new Map(recent.value.map((item) => [`${item.sourceId}:${item.channelId}`, item.lineId] as const)));
const groups = computed(() => source.value?.groups ?? []);
const allChannels = computed(() => groups.value.flatMap((group) => group.channels));
const epgDrawerChannel = computed(() => allChannels.value.find((channel) => channel.id === epgDrawerChannelId.value));
const epgDrawer = computed(() => epgDrawerChannelId.value ? epgGuide.value?.channels[epgDrawerChannelId.value] : undefined);
const epgChannelOptions = computed(() => epgGuide.value?.epgChannels ?? []);
const epgDateOptions = computed(() => {
  const values = [...new Set((epgDrawer.value?.schedule ?? []).map((programme) => programmeDateKey(programme.startAt)))];
  return values.map((value) => ({ value, label: programmeDateLabel(value) }));
});
const epgDrawerSchedule = computed(() => {
  const schedule = epgDrawer.value?.schedule ?? [];
  if (!selectedEpgDate.value) return schedule;
  return schedule.filter((programme) => programmeDateKey(programme.startAt) === selectedEpgDate.value);
});
const visibleChannels = computed(() => {
  const normalized = query.value.trim().toLowerCase();
  let values = selectedGroupId.value === "favorites"
    ? allChannels.value.filter((channel) => favoriteKeys.value.has(`${channel.sourceId}:${channel.id}`))
    : selectedGroupId.value === "recent"
      ? recent.value
        .filter((item) => item.sourceId === source.value?.id)
        .flatMap((item) => allChannels.value.find((channel) => channel.id === item.channelId) ?? [])
      : selectedGroupId.value === "all"
        ? allChannels.value
        : groups.value.find((group) => group.id === selectedGroupId.value)?.channels ?? [];
  if (normalized) {
    values = values.filter((channel) => `${channel.name} ${channel.number ?? ""} ${channel.tvgId ?? ""} ${channel.tvgName ?? ""}`.toLowerCase().includes(normalized));
  }
  return values;
});

function isFavorite(channel: LiveChannel): boolean {
  return favoriteKeys.value.has(`${channel.sourceId}:${channel.id}`);
}

function selectedLineId(channel: LiveChannel): string {
  const selected = selectedLineByChannel.value[channel.id];
  if (selected && channel.lines.some((line) => line.id === selected)) return selected;
  const recentLine = recentLineByChannel.value.get(`${channel.sourceId}:${channel.id}`);
  if (recentLine && channel.lines.some((line) => line.id === recentLine)) return recentLine;
  return channel.lines[0]?.id ?? "";
}

function selectLine(channel: LiveChannel, lineId: string): void {
  selectedLineByChannel.value = { ...selectedLineByChannel.value, [channel.id]: lineId };
}

function lineProtocol(line: LiveLine): string {
  try {
    const protocol = new URL(line.url).protocol.replace(":", "").toUpperCase();
    return ["RTMP", "RTSP", "UDP", "RTP"].includes(protocol) ? protocol : "";
  } catch {
    return "";
  }
}

function lineDisplayName(line: LiveLine): string {
  const protocol = lineProtocol(line);
  const protocolLabel = protocol ? ` · ${protocol}` : "";
  if (!line.health || line.health.state === "unknown") return `${line.name}${protocolLabel}`;
  const state = line.health.state === "available" ? "优" : line.health.state === "degraded" ? "备用" : "失效";
  return `${line.name}${protocolLabel} · ${state} ${Math.round(line.health.score)}`;
}

function lineQualitySummary(line?: LiveLine): string {
  if (!line?.health || line.health.state === "unknown") return line?.name ?? "默认线路";
  const starts = line.health.averageStartupMs ? ` · 启动 ${Math.round(line.health.averageStartupMs)}ms` : "";
  const successes = line.health.playbackSuccessCount ? ` · 稳定 ${line.health.playbackSuccessCount} 次` : "";
  const buffering = line.health.bufferingCount ? ` · 缓冲 ${line.health.bufferingCount} 次` : "";
  const failover = line.health.failoverSuccessCount ? ` · 备用成功 ${line.health.failoverSuccessCount} 次` : "";
  return `${line.name} · 评分 ${Math.round(line.health.score)}${starts}${successes}${buffering}${failover}`;
}

function cloneLiveChannel(channel: LiveChannel): LiveChannel {
  return {
    ...channel,
    lines: channel.lines.map((line) => ({
      ...line,
      headers: { ...line.headers },
    })),
  };
}

function channelEpg(channel: LiveChannel): LiveChannelEpg | undefined {
  return epgGuide.value?.channels[channel.id];
}

function programmeDateKey(value: number): string {
  if (!Number.isFinite(value)) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function programmeDateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const todayKey = programmeDateKey(today.getTime());
  const tomorrowKey = programmeDateKey(today.getTime() + 24 * 60 * 60 * 1_000);
  if (value === todayKey) return "今天";
  if (value === tomorrowKey) return "明天";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }).format(date);
}

function formatProgrammeTime(value: number): string {
  if (!Number.isFinite(value)) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatDuration(value: number): string {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function programmeProgress(programme?: EpgProgramme): number {
  if (!programme || programme.endAt <= programme.startAt) return 0;
  return Math.min(100, Math.max(0, ((clockNow.value - programme.startAt) / (programme.endAt - programme.startAt)) * 100));
}

function openEpgDrawer(channel: LiveChannel): void {
  if (!epgGuide.value) return;
  epgDrawerChannelId.value = channel.id;
  epgMappingChannelId.value = channelEpg(channel)?.epgChannelId ?? "";
  const schedule = channelEpg(channel)?.schedule ?? [];
  const today = programmeDateKey(clockNow.value);
  selectedEpgDate.value = schedule.some((programme) => programmeDateKey(programme.startAt) === today)
    ? today
    : programmeDateKey(schedule[0]?.startAt ?? clockNow.value);
}

function openProgrammeGuide(channelId: string): void {
  const channel = allChannels.value.find((item) => item.id === channelId);
  if (channel) openEpgDrawer(channel);
}

function closeEpgDrawer(): void {
  epgDrawerChannelId.value = "";
  epgMappingChannelId.value = "";
  selectedEpgDate.value = "";
}

defineExpose({ openProgrammeGuide });

function epgChannelLabel(channel: EpgChannelDefinition): string {
  const name = channel.names[0]?.trim() || channel.id;
  return name === channel.id ? name : `${name} · ${channel.id}`;
}

function epgMatchLabel(method?: LiveChannelEpg["matchMethod"]): string {
  if (method === "manual") return "人工映射";
  if (method === "tvg-id") return "tvg-id 精确匹配";
  if (method === "tvg-name") return "tvg-name 精确匹配";
  if (method === "channel-name") return "频道名称精确匹配";
  if (method === "normalized-name") return "标准化名称匹配";
  return "未匹配";
}

async function saveEpgMapping(): Promise<void> {
  const channel = epgDrawerChannel.value;
  if (!source.value || !channel || !epgMappingChannelId.value) return;
  const api = (window as any).tvApi;
  if (typeof api.saveLiveEpgMapping !== "function") return;
  const option = epgChannelOptions.value.find((item) => item.id === epgMappingChannelId.value);
  epgMappingSaving.value = true;
  try {
    await api.saveLiveEpgMapping(source.value.id, channel.id, epgMappingChannelId.value, option?.names[0]);
    await loadEpgGuide(false);
    epgMappingChannelId.value = epgGuide.value?.channels[channel.id]?.epgChannelId ?? epgMappingChannelId.value;
    epgMessage.value = `已为“${channel.name}”保存人工节目单映射`;
  } catch (error) {
    emit("error", error);
  } finally {
    epgMappingSaving.value = false;
  }
}

async function removeEpgMapping(): Promise<void> {
  const channel = epgDrawerChannel.value;
  if (!source.value || !channel) return;
  const api = (window as any).tvApi;
  if (typeof api.removeLiveEpgMapping !== "function") return;
  epgMappingSaving.value = true;
  try {
    await api.removeLiveEpgMapping(source.value.id, channel.id);
    await loadEpgGuide(false);
    epgMappingChannelId.value = epgGuide.value?.channels[channel.id]?.epgChannelId ?? "";
    epgMessage.value = `已取消“${channel.name}”的人工节目单映射`;
  } catch (error) {
    emit("error", error);
  } finally {
    epgMappingSaving.value = false;
  }
}

function supportsCatchup(channel?: LiveChannel): boolean {
  const catchup = channel?.catchup;
  if (!catchup) return false;
  const type = String(catchup.type ?? "").toLowerCase();
  if (type === "replace") return Boolean(catchup.regex && catchup.replace);
  if (["flussonic", "fs"].includes(type)) return true;
  return Boolean(catchup.source);
}

function canReplayProgramme(programme: EpgProgramme): boolean {
  return Boolean(epgDrawerChannel.value && supportsCatchup(epgDrawerChannel.value) && programme.startAt < clockNow.value);
}

async function playCatchup(programme: EpgProgramme): Promise<void> {
  const channel = epgDrawerChannel.value;
  if (!source.value || !channel || !canReplayProgramme(programme)) return;
  const api = (window as any).tvApi;
  if (typeof api.resolveLiveCatchup !== "function") return;
  catchupLoadingProgrammeId.value = programme.id;
  emit("status", `正在生成“${programme.title}”的回看地址…`);
  try {
    const [resolved, history] = await Promise.all([
      api.resolveLiveCatchup(source.value.id, channel.id, programme, selectedLineId(channel)),
      api.getLiveCatchupHistory?.(source.value.id, channel.id, programme.startAt),
    ]);
    const resumePosition = history && !history.completed ? Math.max(0, Number(history.position) || 0) : 0;
    closeEpgDrawer();
    emit("status", resumePosition > 0 ? `将从 ${formatDuration(resumePosition)} 继续回看` : "");
    emit("play", {
      sourceId: source.value.id,
      sourceName: source.value.name,
      channel: cloneLiveChannel(resolved.channel),
      realtimeChannel: cloneLiveChannel(channel),
      lineId: resolved.line?.id,
      realtimeLineId: selectedLineId(channel),
      mode: "catchup",
      startPosition: resumePosition,
      programme: { ...programme, categories: [...programme.categories] },
      channelCount: allChannels.value.length,
    });
  } catch (error) {
    emit("status", "");
    emit("error", error);
  } finally {
    catchupLoadingProgrammeId.value = "";
  }
}

async function loadEpgGuide(force = false): Promise<void> {
  if (!selectedSourceId.value || !source.value) {
    epgGuide.value = null;
    return;
  }
  const api = (window as any).tvApi;
  if (typeof api.loadLiveEpgGuide !== "function") return;
  epgLoading.value = true;
  epgMessage.value = force ? "正在刷新节目单…" : "正在加载节目单…";
  try {
    epgGuide.value = await api.loadLiveEpgGuide(selectedSourceId.value, force);
    const guide = epgGuide.value;
    if (!guide) {
      epgMessage.value = "";
    } else if (guide.matchedChannelCount > 0) {
      epgMessage.value = `节目单已匹配 ${guide.matchedChannelCount}/${allChannels.value.length} 个频道`;
    } else {
      epgMessage.value = guide.warnings[0] ?? "当前直播源暂未匹配到节目单";
    }
  } catch (error) {
    epgMessage.value = epgGuide.value
      ? `节目单刷新失败，继续使用 ${formatProgrammeTime(epgGuide.value.loadedAt)} 的缓存`
      : "节目单加载失败，不影响直播播放";
  } finally {
    epgLoading.value = false;
  }
}

function playChannel(channel: LiveChannel): void {
  if (!source.value || !channel.lines.length) return;
  emit("play", {
    sourceId: source.value.id,
    sourceName: source.value.name,
    channel: cloneLiveChannel(channel),
    lineId: selectedLineId(channel),
    programme: channelEpg(channel)?.current ? { ...channelEpg(channel)!.current!, categories: [...channelEpg(channel)!.current!.categories] } : undefined,
    channelCount: allChannels.value.length,
    manualLineSelection: Boolean(selectedLineByChannel.value[channel.id]),
  });
}

async function loadRecords(): Promise<void> {
  const api = (window as any).tvApi;
  [favorites.value, recent.value] = await Promise.all([
    api.listLiveFavorites?.() ?? [],
    api.listLiveRecent?.(100) ?? [],
  ]);
}

async function refreshFrequentLineQuality(): Promise<void> {
  const currentSource = source.value;
  const api = (window as any).tvApi;
  if (!currentSource || typeof api.inspectLiveChannel !== "function") return;
  const settingKey = `liveLineQualityAuditAt:${currentSource.id}`;
  const lastAuditAt = Number(await api.getSetting?.(settingKey, 0) ?? 0);
  if (Date.now() - lastAuditAt < 6 * 60 * 60 * 1_000) return;
  const channelIds = [...new Set([
    ...favorites.value.filter((item) => item.sourceId === currentSource.id).map((item) => item.channelId),
    ...recent.value.filter((item) => item.sourceId === currentSource.id).map((item) => item.channelId),
  ])]
    .filter((channelId) => allChannels.value.some((channel) => channel.id === channelId))
    .slice(0, 6);
  if (!channelIds.length) return;
  lineQualityMessage.value = `正在后台复检 ${channelIds.length} 个常用频道线路…`;
  let completed = 0;
  for (let index = 0; index < channelIds.length; index += 2) {
    await Promise.all(channelIds.slice(index, index + 2).map(async (channelId) => {
      try {
        const checked = await api.inspectLiveChannel(currentSource.id, channelId, true);
        const target = allChannels.value.find((channel) => channel.id === channelId);
        if (target && checked?.lines?.length) {
          target.lines = checked.lines.map((line: LiveLine) => ({
            ...line,
            headers: { ...line.headers },
            ...(line.health ? { health: { ...line.health } } : {}),
          }));
        }
      } catch {
        // A background quality check must never block or clear the channel list.
      } finally {
        completed += 1;
        lineQualityMessage.value = `常用频道线路复检 ${completed}/${channelIds.length}`;
      }
    }));
  }
  await api.setSetting?.(settingKey, Date.now()).catch(() => undefined);
  lineQualityMessage.value = `已更新 ${completed} 个常用频道的线路质量`;
}

async function refreshSummaries(): Promise<void> {
  const api = (window as any).tvApi;
  summaries.value = await api.listLiveSources();
  if (!selectedSourceId.value || !summaries.value.some((item) => item.id === selectedSourceId.value)) {
    const preferred = savedSourceId.value && summaries.value.some((item) => item.id === savedSourceId.value)
      ? savedSourceId.value
      : summaries.value.find((item) => item.boot)?.id ?? summaries.value[0]?.id ?? "";
    selectedSourceId.value = preferred;
  }
}

async function loadSelectedSource(force = false): Promise<void> {
  if (!selectedSourceId.value) {
    source.value = null;
    return;
  }
  loading.value = true;
  emit("status", force ? "正在刷新直播源…" : "正在加载直播频道…");
  try {
    const api = (window as any).tvApi;
    source.value = await api.loadLiveSource(selectedSourceId.value, force);
    selectedGroupId.value = "all";
    epgDrawerChannelId.value = "";
    epgGuide.value = null;
    await Promise.all([refreshSummaries(), loadRecords()]);
    emit("status", "");
    void loadEpgGuide(force);
    void refreshFrequentLineQuality();
  } catch (error) {
    source.value = null;
    emit("status", "");
    emit("error", error);
  } finally {
    loading.value = false;
  }
}

async function switchSource(): Promise<void> {
  const api = (window as any).tvApi;
  savedSourceId.value = selectedSourceId.value;
  await api.setSetting?.("defaultLiveSourceId", selectedSourceId.value);
  await loadSelectedSource(false);
}

async function toggleFavorite(channel: LiveChannel): Promise<void> {
  const api = (window as any).tvApi;
  try {
    if (isFavorite(channel)) {
      await api.removeLiveFavorite(channel.sourceId, channel.id);
    } else {
      await api.saveLiveFavorite({
        sourceId: channel.sourceId,
        channelId: channel.id,
        channelName: channel.name,
        logo: channel.logo,
        createdAt: Date.now(),
      });
    }
    await loadRecords();
  } catch (error) {
    emit("error", error);
  }
}

function markLogoBroken(value?: string): void {
  if (!value) return;
  brokenLogos.value = new Set([...brokenLogos.value, value]);
}

function hasLogo(channel: LiveChannel): boolean {
  return Boolean(channel.logo && !brokenLogos.value.has(channel.logo));
}

function sourceStatus(summary: LiveSourceSummary): string {
  if (summary.error) return "加载异常";
  if (!summary.loaded) return "未加载";
  return `${summary.channelCount} 个频道`;
}

onMounted(async () => {
  clockTimer = window.setInterval(() => { clockNow.value = Date.now(); }, 30_000);
  loading.value = true;
  try {
    const api = (window as any).tvApi;
    savedSourceId.value = await api.getSetting?.("defaultLiveSourceId", "") ?? "";
    await Promise.all([refreshSummaries(), loadRecords()]);
    if (selectedSourceId.value) await loadSelectedSource(false);
  } catch (error) {
    emit("error", error);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
  clockTimer = undefined;
});
</script>

<template>
  <section class="live-page">
    <header class="live-page-header">
      <div>
        <small>LIVE TV</small>
        <h1>电视直播</h1>
        <p>浏览当前配置中的 IPTV 频道，支持分组、收藏、多线路和应用内播放。</p>
      </div>
      <div class="live-page-actions">
        <label class="live-source-select">
          <span>直播源</span>
          <select v-model="selectedSourceId" :disabled="loading || !summaries.length" @change="switchSource">
            <option v-for="item in summaries" :key="item.id" :value="item.id">{{ item.name }} · {{ sourceStatus(item) }}</option>
          </select>
        </label>
        <button class="secondary-button" :disabled="loading || !selectedSourceId" @click="loadSelectedSource(true)"><AppIcon name="refresh" :size="15" />刷新频道</button>
        <button class="secondary-button" :disabled="loading || epgLoading || !selectedSourceId" @click="loadEpgGuide(true)"><AppIcon name="clock" :size="15" />{{ epgLoading ? '节目单加载中' : '刷新节目单' }}</button>
      </div>
    </header>

    <div v-if="loading && !source" class="live-loading-state">
      <div class="loading-spinner"></div>
      <strong>正在加载直播频道</strong>
      <span>首次加载会下载并解析当前 IPTV 列表。</span>
    </div>

    <div v-else-if="!summaries.length" class="live-empty-state">
      <span class="live-empty-icon"><AppIcon name="play" :size="30" /></span>
      <h2>当前配置没有直播源</h2>
      <p>请在内容来源配置中增加顶层 lives，支持 M3U、TXT、JSON 或内嵌 groups。</p>
    </div>

    <div v-else-if="source" class="live-workspace">
      <aside class="live-groups">
        <div class="live-source-summary">
          <span class="live-indicator"></span>
          <div><small>{{ source.format.toUpperCase() }}</small><strong>{{ source.name }}</strong></div>
          <em>{{ allChannels.length }}</em>
        </div>
        <button :class="{ active: selectedGroupId === 'all' }" @click="selectedGroupId = 'all'"><AppIcon name="grid" :size="16" /><span>全部频道</span><em>{{ allChannels.length }}</em></button>
        <button :class="{ active: selectedGroupId === 'favorites' }" @click="selectedGroupId = 'favorites'"><AppIcon name="heart" :size="16" /><span>收藏频道</span><em>{{ favorites.filter((item) => item.sourceId === source?.id).length }}</em></button>
        <button :class="{ active: selectedGroupId === 'recent' }" @click="selectedGroupId = 'recent'"><AppIcon name="clock" :size="16" /><span>最近观看</span><em>{{ recent.filter((item) => item.sourceId === source?.id).length }}</em></button>
        <div class="live-group-label">频道分组</div>
        <button v-for="group in groups" :key="group.id" :class="{ active: selectedGroupId === group.id }" @click="selectedGroupId = group.id"><AppIcon name="film" :size="16" /><span>{{ group.name }}</span><em>{{ group.channels.length }}</em></button>
      </aside>

      <main class="live-channel-panel">
        <div class="live-channel-toolbar">
          <label><AppIcon name="search" :size="17" /><input v-model="query" placeholder="搜索频道名称或频道号" /></label>
          <span>{{ visibleChannels.length }} 个频道</span>
        </div>
        <div v-if="epgMessage" class="live-epg-status" :class="{ loading: epgLoading }"><AppIcon name="clock" :size="14" /><span>{{ epgMessage }}</span><small v-if="epgGuide">更新于 {{ formatProgrammeTime(epgGuide.loadedAt) }} · {{ epgGuide.programmeCount }} 条节目</small></div>
        <div v-if="lineQualityMessage" class="live-epg-status"><AppIcon name="check" :size="14" /><span>{{ lineQualityMessage }}</span></div>

        <div v-if="visibleChannels.length" class="live-channel-grid">
          <article v-for="channel in visibleChannels" :key="channel.id" class="live-channel-card">
            <button class="live-channel-main" @click="playChannel(channel)">
              <span class="live-channel-logo">
                <img v-if="hasLogo(channel)" :src="channel.logo" :alt="channel.name" loading="lazy" @error="markLogoBroken(channel.logo)" />
                <strong v-else>{{ channel.name.slice(0, 2) }}</strong>
              </span>
              <span class="live-channel-copy">
                <small v-if="channel.number">频道 {{ channel.number }}</small>
                <strong>{{ channel.name }}</strong>
                <template v-if="channelEpg(channel)?.current">
                  <span class="live-epg-current"><b>正在播</b>{{ channelEpg(channel)!.current!.title }}</span>
                  <span class="live-epg-progress"><i :style="{ width: `${programmeProgress(channelEpg(channel)!.current)}%` }"></i></span>
                  <em v-if="channelEpg(channel)?.next">{{ formatProgrammeTime(channelEpg(channel)!.next!.startAt) }} {{ channelEpg(channel)!.next!.title }}</em>
                </template>
                <em v-else>{{ channel.lines.length > 1 ? `${channel.lines.length} 条线路` : '直播线路' }}</em>
              </span>
              <span class="live-play-icon"><AppIcon name="play" :size="17" /></span>
            </button>
            <div class="live-channel-footer">
              <select v-if="channel.lines.length > 1" :value="selectedLineId(channel)" aria-label="选择直播线路" @change="selectLine(channel, ($event.target as HTMLSelectElement).value)">
                <option v-for="line in channel.lines" :key="line.id" :value="line.id" :disabled="['UDP', 'RTP'].includes(lineProtocol(line))">{{ lineDisplayName(line) }}</option>
              </select>
              <span v-else>{{ lineQualitySummary(channel.lines[0]) }}</span>
              <span class="live-channel-footer-actions">
                <button v-if="epgGuide" :title="channelEpg(channel)?.schedule.length ? '查看节目单' : '修正节目单匹配'" @click="openEpgDrawer(channel)"><AppIcon name="clock" :size="16" /></button>
                <button :class="{ active: isFavorite(channel) }" :title="isFavorite(channel) ? '取消收藏' : '收藏频道'" @click="toggleFavorite(channel)"><AppIcon name="heart" :size="16" /></button>
              </span>
            </div>
          </article>
        </div>

        <div v-else class="live-list-empty">
          <AppIcon name="search" :size="28" />
          <strong>没有找到频道</strong>
          <span>尝试切换分组或清除搜索关键词。</span>
        </div>
      </main>
    </div>

    <div v-if="epgDrawerChannel && epgDrawer" class="live-epg-overlay" @click.self="closeEpgDrawer">
      <aside class="live-epg-drawer">
        <header>
          <div><small>PROGRAM GUIDE</small><strong>{{ epgDrawerChannel.name }}节目单</strong></div>
          <button class="icon-button" title="关闭节目单" @click="closeEpgDrawer"><AppIcon name="close" :size="17" /></button>
        </header>
        <div class="live-epg-drawer-summary">
          <span>匹配方式：{{ epgMatchLabel(epgDrawer.matchMethod) }}</span>
          <span>可信度：{{ epgDrawer.confidence }}%</span>
        </div>
        <section v-if="epgChannelOptions.length" class="live-epg-mapping">
          <div><strong>人工修正频道映射</strong><span>自动匹配不准确时，可指定对应的 EPG 频道；设置保存在本机。</span></div>
          <select v-model="epgMappingChannelId" :disabled="epgMappingSaving">
            <option value="">选择 EPG 频道</option>
            <option v-for="channel in epgChannelOptions" :key="channel.id" :value="channel.id">{{ epgChannelLabel(channel) }}</option>
          </select>
          <div class="live-epg-mapping-actions">
            <button class="primary-button" :disabled="epgMappingSaving || !epgMappingChannelId" @click="saveEpgMapping">{{ epgMappingSaving ? '正在保存…' : '保存映射' }}</button>
            <button v-if="epgDrawer.matchMethod === 'manual'" class="secondary-button" :disabled="epgMappingSaving" @click="removeEpgMapping">恢复自动匹配</button>
          </div>
        </section>
        <nav v-if="epgDateOptions.length > 1" class="live-epg-dates" aria-label="节目单日期">
          <button v-for="date in epgDateOptions" :key="date.value" :class="{ active: selectedEpgDate === date.value }" @click="selectedEpgDate = date.value">{{ date.label }}</button>
        </nav>
        <div v-if="epgDrawerSchedule.length" class="live-epg-programmes">
          <article v-for="programme in epgDrawerSchedule" :key="programme.id" :class="{ current: programme.startAt <= clockNow && programme.endAt > clockNow }">
            <time>{{ formatProgrammeTime(programme.startAt) }}<small>{{ formatProgrammeTime(programme.endAt) }}</small></time>
            <div><strong>{{ programme.title }}</strong><span v-if="programme.subtitle">{{ programme.subtitle }}</span><p v-if="programme.description">{{ programme.description }}</p></div>
            <em v-if="programme.startAt <= clockNow && programme.endAt > clockNow">正在播</em>
            <button v-else-if="canReplayProgramme(programme)" class="live-catchup-button" :disabled="catchupLoadingProgrammeId === programme.id" @click="playCatchup(programme)">{{ catchupLoadingProgrammeId === programme.id ? '准备中' : '回看' }}</button>
          </article>
        </div>
        <div v-else class="live-list-empty"><AppIcon name="clock" :size="26" /><strong>暂无节目安排</strong></div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.live-page { display: flex; flex-direction: column; gap: 18px; min-height: 100%; }
.live-page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.live-page-header small { color: var(--text-tertiary); font-size: 11px; font-weight: 800; letter-spacing: .18em; }
.live-page-header h1 { margin: 5px 0 4px; font-size: 30px; }
.live-page-header p { margin: 0; color: var(--text-secondary); }
.live-page-actions { display: flex; align-items: flex-end; gap: 10px; }
.live-source-select { display: grid; gap: 6px; min-width: 260px; }
.live-source-select span { color: var(--text-tertiary); font-size: 12px; }
.live-source-select select, .live-channel-footer select { min-height: 38px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-soft); color: var(--text); padding: 0 34px 0 12px; }
.live-loading-state, .live-empty-state { min-height: 390px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; border: 1px dashed var(--border); border-radius: 20px; background: var(--bg-solid); text-align: center; }
.live-loading-state span, .live-empty-state p { color: var(--text-secondary); }
.live-empty-icon { width: 58px; height: 58px; display: grid; place-items: center; border-radius: 18px; background: var(--bg-soft); }
.live-workspace { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px; min-height: 590px; }
.live-groups, .live-channel-panel { border: 1px solid var(--border); border-radius: 18px; background: var(--bg-solid); }
.live-groups { padding: 12px; overflow: auto; }
.live-source-summary { display: flex; align-items: center; gap: 9px; padding: 10px 8px 15px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
.live-indicator { width: 8px; height: 8px; border-radius: 50%; background: #3fca75; box-shadow: 0 0 0 4px rgba(63,202,117,.13); }
.live-source-summary div { display: grid; flex: 1; min-width: 0; }
.live-source-summary small { color: var(--text-tertiary); font-size: 10px; }
.live-source-summary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-source-summary em, .live-groups button em { color: var(--text-tertiary); font-style: normal; font-size: 12px; }
.live-groups > button { width: 100%; display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 8px; padding: 10px; border: 0; border-radius: 10px; background: transparent; color: var(--text-secondary); text-align: left; cursor: pointer; }
.live-groups > button:hover, .live-groups > button.active { background: var(--bg-soft); color: var(--text); }
.live-groups > button.active { box-shadow: inset 3px 0 0 var(--accent); }
.live-group-label { padding: 18px 10px 7px; color: var(--text-tertiary); font-size: 11px; font-weight: 700; letter-spacing: .08em; }
.live-channel-panel { padding: 16px; min-width: 0; }
.live-channel-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 15px; margin-bottom: 15px; }
.live-channel-toolbar label { flex: 1; max-width: 500px; height: 42px; display: flex; align-items: center; gap: 9px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-soft); padding: 0 12px; }
.live-channel-toolbar input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); }
.live-channel-toolbar > span { color: var(--text-tertiary); font-size: 13px; }
.live-channel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.live-channel-card { overflow: hidden; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-soft); }
.live-channel-main { width: 100%; display: grid; grid-template-columns: 54px 1fr 34px; align-items: center; gap: 11px; border: 0; padding: 14px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.live-channel-main:hover .live-play-icon { transform: scale(1.06); background: var(--accent); color: white; }
.live-channel-logo { width: 52px; height: 52px; display: grid; place-items: center; overflow: hidden; border-radius: 12px; background: var(--bg-solid); }
.live-channel-logo img { width: 100%; height: 100%; object-fit: contain; padding: 5px; }
.live-channel-logo strong { font-size: 14px; }
.live-channel-copy { display: grid; min-width: 0; gap: 2px; }
.live-channel-copy small, .live-channel-copy em { color: var(--text-tertiary); font-size: 11px; font-style: normal; }
.live-channel-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-play-icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; background: var(--bg-solid); transition: .18s ease; }
.live-channel-footer { min-height: 43px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--border); padding: 6px 9px 6px 13px; color: var(--text-tertiary); font-size: 12px; }
.live-channel-footer select { min-width: 0; max-width: 160px; min-height: 30px; font-size: 12px; }
.live-channel-footer button { width: 31px; height: 31px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--text-tertiary); cursor: pointer; }
.live-channel-footer button:hover, .live-channel-footer button.active { background: var(--bg-solid); color: #e15a77; }
.live-channel-footer-actions { display: inline-flex; align-items: center; gap: 3px; }
.live-epg-status { display: flex; align-items: center; gap: 6px; margin: -5px 0 13px; color: var(--text-tertiary); font-size: 12px; }
.live-epg-status span { min-width: 0; }
.live-epg-status small { margin-left: auto; color: var(--text-tertiary); font-size: 10px; }
.live-epg-status.loading { color: var(--accent); }
.live-epg-current { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: 4px; color: var(--text-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.live-epg-current b { flex: 0 0 auto; color: #43c77a; font-size: 10px; font-weight: 700; }
.live-epg-progress { overflow: hidden; height: 3px; margin-top: 3px; border-radius: 999px; background: var(--border); }
.live-epg-progress i { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.live-epg-overlay { position: fixed; inset: 0; z-index: 180; display: flex; justify-content: flex-end; background: rgba(0,0,0,.46); backdrop-filter: blur(2px); }
.live-epg-drawer { width: min(460px, 92vw); height: 100%; overflow: auto; padding: 22px; border-left: 1px solid var(--border); background: var(--bg-solid); box-shadow: -18px 0 70px rgba(0,0,0,.3); }
.live-epg-drawer > header { display: flex; align-items: center; justify-content: space-between; gap: 15px; }
.live-epg-drawer > header div { display: grid; gap: 4px; }
.live-epg-drawer > header small { color: var(--text-tertiary); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.live-epg-drawer > header strong { font-size: 20px; }
.live-epg-drawer-summary { display: flex; gap: 14px; margin: 15px 0; padding: 10px 12px; border-radius: 10px; background: var(--bg-soft); color: var(--text-tertiary); font-size: 11px; }
.live-epg-mapping { display: grid; gap: 10px; margin-bottom: 16px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-soft); }
.live-epg-mapping > div:first-child { display: grid; gap: 4px; }
.live-epg-mapping strong { font-size: 13px; }
.live-epg-mapping span { color: var(--text-tertiary); font-size: 11px; line-height: 1.45; }
.live-epg-mapping select { width: 100%; min-height: 38px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-solid); color: var(--text); padding: 0 10px; }
.live-epg-mapping-actions { display: flex; gap: 8px; }
.live-epg-dates { display: flex; gap: 7px; margin: 0 0 14px; overflow-x: auto; }
.live-epg-dates button { min-width: 64px; height: 34px; padding: 0 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-soft); color: var(--text-secondary); white-space: nowrap; }
.live-epg-dates button.active { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); background: color-mix(in srgb, var(--accent) 12%, var(--bg-soft)); color: var(--accent); }
.live-epg-programmes { display: grid; gap: 8px; }
.live-epg-programmes article { display: grid; grid-template-columns: 58px minmax(0,1fr) auto; gap: 11px; padding: 13px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-soft); }
.live-epg-programmes article.current { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); background: color-mix(in srgb, var(--accent) 10%, var(--bg-soft)); }
.live-epg-programmes time { display: grid; align-content: start; color: var(--text); font-size: 13px; font-variant-numeric: tabular-nums; }
.live-epg-programmes time small { margin-top: 3px; color: var(--text-tertiary); font-size: 10px; }
.live-epg-programmes article > div { min-width: 0; }
.live-epg-programmes article strong { display: block; color: var(--text); font-size: 13px; }
.live-epg-programmes article span, .live-epg-programmes article p { color: var(--text-tertiary); font-size: 11px; }
.live-epg-programmes article p { display: -webkit-box; overflow: hidden; margin: 6px 0 0; line-height: 1.45; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.live-epg-programmes article em { align-self: start; padding: 3px 6px; border-radius: 6px; color: #43c77a; background: rgba(67,199,122,.12); font-size: 10px; font-style: normal; }
.live-catchup-button { align-self: start; min-width: 48px; height: 29px; border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--accent) 12%, var(--bg-solid)); color: var(--accent); font-size: 11px; }
.live-catchup-button:disabled { opacity: .55; }
.live-list-empty { min-height: 350px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-secondary); }
.live-list-empty span { color: var(--text-tertiary); }
@media (max-width: 1050px) { .live-page-header { align-items: flex-start; flex-direction: column; } .live-page-actions { width: 100%; flex-wrap: wrap; } .live-workspace { grid-template-columns: 190px minmax(0, 1fr); } .live-channel-grid { grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); } }
</style>
