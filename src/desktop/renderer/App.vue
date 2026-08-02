<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppIcon from "./components/AppIcon.vue";
import PlayerContainer from "./components/PlayerContainer.vue";
import { isFolderItem, resolveContentRoute } from "./app-model.ts";
import { FONT_SIZE_OPTIONS, fontSizeClass as resolveFontSizeClass, normalizeFontSize, type FontSizePreference } from "./font-size.ts";
import { resolveEpisodeNavigation, resolveFallbackPlaybackLine, resolvePlaybackEpisodeTarget, resolvePreferredPlaybackLine, type PlaybackLinePreference } from "./player-navigation.ts";
import { normalizeCompatibilityFallbackMode, type CompatibilityFallbackMode } from "./player/playback-error-policy.ts";
import { normalizePlaybackMode, normalizeWebPlayerEngine, type PlaybackMode, type WebPlayerEngine } from "./player/player-types.ts";
import {
  DEFAULT_DANMAKU_SETTINGS,
  DEFAULT_SUBTITLE_SETTINGS,
  normalizeDanmakuSettings,
  normalizeSubtitleSettings,
  parseBlockedWords,
  type DanmakuPresentationSettings,
  type SubtitlePresentationSettings,
} from "./player/presentation-settings.ts";
import {
  buildLibraryCategoryGroups,
  dedupeLibraryItems,
  sortLibraryItems,
  type LibraryCategoryGroup,
  type LibrarySortMode,
} from "./library-category.ts";
import {
  homeItemIdentity,
  selectHomeRecommendations,
  selectHomeSection,
} from "./home-recommendation.ts";
import { sortSourcesByQuality } from "../../core/source-ranking.ts";
import {
  inferCatVodSourceLabel,
  inferConfigName,
  isCatVodBundleSource,
  selectCatVodSiteAfterImport,
  selectConfigSiteAfterImport,
} from "./source-config-strategy.ts";
import { groupNormalizedSearchResults, rankAlternativeSourceCandidates } from "./search-normalization.ts";
import { resolveSearchEmptyState } from "./search-empty-state.ts";
import { makeSerializableSetting, settingValuesEqual } from "./settings-persistence.ts";
import {
  presentRendererError,
  type RendererErrorContext,
  type RendererErrorPresentation,
} from "./error-presentation.ts";
import {
  resolveContinuationSearchBackend,
  resolveInitialSearchBackend,
  searchResultIdentity,
  type SearchBackendScope,
  type SearchScopePreference,
} from "./search-strategy.ts";

type SourceCapabilities = {
  home: boolean;
  category: boolean;
  search: boolean;
  detail: boolean;
  player: boolean;
  proxy: boolean;
  health: boolean;
};

type SourceQuality = {
  state: "unknown" | "checking" | "healthy" | "degraded" | "blocked";
  stage: "static" | "home" | "search" | "detail" | "player" | "media" | "runtime";
  reason: string;
  latencyMs: number;
  checkedAt: number;
  failureCount: number;
  successCount: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastSearchSuccessAt?: number;
  searchSuccessCount?: number;
  searchFailureCount?: number;
  lastMediaSuccessAt?: number;
  mediaSuccessCount?: number;
  mediaFailureCount?: number;
};

type SourceCategory = { id: string; name: string };
type SourceFilterOption = { label: string; value: string };
type SourceFilterGroup = { key: string; name: string; options: SourceFilterOption[]; defaultValue?: string };
type SiteContentType = "vod" | "discovery" | "live" | "short-drama" | "comic" | "audio" | "pan" | "tool";

type Site = {
  key: string;
  name: string;
  type: number;
  supported: boolean;
  runtime: string;
  capabilities: SourceCapabilities;
  quality?: SourceQuality;
  reason?: string;
  hide?: number;
  filterable?: number;
  contentType?: SiteContentType;
  runtimeGroup?: string;
  originKey?: string;
  replacement?: {
    id: string;
    runtime: string;
    sourceName: string;
    repository?: string;
    license?: string;
    verifiedAt?: string;
    notes?: string;
  };
  categories?: SourceCategory[];
};

type Episode = { name: string; url: string; desc?: string; index?: number };
type Flag = { flag: string; show?: string; episodes: Episode[] };
type Vod = {
  vodId: string;
  vodName: string;
  vodTag?: "file" | "folder" | "action" | string;
  contentKind?: "playable" | "discovery" | "folder" | "action" | "live";
  vodPic?: string;
  vodRemarks?: string;
  vodYear?: string;
  vodArea?: string;
  vodDirector?: string;
  vodActor?: string;
  vodContent?: string;
  typeName?: string;
  siteKey?: string;
  siteName?: string;
  configName?: string;
  flags?: Flag[];
};

type ConfigRecord = { id?: number; name: string; url: string; enabled: boolean; updatedAt: number };
type HistoryRecord = {
  siteKey: string;
  vodId: string;
  vodName: string;
  episodeName: string;
  episodeUrl: string;
  flag?: string;
  position: number;
  duration: number;
  updatedAt: number;
};
type FavoriteRecord = {
  siteKey: string;
  vodId: string;
  vodName: string;
  vodPic?: string;
  createdAt: number;
};
type PlaybackProgress = { position: number; duration: number; completed: boolean };
type CompatibilityPlaybackFailure = { progress: PlaybackProgress; reason: string };
type AppInfo = {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  desktopPlatform?: "mac" | "windows" | "linux";
  usesMacTrafficLights?: boolean;
  supportsExternalIina?: boolean;
  playerBackend?: "mpv-ipc" | "native-libmpv" | "unavailable";
  nativeLibmpvPreferenceEnabled?: boolean;
  nativeLibmpv?: { available?: boolean; reason?: string; addonPath?: string; libraryPath?: string; buildInfo?: { linkedLibmpv?: boolean; renderReady?: boolean; renderApiAvailable?: boolean; platform?: string; api?: string; libmpvPath?: string; libmpvError?: string; clientApiVersion?: number } };
  arch: string;
};
type SearchStatus = { siteKey: string; siteName: string; configName?: string; state: "success" | "error"; count: number; page?: number; pageCount?: number; hasMore?: boolean; message?: string };
type RendererPlaybackFailure = Error & {
  code?: string;
  userMessage?: string;
  retryable?: boolean;
  sourceImpact?: "none" | "degraded" | "blocked";
};
type IncrementalSearchPayload = {
  requestId: string;
  type: "source" | "complete" | "error";
  list?: Vod[];
  status?: SearchStatus;
  page?: number;
  completed?: number;
  total?: number;
  hasMore?: boolean;
  message?: string;
};
type SourceAuditStatus = {
  running: boolean;
  total: number;
  completed: number;
  healthy: number;
  unknown: number;
  degraded: number;
  blocked: number;
  skipped: number;
  currentSiteKey?: string;
  currentSiteName?: string;
  startedAt?: number;
  finishedAt?: number;
};
type PlayingState = {
  sessionId: string;
  playbackUrl: string;
  format: string;
  engine: "web" | "mpv";
  resolvedBy: string;
  subtitleUrl?: string;
  danmakuUrl?: string;
  contentKind?: "vod" | "live";
  flag: string;
  title: string;
  episode: string;
  siteKey: string;
  vodId: string;
  episodeUrl: string;
  startPosition?: number;
  attemptedFlags: string[];
};
type Page = "home" | "library" | "search" | "favorites" | "history" | "sources" | "accounts" | "settings" | "detail";
type FolderTrailItem = { siteKey: string; folderId: string; title: string };
type FolderSortMode = "default" | "name-asc" | "name-desc" | "type";
type SearchGroup = { key: string; primary: Vod; items: Vod[] };
type SearchTargetSelection = { includeSiteKeys?: string[]; excludeSiteKeys?: string[]; maxSources?: number };
type SourceQuickGroup = "all" | "favorite" | "recent" | "4k" | "quick" | "collect";
type SourceDisplayGroup = Exclude<SourceQuickGroup, "all" | "favorite" | "recent"> | "other";
type SourcePickerGroup = { key: string; label: string; items: Site[] };
type CatVodRemoteAccessPolicy = "allow" | "block-startup";
type CatVodUpdateStrategy = "notify" | "download-candidate" | "auto-activate";
type CatVodRemoteAccessRecord = {
  origin: string;
  method: string;
  phase: "startup";
  blocked: boolean;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
};
type PanProviderId = "quark" | "uc" | "baidu" | "pan115" | "pan189" | "pan139";
type PanLoginProviderId = "quark" | "ucCookie" | "ucToken" | "baidu" | "pan115" | "pan189" | "pan139";
type PanAccountState = "connected" | "expired" | "not-configured" | "unavailable";
type PanCredentialMode = "cookie" | "tv-token" | "scan" | "account-password" | "unknown";
type PanProviderStatus = {
  provider: PanProviderId;
  name: string;
  configured: boolean;
  login: boolean;
  accountState: PanAccountState;
  credentialMode: PanCredentialMode;
  state: string;
  label: string;
  checkedAt: number;
};
type PanLoginOption = { provider: PanLoginProviderId; label: string };
type PanProviderDefinition = {
  id: PanProviderId;
  name: string;
  shortName: string;
  appName: string;
  description: string;
  loginOptions: PanLoginOption[];
};
type PendingPanPlayback = {
  item: Vod;
  flag: string;
  episode: Episode;
  startPosition: number;
};
type PendingPanFolder = { item: Vod; trail: FolderTrailItem[] };
type PendingSourceImport = {
  source: string;
  name: string;
  catVodBundle: boolean;
  previousActiveSite: string;
};
type PlaybackEnginePreference = { engine: "compatibility"; updatedAt: number };
type ExternalPlayerPreference = "iina" | "vlc" | "system";
type ThemeMode = "system" | "dark" | "light";
type StorageRecoveryNotice = { state: "restored-backup" | "reset-empty"; message: string; archivedPath?: string; backupPath?: string; recoveredAt?: number };
type PanLoginResult = {
  provider: PanLoginProviderId;
  taskId?: string;
  status: "waiting" | "success" | "expired" | "error" | "cancelled";
  terminal: boolean;
  message: string;
  qrImage?: string;
};
type CatVodStatus = {
  state: "stopped" | "starting" | "running" | "error";
  sourceMd5Url: string;
  port?: number;
  baseUrl?: string;
  versionMd5?: string;
  candidateMd5?: string;
  previousMd5?: string;
  siteCount?: number;
  message?: string;
  remoteAccessPolicy?: CatVodRemoteAccessPolicy;
  remoteAccesses?: CatVodRemoteAccessRecord[];
};

declare global {
  interface Window {
    tvApi: any;
  }
}

const PAN_PROVIDER_DEFINITIONS: readonly PanProviderDefinition[] = [
  { id: "quark", name: "夸克网盘", shortName: "夸", appName: "夸克 App", description: "用于播放夸克分享、极速和原画线路。", loginOptions: [{ provider: "quark", label: "扫码登录" }] },
  { id: "uc", name: "UC 网盘", shortName: "UC", appName: "UC 浏览器", description: "支持 UC 分享线路，可选择 Cookie 或 TV Token 登录。", loginOptions: [{ provider: "ucCookie", label: "扫码 Cookie" }, { provider: "ucToken", label: "扫码 TV Token" }] },
  { id: "baidu", name: "百度网盘", shortName: "百", appName: "百度网盘 App", description: "用于解析和播放百度网盘分享内容。", loginOptions: [{ provider: "baidu", label: "扫码登录" }] },
  { id: "pan115", name: "115 网盘", shortName: "115", appName: "115 App", description: "用于播放 115 分享和已授权的网盘线路。", loginOptions: [{ provider: "pan115", label: "扫码登录" }] },
  { id: "pan189", name: "天翼云盘", shortName: "天", appName: "天翼云盘 App", description: "用于播放天翼云盘分享和转码线路。", loginOptions: [{ provider: "pan189", label: "扫码登录" }] },
  { id: "pan139", name: "移动云盘", shortName: "移", appName: "移动云盘 App", description: "用于播放中国移动云盘分享内容。", loginOptions: [{ provider: "pan139", label: "扫码登录" }] },
];

const page = ref<Page>("home");
const previousPage = ref<Page>("home");
const sites = ref<Site[]>([]);
const configs = ref<ConfigRecord[]>([]);
const activeSite = ref("");
const configName = ref("");
const configUrl = ref("");
const keyword = ref("");
const searchTitle = ref("搜索");
const results = ref<Vod[]>([]);
const searchStatuses = ref<SearchStatus[]>([]);
const folderTrail = ref<FolderTrailItem[]>([]);
const folderPage = ref(1);
const folderHasMore = ref(false);
const folderLoadingMore = ref(false);
const folderQuery = ref("");
const folderSort = ref<FolderSortMode>("default");
const searchPage = ref(1);
const searchHasMore = ref(false);
const searchLoadingMore = ref(false);
const searchProgress = ref({ running: false, completed: 0, total: 0 });
const recoveryCandidate = ref<{ vodName: string } | null>(null);
const homeItems = ref<Vod[]>([]);
const homeRecommendations = ref<Vod[]>([]);
const homeMovieSourceItems = ref<Vod[]>([]);
const homeTvSourceItems = ref<Vod[]>([]);
const brokenImageUrls = ref<Set<string>>(new Set());
const heroIndex = ref(0);
const heroHovered = ref(false);
const heroWindowFocused = ref(true);
const homeCarouselEnabled = ref(true);
const libraryItems = ref<Vod[]>([]);
const libraryCategory = ref("all");
const libraryFilters = ref<Record<string, string>>({});
const libraryFiltersByCategory = ref<Record<string, SourceFilterGroup[]>>({});
const libraryPage = ref(1);
const libraryPageCount = ref(1);
const libraryArea = ref("全部");
const libraryYear = ref("全部");
const librarySort = ref<LibrarySortMode>("来源默认");
const libraryLoading = ref(false);
const searchCategory = ref("全部");
const searchScope = ref<SearchScopePreference>("smart");
const searchExpandedToAllSources = ref(false);
const smartInitialSearchSiteKeys = ref<string[]>([]);
const recentSearches = ref<string[]>([]);
const showSourceImport = ref(false);
const sourcePickerOpen = ref(false);
const sourcePickerQuery = ref("");
const sourcePickerFilter = ref<SourceQuickGroup>("all");
const sourcePageQuery = ref("");
const sourcePageFilter = ref<SourceQuickGroup>("all");
const recentSourceKeys = ref<string[]>([]);
const favoriteSourceKeys = ref<string[]>([]);
const selected = ref<Vod | null>(null);
const selectedFlag = ref("");
const loading = ref(false);
const homeLoading = ref(false);
const error = ref<RendererErrorPresentation | string>("");
const errorTechnicalOpen = ref(false);
const histories = ref<HistoryRecord[]>([]);
const favorites = ref<FavoriteRecord[]>([]);
const playing = ref<PlayingState | null>(null);
const latestPlaybackProgress = ref<PlaybackProgress>({ position: 0, duration: 0, completed: false });
const paused = ref(false);
const checkingSite = ref("");
const healthResults = ref<Record<string, string>>({});
const sourceAuditStatus = ref<SourceAuditStatus>({ running: false, total: 0, completed: 0, healthy: 0, unknown: 0, degraded: 0, blocked: 0, skipped: 0 });
const sniffing = ref(false);
const playbackStatus = ref("");
const externalFallbackSessionId = ref("");
const externalFallbackLoading = ref<ExternalPlayerPreference | "">("");
const externalPlayerPreference = ref<ExternalPlayerPreference>("system");
let playbackRequestId = 0;
const defaultSpeed = ref(1);
const danmakuSettings = ref<DanmakuPresentationSettings>({ ...DEFAULT_DANMAKU_SETTINGS });
const subtitleSettings = ref<SubtitlePresentationSettings>({ ...DEFAULT_SUBTITLE_SETTINGS });
const danmakuBlockedWordsText = ref("");
const storageRecoveryNotice = ref<StorageRecoveryNotice | null>(null);
const linePreference = ref<PlaybackLinePreference>("stable");
const autoFallbackLine = ref(true);
const compatibilityFallbackMode = ref<CompatibilityFallbackMode>("automatic");
const playbackMode = ref<PlaybackMode>("auto");
const nativeLibmpvEnabled = ref(true);
const playbackEnginePreferences = ref<Record<string, PlaybackEnginePreference>>({});
const webPlayerEngine = ref<WebPlayerEngine>("legacy");
const autoFallbackSource = ref(true);
const autoNextEpisode = ref(true);
const fontSize = ref<FontSizePreference>("standard");
const themeMode = ref<ThemeMode>("system");
const systemPrefersDark = ref(true);
const settingsSaved = ref(false);
const settingsSaving = ref(false);
const advancedSettingsOpen = ref(false);
const replacementRegistrySource = ref("");
const replacementRegistryCount = ref(0);
const replacementRegistryMessage = ref("");
const replacementRegistryLoading = ref(false);
const editingConfigUrl = ref("");
const editingConfigName = ref("");
const deletingConfigUrl = ref("");
const contentSourceMessage = ref("");
const pendingSourceImport = ref<PendingSourceImport | null>(null);
const appInfo = ref<AppInfo | null>(null);
const catVodStatus = ref<CatVodStatus | null>(null);
const catVodMd5Url = ref("https://9280.kstore.vip/cat/index.js.md5");
const catVodRemoteAccessPolicy = ref<CatVodRemoteAccessPolicy>("allow");
const catVodUpdateStrategy = ref<CatVodUpdateStrategy>("notify");
const catVodMessage = ref("");
const catVodLoading = ref(false);
const panStatuses = ref<Partial<Record<PanProviderId, PanProviderStatus>>>({});
const activePanProvider = ref<PanProviderId>("quark");
const activePanLoginProvider = ref<PanLoginProviderId>("quark");
const panStatusLoading = ref(false);
const panAccountMessage = ref("");
const panLoginOpen = ref(false);
const panLoginLoading = ref(false);
const panLoginTaskId = ref("");
const panLoginQrImage = ref("");
const panLoginState = ref<PanLoginResult["status"]>("waiting");
const panLoginMessage = ref("");
const nativeHlsSupported = detectNativeHlsSupport();
let sourceAuditTimer: ReturnType<typeof window.setTimeout> | undefined;
let removeCatVodHostEvent: (() => void) | undefined;
let removeIncrementalSearchEvent: (() => void) | undefined;
let activeIncrementalSearchRequestId = "";
let incrementalSearchStatusMode: "replace" | "accumulate" = "replace";
let incrementalSearchBatch: "smart-initial" | "expanded" | "pagination" = "expanded";
let panLoginTimer: ReturnType<typeof window.setTimeout> | undefined;
let heroRotationTimer: ReturnType<typeof window.setTimeout> | undefined;
let heroManualPauseUntil = 0;
let homeLoadRequestId = 0;
const homeLoadedSiteKey = ref("");
const pendingPanPlayback = ref<PendingPanPlayback | null>(null);
const pendingPanFolder = ref<PendingPanFolder | null>(null);
let themeMediaQuery: MediaQueryList | undefined;
let restoringInitialSite = true;

const activePanDefinition = computed(() => PAN_PROVIDER_DEFINITIONS.find((provider) => provider.id === activePanProvider.value) ?? PAN_PROVIDER_DEFINITIONS[0]!);
const activePanStatus = computed(() => panStatuses.value[activePanProvider.value]);
const supportedSites = computed(() => sites.value.filter((site) => site.supported));
const selectableSites = computed(() => sortSourcesByQuality(
  supportedSites.value.filter((site) => site.hide !== 1 && !["tool", "live", "comic", "audio", "discovery"].includes(site.contentType ?? "")),
  { activeSiteKey: activeSite.value, favoriteSiteKeys: favoriteSourceKeys.value, recentSiteKeys: recentSourceKeys.value },
  "browse",
));
const unsupportedSites = computed(() => sites.value.filter((site) => !site.supported));
const activeSiteRecord = computed(() => sites.value.find((site) => site.key === activeSite.value));
const activeSiteName = computed(() => activeSiteRecord.value?.name ?? "暂无可用内容来源");
const rawLibraryCategories = computed(() => activeSiteRecord.value?.categories ?? []);
const libraryCategories = computed(() => buildLibraryCategoryGroups(rawLibraryCategories.value));
const selectedLibraryCategory = computed(() => libraryCategories.value.find((category) => category.id === libraryCategory.value) ?? libraryCategories.value[0]);
const continueIdentitySet = computed(() => new Set(histories.value.map((item) => `${item.siteKey}\u0000${item.vodId}`)));
const hero = computed(() => homeRecommendations.value[heroIndex.value] ?? homeRecommendations.value[0] ?? null);
const heroIdentitySet = computed(() => new Set(homeRecommendations.value.map(homeItemIdentity)));
const homeMovieItems = computed(() => homeMovieSourceItems.value.length
  ? homeMovieSourceItems.value
  : selectHomeSection(homeItems.value, "movie", new Set([...continueIdentitySet.value, ...heroIdentitySet.value]), 6));
const homeTvItems = computed(() => homeTvSourceItems.value.length
  ? homeTvSourceItems.value
  : selectHomeSection(homeItems.value, "tv", new Set([...continueIdentitySet.value, ...heroIdentitySet.value]), 6));
const homeWallItems = computed(() => [...homeMovieItems.value, ...homeTvItems.value]);
// A title may be available through several content sources, each with its own
// site key and vod id.  History deliberately keeps those records separate so
// that resuming can use the original playable URL, but the home shelf should
// represent the video rather than every source that supplied it.
function historyVideoIdentity(item: Pick<HistoryRecord, "vodName">): string {
  return item.vodName
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLocaleLowerCase("zh-CN");
}

const recentHistory = computed(() => {
  const videos = new Map<string, HistoryRecord>();
  for (const history of histories.value) {
    const identity = historyVideoIdentity(history) || `${history.siteKey}\u0000${history.vodId}`;
    if (!videos.has(identity)) videos.set(identity, history);
  }
  return [...videos.values()].slice(0, 4);
});
const continueItems = computed(() => recentHistory.value.map((history) => ({
  ...history,
  vodPic: homeItems.value.find((item) => item.siteKey === history.siteKey && item.vodId === history.vodId)?.vodPic
    ?? favorites.value.find((item) => item.siteKey === history.siteKey && item.vodId === history.vodId)?.vodPic,
})));
const activeLibraryFilterGroups = computed(() => {
  const sourceCategories = selectedLibraryCategory.value?.sourceCategories ?? [];
  if (sourceCategories.length !== 1) return [];
  return libraryFiltersByCategory.value[sourceCategories[0]!.id] ?? [];
});
const hasRemoteLibraryFilters = computed(() => activeLibraryFilterGroups.value.length > 0);
const libraryHasMore = computed(() => libraryPage.value < libraryPageCount.value);
const libraryAreas = computed(() => ["全部", ...new Set(libraryItems.value.map((item) => item.vodArea).filter(Boolean) as string[])].slice(0, 5));
const libraryYears = computed(() => ["全部", ...new Set(libraryItems.value.map((item) => item.vodYear).filter(Boolean) as string[])].slice(0, 5));
const visibleLibraryItems = computed(() => {
  const filtered = libraryItems.value.filter((item) => {
    if (!hasRemoteLibraryFilters.value && libraryArea.value !== "全部" && item.vodArea !== libraryArea.value) return false;
    if (!hasRemoteLibraryFilters.value && libraryYear.value !== "全部" && item.vodYear !== libraryYear.value) return false;
    return true;
  });
  return sortLibraryItems(filtered, librarySort.value);
});
const hotSearchTerms = computed(() => homeItems.value.slice(0, 4).map((item) => item.vodName));
const activeConfig = computed(() => configs.value.find((config) => config.enabled));
const catVodSourceSites = computed(() => selectableSites.value.filter((site) => site.key.startsWith("catvod:")));
const ordinarySourceSites = computed(() => selectableSites.value.filter((site) => !site.key.startsWith("catvod:")));
const activeSiteIsCatVod = computed(() => activeSite.value.startsWith("catvod:"));
const catVodSourceLabel = computed(() => inferCatVodSourceLabel(catVodStatus.value?.sourceMd5Url || catVodMd5Url.value));
const activeSourcePackageLabel = computed(() => activeSiteIsCatVod.value && catVodStatus.value?.state === "running"
  ? catVodSourceLabel.value
  : activeConfig.value?.name ?? (catVodStatus.value?.state === "running" ? catVodSourceLabel.value : "未选择配置"));
const activeSourcePackageSites = computed(() => activeSiteIsCatVod.value
  ? catVodSourceSites.value
  : ordinarySourceSites.value);
const activeSourcePackageSiteCount = computed(() => activeSourcePackageSites.value.length);
const firstCatVodSourceKey = computed(() => catVodSourceSites.value[0]?.key ?? "");
const otherConfigs = computed(() => configs.value.filter((config) => !config.enabled));
const visibleFolderItems = computed(() => {
  const query = folderQuery.value.trim().toLowerCase();
  const filtered = results.value.filter((item) => !query || `${item.vodName} ${item.vodRemarks ?? ""}`.toLowerCase().includes(query));
  return [...filtered].sort((left, right) => {
    const folderOrder = Number(isFolderItem(right)) - Number(isFolderItem(left));
    if (folderOrder !== 0) return folderOrder;
    if (folderSort.value === "name-asc") return left.vodName.localeCompare(right.vodName, "zh-CN");
    if (folderSort.value === "name-desc") return right.vodName.localeCompare(left.vodName, "zh-CN");
    if (folderSort.value === "type") return folderItemTypeLabel(left).localeCompare(folderItemTypeLabel(right), "zh-CN") || left.vodName.localeCompare(right.vodName, "zh-CN");
    return 0;
  });
});
const searchGroups = computed<SearchGroup[]>(() => folderTrail.value.length
  ? visibleFolderItems.value.map((item) => ({ key: `${item.siteKey ?? ""}\u0000${item.vodId}`, primary: item, items: [item] }))
  : groupNormalizedSearchResults(
    results.value.filter((item) => searchCategory.value === "全部" || !item.typeName || item.typeName.includes(searchCategory.value)),
  ));
const searchCategoryOptions = computed(() => {
  const values = new Set(results.value.map((item) => item.typeName).filter(Boolean) as string[]);
  return ["全部", ...values].slice(0, 6);
});
const isSelectedFavorite = computed(() => {
  if (!selected.value?.siteKey) return false;
  return favorites.value.some((item) => item.siteKey === selected.value?.siteKey && item.vodId === selected.value?.vodId);
});
const quickCategories = computed(() => [
  ...libraryCategories.value.filter((category) => !["all", "more"].includes(category.id)).slice(0, 5),
  { id: "__favorites__", name: "我的收藏", sourceCategories: [] },
]);
const favoriteSourceSites = computed(() => favoriteSourceKeys.value
  .map((key) => activeSourcePackageSites.value.find((site) => site.key === key))
  .filter((site): site is Site => site !== undefined));
const recentSourceSites = computed(() => recentSourceKeys.value
  .map((key) => activeSourcePackageSites.value.find((site) => site.key === key))
  .filter((site): site is Site => site !== undefined));
const sourcePageSites = computed(() => filterSourceSites(activeSourcePackageSites.value, sourcePageQuery.value, sourcePageFilter.value));
const sourcePickerGroups = computed<SourcePickerGroup[]>(() => buildSourcePickerGroups(
  activeSourcePackageSites.value,
  favoriteSourceSites.value,
  recentSourceSites.value,
  sourcePickerQuery.value,
  sourcePickerFilter.value,
));
const preferredPlaybackLine = computed(() => resolvePreferredPlaybackLine(selected.value?.flags, linePreference.value));
const activeLine = computed(() => selected.value?.flags?.find((line) => line.flag === selectedFlag.value) ?? preferredPlaybackLine.value ?? selected.value?.flags?.[0]);
const playingNavigation = computed(() => resolveEpisodeNavigation(selected.value?.flags, playing.value?.flag, playing.value?.episodeUrl));
const selectedHistory = computed(() => {
  const item = selected.value;
  if (!item?.siteKey) return undefined;
  return histories.value.find((history) => history.siteKey === item.siteKey && history.vodId === item.vodId);
});
const replacementSites = computed(() => sites.value.filter((site) => site.replacement));
const runtimeStats = computed<[string, number][]>(() => {
  const counts = new Map<string, number>();
  sites.value.forEach((site) => counts.set(site.runtime, (counts.get(site.runtime) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
});
const searchSuccessCount = computed(() => searchStatuses.value.filter((status) => status.state === "success").length);
const searchErrorCount = computed(() => searchStatuses.value.filter((status) => status.state === "error").length);
const displayedError = computed<RendererErrorPresentation | null>(() => {
  if (!error.value) return null;
  return typeof error.value === "string" ? presentRendererError(error.value, "generic", error.value) : error.value;
});
const searchEmptyState = computed(() => resolveSearchEmptyState({
  keyword: keyword.value,
  scope: searchScope.value,
  expandedToAllSources: searchExpandedToAllSources.value,
  statuses: searchStatuses.value,
}));
const sourceAuditProgress = computed(() => sourceAuditStatus.value.total > 0
  ? Math.round((sourceAuditStatus.value.completed / sourceAuditStatus.value.total) * 100)
  : 0);
const recommendedSourceCount = computed(() => selectableSites.value.filter((site) => isRecommendedSource(site)).length);
const sourceOverviewTitle = computed(() => {
  if (recommendedSourceCount.value > 0) return `${recommendedSourceCount.value} 个推荐源`;
  if (selectableSites.value.length > 0) return `${selectableSites.value.length} 个可尝试源`;
  return "暂无可用源";
});
const sourceOverviewSubtitle = computed(() => {
  if (sites.value.length === 0) return "尚未载入播放源";
  if (selectableSites.value.length === 0) return "当前没有桌面端可用来源";
  return `${selectableSites.value.length} 个桌面端可用来源`;
});
const fontSizeClass = computed(() => resolveFontSizeClass(fontSize.value));
const resolvedTheme = computed<"dark" | "light">(() => themeMode.value === "system"
  ? (systemPrefersDark.value ? "dark" : "light")
  : themeMode.value);
const themeClass = computed(() => `theme-${resolvedTheme.value}`);
const currentDesktopPlatform = computed(() => appInfo.value?.desktopPlatform ?? window.tvApi.desktopPlatform ?? "unknown");
const supportsExternalIina = computed(() => appInfo.value?.supportsExternalIina ?? currentDesktopPlatform.value === "mac");
const externalPlayerLabel = computed(() => externalPlayerPreference.value === "iina"
  ? "IINA"
  : externalPlayerPreference.value === "vlc"
    ? "VLC"
    : "系统播放器");
const heroHasImage = computed(() => hasUsableImage(hero.value?.vodPic));
const heroStyle = computed(() => heroHasImage.value && hero.value?.vodPic ? {
  backgroundImage: `linear-gradient(90deg, rgba(11,14,21,.98) 0%, rgba(11,14,21,.82) 42%, rgba(11,14,21,.18) 100%), url("${hero.value.vodPic}")`,
} : {
  backgroundImage: `linear-gradient(90deg, rgba(11,14,21,.96), rgba(11,14,21,.38)), radial-gradient(circle at 70% 30%, rgba(72,118,220,.45), transparent 35%)`,
});

const runtimeNames: Record<string, string> = {
  http: "HTTP",
  javascript: "JavaScript Spider",
  drpy: "Drpy 规则",
  t4: "T4 服务",
  appysv2: "AppYsV2 API",
  xbpq: "XBPQ 规则",
  xyq: "XYQ 规则",
  catopen: "CatOpen Spider",
  alist: "Alist",
  "catvod-node": "CatVod Node 服务",
  "android-dex": "Android Dex/JAR",
  unknown: "未知运行时",
};

const capabilityNames: Array<[keyof SourceCapabilities, string]> = [
  ["home", "首页"],
  ["category", "分类"],
  ["search", "搜索"],
  ["detail", "详情"],
  ["player", "播放"],
  ["proxy", "代理"],
  ["health", "检测"],
];

const pageTitles: Record<Page, string> = {
  home: "首页",
  library: "片库",
  search: "搜索",
  favorites: "我的收藏",
  history: "播放历史",
  sources: "内容来源",
  accounts: "账号与网盘",
  settings: "设置",
  detail: "影片详情",
};

function detectNativeHlsSupport(): boolean {
  const element = document.createElement("video");
  return Boolean(
    element.canPlayType("application/vnd.apple.mpegurl")
    || element.canPlayType("application/x-mpegURL"),
  );
}

function runtimeLabel(site: Site) {
  return runtimeNames[site.runtime] ?? site.runtime;
}

function capabilityLabel(site: Site) {
  return capabilityNames.filter(([key]) => site.capabilities[key]).map(([, label]) => label).join("、") || "无可用能力";
}

function formatDate(value: number) {
  if (!value) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
}

function panAccountStateLabel(status: PanProviderStatus | undefined): string {
  if (!status) return "尚未检查";
  if (status.accountState === "connected") return "已登录";
  if (status.accountState === "expired") return "登录已失效";
  if (status.accountState === "unavailable") return "状态检查失败";
  return "未登录";
}

function panCredentialModeLabel(status: PanProviderStatus | undefined): string {
  if (!status || status.credentialMode === "unknown") return "";
  if (status.credentialMode === "tv-token") return "TV Token";
  if (status.credentialMode === "cookie") return "Cookie";
  if (status.credentialMode === "account-password") return "账号密码";
  return "扫码授权";
}

function isSubtitleFolderItem(item: Vod): boolean {
  return /\.(?:srt|vtt|ass|ssa)(?:$|[?#])/i.test(`${item.vodName} ${item.vodId}`);
}

function folderItemTypeLabel(item: Vod): string {
  if (isFolderItem(item)) return "文件夹";
  const value = `${item.vodName} ${item.vodId}`.toLowerCase();
  if (isSubtitleFolderItem(item)) return "字幕";
  if (/\.(?:mp4|m4v|mkv|webm|mov|flv|m3u8|ts)(?:$|[?#])/.test(value)) return "视频";
  if (/\.(?:mp3|aac|m4a|flac|ogg)(?:$|[?#])/.test(value)) return "音频";
  return item.vodTag === "file" ? "文件" : "内容";
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "00:00";
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function progressPercent(item: HistoryRecord) {
  if (!item.duration || item.duration <= 0) return 0;
  return Math.min(100, Math.max(0, (item.position / item.duration) * 100));
}

function sourceDisplayGroup(site: Site): SourceDisplayGroup {
  const value = `${site.name} ${site.runtimeGroup ?? ""}`;
  if (/4k|uhd|超清/i.test(value)) return "4k";
  if (/秒播|秒开|直连|极速|闪电|量子|非凡|索尼/i.test(value)) return "quick";
  if (/采集|资源|影库|天堂|片库/i.test(value)) return "collect";
  return "other";
}

function sourceGroupLabel(group: SourceDisplayGroup): string {
  if (group === "4k") return "4K";
  if (group === "quick") return "秒播";
  if (group === "collect") return "采集";
  return "其他";
}

function sourceGroupIcon(site: Site): string {
  const group = sourceDisplayGroup(site);
  if (group === "4k") return "4K";
  if (group === "quick") return "秒";
  if (group === "collect") return "采";
  return "播";
}

function sourceDescription(site: Site): string {
  const group = sourceDisplayGroup(site);
  if (group === "4k") return "高质量影视资源";
  if (group === "quick") return "快速播放来源";
  if (group === "collect") return "综合影视采集";
  if (site.contentType === "pan") return "网盘影视来源";
  if (site.contentType === "short-drama") return "短剧内容来源";
  return "影视内容来源";
}

function isRecommendedSource(site: Site): boolean {
  const quality = site.quality;
  if (!quality) return false;
  if (quality.state === "healthy") return true;
  const lastMediaSuccessAt = Number(quality.lastMediaSuccessAt ?? 0);
  return lastMediaSuccessAt > Date.now() - 30 * 24 * 60 * 60 * 1_000;
}

function sourceStatusText(site: Site): string {
  if (activeSite.value === site.key) return "当前";
  if (!site.supported) return "不可用";
  if (site.quality?.state === "checking") return "检测中";
  if (isRecommendedSource(site)) return "推荐";
  return "可尝试";
}

function sourceStatusClass(site: Site): string {
  if (!site.supported) return "unavailable";
  if (site.quality?.state === "checking") return "checking";
  if (isRecommendedSource(site)) return "recommended";
  return "trial";
}

function filterSourceSites(values: Site[], query: string, filter: SourceQuickGroup): Site[] {
  const base = filter === "favorite" ? favoriteSourceSites.value : filter === "recent" ? recentSourceSites.value : values;
  const keyword = query.trim().toLowerCase();
  return base.filter((site) => {
    const group = sourceDisplayGroup(site);
    const matchesGroup = filter === "all" || filter === "favorite" || filter === "recent" || group === filter;
    const favoriteLabel = isSourceFavorite(site.key) ? "收藏来源" : "";
    const matchesKeyword = !keyword || `${site.name} ${sourceGroupLabel(group)} ${sourceDescription(site)} ${favoriteLabel}`.toLowerCase().includes(keyword);
    return matchesGroup && matchesKeyword;
  });
}

function buildSourcePickerGroups(values: Site[], favorite: Site[], recent: Site[], query: string, filter: SourceQuickGroup): SourcePickerGroup[] {
  if (filter === "favorite") {
    const items = filterSourceSites(values, query, filter);
    return items.length ? [{ key: "favorite", label: "收藏来源", items }] : [];
  }
  if (filter === "recent") {
    const items = filterSourceSites(values, query, filter);
    return items.length ? [{ key: "recent", label: "最近使用", items }] : [];
  }
  if (filter !== "all") {
    const items = filterSourceSites(values, query, filter);
    return items.length ? [{ key: filter, label: sourceGroupLabel(filter), items }] : [];
  }

  const keyword = query.trim().toLowerCase();
  const matchesQuery = (site: Site) => !keyword
    || `${site.name} ${sourceGroupLabel(sourceDisplayGroup(site))} ${sourceDescription(site)} ${isSourceFavorite(site.key) ? "收藏来源" : ""}`.toLowerCase().includes(keyword);
  const favoriteItems = favorite.filter(matchesQuery);
  const favoriteKeys = new Set(favoriteItems.map((site) => site.key));
  const recentItems = recent.filter((site) => !favoriteKeys.has(site.key) && matchesQuery(site));
  const recentKeys = new Set(recentItems.map((site) => site.key));
  const remaining = values.filter((site) => !favoriteKeys.has(site.key) && !recentKeys.has(site.key) && matchesQuery(site));
  const recommendedItems = remaining.slice(0, 6);
  const recommendedKeys = new Set(recommendedItems.map((site) => site.key));
  const groupedRemaining = remaining.filter((site) => !recommendedKeys.has(site.key));
  const groups: SourcePickerGroup[] = [];
  if (favoriteItems.length) groups.push({ key: "favorite", label: "收藏来源", items: favoriteItems });
  if (recentItems.length) groups.push({ key: "recent", label: "最近使用", items: recentItems });
  if (recommendedItems.length) groups.push({ key: "recommended", label: "推荐来源", items: recommendedItems });
  for (const key of ["4k", "quick", "collect", "other"] as SourceDisplayGroup[]) {
    const items = groupedRemaining.filter((site) => sourceDisplayGroup(site) === key);
    if (items.length) groups.push({ key, label: sourceGroupLabel(key), items });
  }
  return groups;
}

function rememberSource(siteKey: string): void {
  if (!siteKey) return;
  recentSourceKeys.value = [siteKey, ...recentSourceKeys.value.filter((key) => key !== siteKey)].slice(0, 8);
  void window.tvApi.setSetting("recentSiteKeys", [...recentSourceKeys.value]);
}

function isSourceFavorite(siteKey: string): boolean {
  return favoriteSourceKeys.value.includes(siteKey);
}

function toggleSourceFavorite(siteKey: string): void {
  if (!siteKey || !selectableSites.value.some((site) => site.key === siteKey)) return;
  favoriteSourceKeys.value = isSourceFavorite(siteKey)
    ? favoriteSourceKeys.value.filter((key) => key !== siteKey)
    : [siteKey, ...favoriteSourceKeys.value.filter((key) => key !== siteKey)].slice(0, 24);
  void window.tvApi.setSetting("favoriteSourceKeys", [...favoriteSourceKeys.value]);
}

function selectSource(siteKey: string): void {
  if (!selectableSites.value.some((site) => site.key === siteKey)) return;
  activeSite.value = siteKey;
  rememberSource(siteKey);
  sourcePickerOpen.value = false;
}

function toggleSourcePicker(force?: boolean): void {
  sourcePickerOpen.value = force ?? !sourcePickerOpen.value;
  if (!sourcePickerOpen.value) sourcePickerQuery.value = "";
}

function normalizedImageUrl(value?: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasUsableImage(value?: string): boolean {
  const url = normalizedImageUrl(value);
  return Boolean(url) && !brokenImageUrls.value.has(url);
}

function markImageBroken(value?: string): void {
  const url = normalizedImageUrl(value);
  if (!url || brokenImageUrls.value.has(url)) return;
  brokenImageUrls.value = new Set([...brokenImageUrls.value, url]);
}

function posterFallbackClass(title?: string): string {
  const value = title?.trim() || "影视";
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return `fallback-variant-${Math.abs(hash) % 6}`;
}

function resetHomeContent(): void {
  homeItems.value = [];
  homeRecommendations.value = [];
  homeMovieSourceItems.value = [];
  homeTvSourceItems.value = [];
  homeLoadedSiteKey.value = "";
  heroIndex.value = 0;
  clearHeroRotation();
}

function clearErrorState(): void {
  error.value = "";
  errorTechnicalOpen.value = false;
}

function showRendererError(value: unknown, context: RendererErrorContext, userMessage?: string): void {
  error.value = presentRendererError(value, context, userMessage);
  errorTechnicalOpen.value = false;
}

function showUserError(message: string, context: RendererErrorContext = "generic"): void {
  showRendererError(message, context, message);
}

function go(target: Page) {
  clearErrorState();
  selected.value = null;
  sourcePickerOpen.value = false;
  if (target !== "search") folderTrail.value = [];
  page.value = target;
  if (target === "history" || target === "favorites") void loadLibrary();
  if (target === "library") void loadSourceHome();
  if (target === "sources") void loadConfigs();
  if (target === "accounts") void refreshPanStatus();
}

function friendlyError(value: unknown): string {
  return presentRendererError(value, "generic").message;
}

function playbackFailureMessage(value: unknown): string {
  const failure = value as RendererPlaybackFailure;
  if (typeof failure?.userMessage === "string" && failure.userMessage.trim()) return failure.userMessage.trim();
  return friendlyError(value) || "播放失败，可以重试或更换线路。";
}

function playbackFailureAffectsSource(value: unknown): boolean {
  const impact = (value as RendererPlaybackFailure)?.sourceImpact;
  return impact === "degraded" || impact === "blocked";
}

function playbackNeedsPanLogin(value: unknown): boolean {
  const code = (value as RendererPlaybackFailure)?.code;
  return code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED";
}

function shouldPromptPanLoginBeforePlayback(status: PanProviderStatus | undefined): boolean {
  if (!status) return false;
  return status.accountState === "expired" || status.accountState === "not-configured";
}

function playbackAllowsLineFallback(value: unknown): boolean {
  const code = (value as RendererPlaybackFailure)?.code;
  return [
    "SOURCE_RESOLVE_FAILED",
    "MEDIA_URL_EXPIRED",
    "MEDIA_HEADER_REQUIRED",
    "RANGE_PROXY_FAILED",
    "LINE_UNAVAILABLE",
    "PREPARATION_TIMEOUT",
    "COMPAT_ENGINE_FAILED",
  ].includes(String(code));
}

function detectPanProviderFromContext(context: string): PanProviderId | undefined {
  if (/夸克|quark/i.test(context)) return "quark";
  if (/(?:^|\W)uc(?:\W|$)|UC\s*网盘|优视/i.test(context)) return "uc";
  if (/百度|baidu/i.test(context)) return "baidu";
  if (/(?:^|\D)115(?:\D|$)|115网盘/i.test(context)) return "pan115";
  if (/天翼|189网盘|cloud189/i.test(context)) return "pan189";
  if (/移动云盘|139网盘|和彩云|mcloud/i.test(context)) return "pan139";
  return undefined;
}

function detectPanPlaybackProvider(item: Vod, flag: string, episode: Episode): PanProviderId | undefined {
  return detectPanProviderFromContext(`${item.siteKey ?? ""} ${item.siteName ?? ""} ${flag} ${episode.name}`);
}

async function promptPanLoginBeforePlayback(
  provider: PanProviderId,
  item: Vod,
  flag: string,
  episode: Episode,
  startPosition: number,
): Promise<boolean> {
  // Status is normally refreshed only when the Accounts page is opened. Do
  // it here as well: otherwise a first-time UC/Quark selection has no cached
  // status and reaches the provider first, producing its raw "Cookie missing"
  // response instead of the QR code the user needs.
  if (!panStatuses.value[provider]) await refreshPanStatus();
  const status = panStatuses.value[provider];
  // Some CatVod provider builds expose login/start even when their aggregate
  // status endpoint is unavailable. For a recognised netdisk line, prefer the
  // QR flow in that unknown state to sending an unauthenticated play request.
  if (status?.login) return false;
  if (status && !shouldPromptPanLoginBeforePlayback(status) && status.accountState !== "unavailable") return false;
  pendingPanPlayback.value = {
    item: { ...item, flags: item.flags?.map((line) => ({ ...line, episodes: line.episodes.map((entry) => ({ ...entry })) })) },
    flag,
    episode: { ...episode },
    startPosition: Math.max(0, startPosition),
  };
  await startPanLogin(provider);
  return true;
}

async function clearExternalFallbackSession(): Promise<void> {
  const sessionId = externalFallbackSessionId.value;
  externalFallbackSessionId.value = "";
  externalFallbackLoading.value = "";
  if (sessionId) await window.tvApi.closePlayback(sessionId).catch(() => undefined);
}

async function openExternalPlayback(preference: ExternalPlayerPreference): Promise<void> {
  const sessionId = externalFallbackSessionId.value;
  if (!sessionId || externalFallbackLoading.value) return;
  externalFallbackLoading.value = preference;
  try {
    const result = await window.tvApi.openExternalPlayback(sessionId, preference);
    playbackStatus.value = `已使用${result?.player ?? "外部播放器"}打开当前媒体。`;
    clearErrorState();
    recoveryCandidate.value = null;
    await clearExternalFallbackSession();
  } catch (e) {
    showRendererError(e, "playback", playbackFailureMessage(e));
  } finally {
    externalFallbackLoading.value = "";
  }
}

async function dismissError(): Promise<void> {
  clearErrorState();
  recoveryCandidate.value = null;
  await clearExternalFallbackSession();
}

async function runErrorRecovery(): Promise<void> {
  const action = displayedError.value?.recoveryAction;
  if (!action) return;
  errorTechnicalOpen.value = false;
  switch (action) {
    case "retry-home":
      page.value = "home";
      await loadHome();
      return;
    case "retry-search":
      page.value = "search";
      if (keyword.value.trim()) await search();
      else clearErrorState();
      return;
    case "repair-sources":
      page.value = "sources";
      await refreshSourceStatus();
      return;
    case "retry-configs":
      page.value = "sources";
      clearErrorState();
      await Promise.all([refreshSites(), loadConfigs()]);
      await loadHome();
      return;
    case "retry-library":
      page.value = "library";
      if (libraryCategory.value === "all") await loadSourceHome();
      else await loadLibraryCategoryPage(1, false);
      return;
    case "retry-records":
      clearErrorState();
      await loadLibrary(false);
      return;
    case "retry-account":
      page.value = "accounts";
      await refreshPanStatus();
      return;
    case "back":
      clearErrorState();
      if (page.value === "detail") backFromDetail();
      else page.value = previousPage.value;
      return;
    default:
      return;
  }
}

function normalizeLabel(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["name", "label", "text", "value", "type_name"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return "";
}

function normalizeCategory(value: unknown): SourceCategory | null {
  if (typeof value === "string") {
    const label = value.trim();
    return label ? { id: label, name: label } : null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = normalizeLabel(record.id ?? record.type_id ?? record.value);
  const name = normalizeLabel(record.name ?? record.type_name ?? record.label ?? id);
  return id && name ? { id, name } : null;
}

function normalizeVod(item: Vod): Vod {
  return {
    ...item,
    vodName: normalizeLabel(item.vodName) || "未命名内容",
    typeName: normalizeLabel(item.typeName),
    vodYear: normalizeLabel(item.vodYear),
    vodArea: normalizeLabel(item.vodArea),
    vodRemarks: normalizeLabel(item.vodRemarks),
    siteName: normalizeLabel(item.siteName),
    configName: normalizeLabel(item.configName),
  };
}

function annotate(items: Vod[], siteKey = activeSite.value): Vod[] {
  const site = sites.value.find((item) => item.key === siteKey);
  return items.map((rawItem) => {
    const item = normalizeVod(rawItem);
    return {
      ...item,
      siteKey: item.siteKey ?? siteKey,
      siteName: item.siteName || site?.name,
    };
  });
}

async function refreshSites() {
  const loadedSites = await window.tvApi.listSites();
  sites.value = loadedSites.map((site: Site) => ({
    ...site,
    categories: (site.categories ?? []).map(normalizeCategory).filter((item): item is SourceCategory => item !== null),
  }));
  const current = sites.value.find((site) => site.key === activeSite.value);
  if (!current?.supported || current.hide === 1) {
    activeSite.value = selectableSites.value.find((site) => site.contentType === "vod")?.key
      ?? selectableSites.value[0]?.key
      ?? supportedSites.value[0]?.key
      ?? "";
  }
  if (sites.value.length > 0 && supportedSites.value.length === 0) {
    showUserError(`当前配置包含 ${sites.value.length} 个站点，但所有播放源都未通过兼容性或播放检测。`, "source");
  }
}

function homeRecommendationCacheKey(siteKey: string): string {
  return `fongmi-home-recommendations:${siteKey || "default"}`;
}

function cachedHomeRecommendationOrder(siteKey: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(homeRecommendationCacheKey(siteKey)) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function clearHeroRotation() {
  if (heroRotationTimer) window.clearTimeout(heroRotationTimer);
  heroRotationTimer = undefined;
}

function scheduleHeroRotation() {
  clearHeroRotation();
  if (!homeCarouselEnabled.value || homeRecommendations.value.length <= 1) return;
  heroRotationTimer = window.setTimeout(() => {
    const canRotate = page.value === "home"
      && !heroHovered.value
      && heroWindowFocused.value
      && Date.now() >= heroManualPauseUntil;
    if (canRotate) heroIndex.value = (heroIndex.value + 1) % homeRecommendations.value.length;
    scheduleHeroRotation();
  }, 6_000);
}

function updateHomeRecommendations(items: Vod[], siteKey: string) {
  const recommendations = selectHomeRecommendations(items, {
    limit: 8,
    excluded: continueIdentitySet.value,
    cachedOrder: cachedHomeRecommendationOrder(siteKey),
  });
  homeRecommendations.value = recommendations;
  heroIndex.value = Math.min(heroIndex.value, Math.max(0, recommendations.length - 1));
  try {
    window.localStorage.setItem(
      homeRecommendationCacheKey(siteKey),
      JSON.stringify(recommendations.map(homeItemIdentity)),
    );
  } catch {
    // localStorage may be unavailable in isolated test environments.
  }
  scheduleHeroRotation();
}

function selectHero(index: number, manual = true) {
  if (!homeRecommendations.value.length) return;
  heroIndex.value = (index + homeRecommendations.value.length) % homeRecommendations.value.length;
  if (manual) heroManualPauseUntil = Date.now() + 12_000;
  scheduleHeroRotation();
}

function moveHero(direction: -1 | 1) {
  selectHero(heroIndex.value + direction, true);
}

function setHeroHovered(value: boolean) {
  heroHovered.value = value;
  if (!value) scheduleHeroRotation();
}

function handleHeroWindowFocus() {
  heroWindowFocused.value = true;
  scheduleHeroRotation();
}

function handleHeroWindowBlur() {
  heroWindowFocused.value = false;
  clearHeroRotation();
}

async function loadHomeCategorySections(siteKey: string, categoriesValue: unknown, requestId: number) {
  const sourceCategories = Array.isArray(categoriesValue)
    ? categoriesValue.map(normalizeCategory).filter((item): item is SourceCategory => item !== null)
    : [];
  const groups = buildLibraryCategoryGroups(sourceCategories);
  const movieCategory = groups.find((group) => group.id === "movie")?.sourceCategories[0];
  const tvCategory = groups.find((group) => group.id === "tv")?.sourceCategories[0];
  const targets = [
    movieCategory ? { group: "movie" as const, category: movieCategory } : undefined,
    tvCategory ? { group: "tv" as const, category: tvCategory } : undefined,
  ].filter((item): item is { group: "movie" | "tv"; category: SourceCategory } => item !== undefined);

  homeMovieSourceItems.value = [];
  homeTvSourceItems.value = [];
  if (!siteKey || !targets.length) return;

  const results = await Promise.allSettled(targets.map(async (target) => ({
    group: target.group,
    response: await window.tvApi.category(siteKey, target.category.id, "1", {}),
  })));
  if (requestId !== homeLoadRequestId) return;
  const candidates: Record<"movie" | "tv", Vod[]> = { movie: [], tv: [] };
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    candidates[result.value.group] = dedupeLibraryItems(annotate(result.value.response?.list ?? [], siteKey))
      .map((item) => ({
        ...item,
        typeName: item.typeName || (result.value.group === "movie" ? "电影" : "电视剧"),
      }));
  }

  const featured: Vod[] = [];
  for (let index = 0; index < 4; index += 1) {
    if (candidates.movie[index]) featured.push(candidates.movie[index]!);
    if (candidates.tv[index]) featured.push(candidates.tv[index]!);
  }
  if (featured.length) updateHomeRecommendations([...featured, ...homeItems.value], siteKey);

  const excluded = new Set([...continueIdentitySet.value, ...heroIdentitySet.value]);
  homeMovieSourceItems.value = candidates.movie.filter((item) => !excluded.has(homeItemIdentity(item))).slice(0, 6);
  homeTvSourceItems.value = candidates.tv.filter((item) => !excluded.has(homeItemIdentity(item))).slice(0, 6);
}

async function loadHome(siteKey = activeSite.value) {
  const requestId = ++homeLoadRequestId;
  const requestedSiteKey = siteKey;
  resetHomeContent();
  if (!sites.value.length) {
    homeLoading.value = false;
    return;
  }

  homeLoading.value = true;
  clearErrorState();
  try {
    const response = requestedSiteKey
      ? await window.tvApi.home(requestedSiteKey)
      : window.tvApi.bestHome
        ? await window.tvApi.bestHome()
        : { siteKey: "", list: [] };
    if (requestId !== homeLoadRequestId) return;
    const resolvedSiteKey = response?.siteKey || requestedSiteKey;
    homeLoadedSiteKey.value = resolvedSiteKey;
    homeItems.value = dedupeLibraryItems(annotate(response?.list ?? [], resolvedSiteKey));
    updateHomeRecommendations(homeItems.value, resolvedSiteKey);
    void loadHomeCategorySections(resolvedSiteKey, response?.categories, requestId);
    if (!homeItems.value.length && response?.message) showUserError(response.message, "home");
  } catch (e) {
    if (requestId !== homeLoadRequestId) return;
    resetHomeContent();
    showRendererError(e, "home");
  } finally {
    if (requestId === homeLoadRequestId) homeLoading.value = false;
  }
}

async function loadConfigs() {
  configs.value = await window.tvApi.listConfigs();
}

async function checkSiteHealth(site: Site) {
  checkingSite.value = site.key;
  healthResults.value[site.key] = "正在检测首页、详情和播放链路…";
  try {
    const result = await window.tvApi.checkSiteHealth(site.key);
    healthResults.value[site.key] = `${result.message}${result.latencyMs ? ` · ${result.latencyMs} ms` : ""}`;
    await refreshSites();
  } catch (e) {
    healthResults.value[site.key] = friendlyError(e);
  } finally {
    checkingSite.value = "";
  }
}

function stopSourceAuditPolling() {
  if (sourceAuditTimer !== undefined) window.clearTimeout(sourceAuditTimer);
  sourceAuditTimer = undefined;
}

async function pollSourceAudit() {
  if (!window.tvApi.getSourceAuditStatus) return;
  sourceAuditStatus.value = await window.tvApi.getSourceAuditStatus();
  await refreshSites();
  if (sourceAuditStatus.value.running) {
    sourceAuditTimer = window.setTimeout(() => void pollSourceAudit(), 1800);
  } else {
    stopSourceAuditPolling();
    await loadHome();
  }
}

async function startSourceAudit(force = false) {
  if (!window.tvApi.startSourceAudit || !sites.value.length) return;
  stopSourceAuditPolling();
  sourceAuditStatus.value = await window.tvApi.startSourceAudit(force);
  await refreshSites();
  if (sourceAuditStatus.value.running) {
    sourceAuditTimer = window.setTimeout(() => void pollSourceAudit(), 800);
  }
}

function sourceImportLabel(request: PendingSourceImport): string {
  return request.catVodBundle ? inferCatVodSourceLabel(request.source) : request.name;
}

function resetSourceSelectionFilters(): void {
  sourcePickerFilter.value = "all";
  sourcePickerQuery.value = "";
  sourcePageFilter.value = "all";
  sourcePageQuery.value = "";
}

async function applySourceImport(request: PendingSourceImport): Promise<void> {
  loading.value = true;
  clearErrorState();
  try {
    if (request.catVodBundle) {
      catVodMd5Url.value = request.source;
      catVodStatus.value = await window.tvApi.startCatVod(request.source, catVodRemoteAccessPolicy.value);
    } else {
      await window.tvApi.loadConfig(request.source, request.name);
    }
    await Promise.all([refreshSites(), loadConfigs()]);
    const importedSiteKey = request.catVodBundle
      ? selectCatVodSiteAfterImport(catVodSourceSites.value.map((site) => site.key), request.previousActiveSite)
      : selectConfigSiteAfterImport(ordinarySourceSites.value.map((site) => site.key), request.previousActiveSite);
    if (importedSiteKey) {
      activeSite.value = importedSiteKey;
      rememberSource(importedSiteKey);
    }
    resetSourceSelectionFilters();
    const importedPackageLabel = sourceImportLabel(request);
    contentSourceMessage.value = importedSiteKey
      ? `已启用 ${importedPackageLabel}，当前播放源为 ${activeSiteRecord.value?.name ?? "首个可用来源"}`
      : `已启用 ${importedPackageLabel}，但没有发现可用影视来源`;
    await loadHome(activeSite.value);
    void startSourceAudit(false);
    page.value = "home";
  } catch (e) {
    showRendererError(e, request.catVodBundle ? "catvod" : "config");
  } finally {
    loading.value = false;
  }
}

async function applyPendingSourceImport(): Promise<void> {
  const request = pendingSourceImport.value;
  if (!request || playing.value) return;
  pendingSourceImport.value = null;
  await applySourceImport(request);
}

function cancelPendingSourceImport(): void {
  if (!pendingSourceImport.value) return;
  const label = sourceImportLabel(pendingSourceImport.value);
  pendingSourceImport.value = null;
  contentSourceMessage.value = `已取消切换到 ${label}`;
}

async function loadConfig(source = configUrl.value.trim(), name = configName.value.trim() || inferConfigName(source)) {
  if (!source) return;
  const request: PendingSourceImport = {
    source,
    name,
    catVodBundle: isCatVodBundleSource(source),
    previousActiveSite: activeSite.value,
  };
  configUrl.value = "";
  configName.value = "";
  if (playing.value) {
    pendingSourceImport.value = request;
    contentSourceMessage.value = `${sourceImportLabel(request)} 已加入切换队列，当前视频关闭或播放完成后自动启用`;
    return;
  }
  pendingSourceImport.value = null;
  await applySourceImport(request);
}

async function activateConfig(config: ConfigRecord) {
  await loadConfig(config.url, config.name);
}

function beginRenameConfig(config: ConfigRecord) {
  editingConfigUrl.value = config.url;
  editingConfigName.value = config.name;
  deletingConfigUrl.value = "";
}

function cancelRenameConfig() {
  editingConfigUrl.value = "";
  editingConfigName.value = "";
}

async function saveConfigName(config: ConfigRecord) {
  const name = editingConfigName.value.trim();
  if (!name) return;
  await window.tvApi.renameConfig(config.url, name);
  cancelRenameConfig();
  await loadConfigs();
}

async function deleteConfig(config: ConfigRecord) {
  if (deletingConfigUrl.value !== config.url) {
    deletingConfigUrl.value = config.url;
    editingConfigUrl.value = "";
    return;
  }
  await window.tvApi.deleteConfig(config.url);
  deletingConfigUrl.value = "";
  await Promise.all([loadConfigs(), refreshSites()]);
  await loadHome();
}

function cancelActiveIncrementalSearch(): void {
  if (activeIncrementalSearchRequestId && window.tvApi.cancelIncrementalSearch) {
    window.tvApi.cancelIncrementalSearch(activeIncrementalSearchRequestId);
  }
  activeIncrementalSearchRequestId = "";
  searchLoadingMore.value = false;
  searchProgress.value = { running: false, completed: 0, total: 0 };
}

function mergeIncrementalSearchStatus(status: SearchStatus): void {
  const index = searchStatuses.value.findIndex((item) => item.siteKey === status.siteKey);
  if (index < 0) {
    searchStatuses.value = [...searchStatuses.value, status];
    return;
  }
  const current = searchStatuses.value[index]!;
  const next = incrementalSearchStatusMode === "accumulate"
    ? { ...current, ...status, count: current.count + Number(status.count ?? 0) }
    : status;
  searchStatuses.value = searchStatuses.value.map((item, itemIndex) => itemIndex === index ? next : item);
}

function handleIncrementalSearchEvent(payload: unknown): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
  const event = payload as IncrementalSearchPayload;
  if (!event.requestId || event.requestId !== activeIncrementalSearchRequestId) return;

  if (event.type === "source") {
    const incoming = (event.list ?? []).map(normalizeVod);
    const existing = new Set(results.value.map(searchResultIdentity));
    results.value = [...results.value, ...incoming.filter((item) => !existing.has(searchResultIdentity(item)))];
    if (event.status) mergeIncrementalSearchStatus(event.status);
    searchProgress.value = {
      running: true,
      completed: Math.max(0, Number(event.completed ?? 0)),
      total: Math.max(0, Number(event.total ?? 0)),
    };
    searchHasMore.value ||= Boolean(event.hasMore || event.status?.hasMore);
    searchPage.value = Math.max(1, Number(event.page ?? searchPage.value) || 1);
    page.value = "search";
    return;
  }

  if (event.type === "complete") {
    searchHasMore.value = Boolean(event.hasMore);
    searchProgress.value = {
      running: false,
      completed: Math.max(0, Number(event.completed ?? searchStatuses.value.length)),
      total: Math.max(0, Number(event.total ?? searchStatuses.value.length)),
    };
    if (incrementalSearchBatch === "smart-initial") {
      smartInitialSearchSiteKeys.value = searchStatuses.value
        .map((status) => status.siteKey)
        .filter((siteKey) => siteKey && !siteKey.startsWith("config:"));
    }
    searchLoadingMore.value = false;
    activeIncrementalSearchRequestId = "";
    return;
  }

  showRendererError(event.message ?? "搜索更多来源失败", "search");
  searchLoadingMore.value = false;
  searchProgress.value = { running: false, completed: 0, total: 0 };
  activeIncrementalSearchRequestId = "";
}

function startIncrementalSearchPage(
  pageNumber: number,
  statusMode: "replace" | "accumulate",
  selection?: SearchTargetSelection,
  batch: "smart-initial" | "expanded" | "pagination" = "expanded",
): boolean {
  const value = keyword.value.trim();
  if (!value || !window.tvApi.startIncrementalSearch) return false;
  cancelActiveIncrementalSearch();
  activeIncrementalSearchRequestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  incrementalSearchStatusMode = statusMode;
  incrementalSearchBatch = batch;
  if (statusMode === "replace") searchStatuses.value = [];
  searchLoadingMore.value = true;
  searchHasMore.value = false;
  searchPage.value = pageNumber;
  searchProgress.value = { running: true, completed: 0, total: 0 };
  window.tvApi.startIncrementalSearch(activeIncrementalSearchRequestId, value, undefined, "all-configs", pageNumber, selection);
  return true;
}

async function search() {
  await searchWithTargetSelection();
}

async function searchWithTargetSelection(selectionOverride?: SearchTargetSelection) {
  const value = keyword.value.trim();
  folderTrail.value = [];
  cancelActiveIncrementalSearch();
  if (!value) {
    page.value = "search";
    return;
  }
  results.value = [];
  searchStatuses.value = [];
  smartInitialSearchSiteKeys.value = [];
  searchPage.value = 1;
  searchHasMore.value = false;
  searchExpandedToAllSources.value = false;
  searchCategory.value = "全部";
  recoveryCandidate.value = null;
  recentSearches.value = [value, ...recentSearches.value.filter((item) => item !== value)].slice(0, 5);
  window.localStorage.setItem("fongmi-recent-searches", JSON.stringify(recentSearches.value));

  if (searchScope.value === "smart") {
    const selection: SearchTargetSelection = selectionOverride ?? { maxSources: 6 };
    if (startIncrementalSearchPage(1, "replace", selection, "smart-initial")) return;
    const completed = await runSearchPage(1, false, "all-configs", false, selection);
    if (completed) {
      smartInitialSearchSiteKeys.value = searchStatuses.value
        .map((status) => status.siteKey)
        .filter((siteKey) => siteKey && !siteKey.startsWith("config:"));
    }
    return;
  }

  const backendScope = resolveInitialSearchBackend(searchScope.value, activeSite.value);
  await runSearchPage(1, false, backendScope);
}

async function runSearchPage(
  pageNumber: number,
  append: boolean,
  backendScope: SearchBackendScope,
  replaceStatuses = false,
  selection?: SearchTargetSelection,
): Promise<boolean> {
  const value = keyword.value.trim();
  if (!value) return false;
  if (append) searchLoadingMore.value = true;
  else loading.value = true;
  clearErrorState();
  selected.value = null;
  searchTitle.value = `“${value}”的搜索结果`;
  try {
    const scopedSite = backendScope === "current-site" ? activeSite.value || undefined : undefined;
    const response = window.tvApi.searchDetailed
      ? await window.tvApi.searchDetailed(value, scopedSite, backendScope, pageNumber, selection)
      : { list: await window.tvApi.search(value, scopedSite, backendScope, pageNumber, selection), statuses: [], page: pageNumber, hasMore: false };
    const incoming = (response.list ?? []).map(normalizeVod);
    if (append) {
      const existing = new Set(results.value.map(searchResultIdentity));
      results.value = [...results.value, ...incoming.filter((item) => !existing.has(searchResultIdentity(item)))];
      if (replaceStatuses) {
        searchStatuses.value = response.statuses ?? [];
      } else {
        const merged = new Map(searchStatuses.value.map((status) => [status.siteKey, status] as const));
        for (const status of response.statuses ?? []) {
          const current = merged.get(status.siteKey);
          merged.set(status.siteKey, current
            ? { ...current, ...status, count: current.count + Number(status.count ?? 0) }
            : status);
        }
        searchStatuses.value = [...merged.values()];
      }
    } else {
      results.value = incoming;
      searchStatuses.value = response.statuses ?? [];
    }
    searchPage.value = Number(response.page ?? pageNumber) || pageNumber;
    searchHasMore.value = Boolean(response.hasMore);
    page.value = "search";
    return true;
  } catch (e) {
    if (!append) {
      results.value = [];
      searchStatuses.value = [];
    }
    showRendererError(e, "search");
    return false;
  } finally {
    if (append) searchLoadingMore.value = false;
    else loading.value = false;
  }
}

async function searchMoreSources() {
  if (searchScope.value !== "smart" || searchExpandedToAllSources.value || searchLoadingMore.value || loading.value) return;
  const excludeSiteKeys = smartInitialSearchSiteKeys.value.length
    ? [...smartInitialSearchSiteKeys.value]
    : searchStatuses.value.map((status) => status.siteKey).filter((siteKey) => siteKey && !siteKey.startsWith("config:"));
  const selection: SearchTargetSelection = { excludeSiteKeys };
  searchExpandedToAllSources.value = true;
  if (startIncrementalSearchPage(1, "accumulate", selection, "expanded")) return;
  const completed = await runSearchPage(1, true, "all-configs", false, selection);
  if (!completed) searchExpandedToAllSources.value = false;
}

async function loadMoreSearch() {
  if (!searchHasMore.value || searchLoadingMore.value || loading.value) return;
  if (searchScope.value === "current") {
    await runSearchPage(searchPage.value + 1, true, "current-site");
    return;
  }
  const selection: SearchTargetSelection | undefined = searchExpandedToAllSources.value
    ? undefined
    : { includeSiteKeys: [...smartInitialSearchSiteKeys.value] };
  if (startIncrementalSearchPage(searchPage.value + 1, "accumulate", selection, "pagination")) return;
  await runSearchPage(searchPage.value + 1, true, "all-configs", false, selection);
}

async function searchAlternativeSources() {
  const candidate = recoveryCandidate.value;
  if (!candidate) return;
  keyword.value = candidate.vodName;
  searchScope.value = "smart";
  recoveryCandidate.value = null;
  await search();
  await searchMoreSources();
}

async function searchSuggestion(value: string) {
  keyword.value = value;
  await search();
}

async function searchDiscovery(item: Vod) {
  keyword.value = item.vodName;
  searchScope.value = "smart";
  await search();
}

async function setSearchScope(scope: SearchScopePreference) {
  if (searchScope.value === scope) return;
  searchScope.value = scope;
  if (keyword.value.trim()) await search();
}

function normalizeFilterGroups(value: unknown): Record<string, SourceFilterGroup[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const output: Record<string, SourceFilterGroup[]> = {};
  for (const [categoryId, groups] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const parsed = groups.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const group = item as Record<string, unknown>;
      const key = normalizeLabel(group.key);
      const name = normalizeLabel(group.name ?? key);
      const options = Array.isArray(group.options)
        ? group.options.flatMap((option) => {
          if (typeof option !== "object" || option === null || Array.isArray(option)) return [];
          const record = option as Record<string, unknown>;
          const label = normalizeLabel(record.label ?? record.name);
          const optionValue = normalizeLabel(record.value ?? record.id);
          return label ? [{ label, value: optionValue }] : [];
        })
        : [];
      return key && name && options.length ? [{ key, name, options, defaultValue: normalizeLabel(group.defaultValue) || undefined }] : [];
    });
    if (parsed.length) output[categoryId] = parsed;
  }
  return output;
}

function applyLibraryResponseMetadata(response: any) {
  const responseCategories = Array.isArray(response?.categories)
    ? response.categories.map(normalizeCategory).filter((item: SourceCategory | null): item is SourceCategory => item !== null)
    : [];
  if (responseCategories.length && activeSiteRecord.value) activeSiteRecord.value.categories = responseCategories;
  const filters = normalizeFilterGroups(response?.filters);
  if (Object.keys(filters).length) libraryFiltersByCategory.value = { ...libraryFiltersByCategory.value, ...filters };
}

function defaultLibraryFilters(categoryId: string): Record<string, string> {
  return Object.fromEntries(
    (libraryFiltersByCategory.value[categoryId] ?? []).flatMap((group) => {
      const value = group.defaultValue ?? group.options[0]?.value ?? "";
      return value ? [[group.key, value]] : [];
    }),
  );
}

async function loadSourceHome() {
  if (!activeSite.value) {
    libraryItems.value = [];
    return;
  }
  libraryLoading.value = true;
  clearErrorState();
  try {
    const response = await window.tvApi.home(activeSite.value);
    applyLibraryResponseMetadata(response);
    libraryCategory.value = "all";
    libraryFilters.value = {};
    libraryPage.value = Number(response?.page ?? 1) || 1;
    libraryPageCount.value = Math.max(libraryPage.value, Number(response?.pageCount ?? 1) || 1);
    libraryItems.value = dedupeLibraryItems(
      annotate(response?.list ?? [], activeSite.value),
      { includeFolders: activeSiteRecord.value?.contentType === "pan" },
    );
  } catch (e) {
    libraryItems.value = [];
    showRendererError(e, "library");
  } finally {
    libraryLoading.value = false;
  }
}

async function openLibraryCategory(category: LibraryCategoryGroup | { id: "__favorites__"; name: string; sourceCategories: [] }) {
  if (category.id === "__favorites__") {
    go("favorites");
    return;
  }
  page.value = "library";
  libraryCategory.value = category.id;
  libraryArea.value = "全部";
  libraryYear.value = "全部";
  if (category.id === "all") {
    await loadSourceHome();
    return;
  }
  const sourceCategories = category.sourceCategories;
  libraryFilters.value = sourceCategories.length === 1 ? defaultLibraryFilters(sourceCategories[0]!.id) : {};
  await loadLibraryCategoryPage(1, false);
}

async function openStandardLibraryCategory(id: "movie" | "tv") {
  const category = libraryCategories.value.find((item) => item.id === id) ?? libraryCategories.value[0];
  if (category) await openLibraryCategory(category);
}

async function loadLibraryCategoryPage(pageNumber: number, append: boolean) {
  if (!activeSite.value) return;
  const sourceCategories = selectedLibraryCategory.value?.sourceCategories ?? [];
  if (!sourceCategories.length) return;
  libraryLoading.value = true;
  clearErrorState();
  try {
    const responses = await Promise.allSettled(sourceCategories.map((category) => window.tvApi.category(
      activeSite.value,
      category.id,
      String(pageNumber),
      // Vue refs expose Proxy objects; Electron IPC accepts only structured-cloneable data.
      sourceCategories.length === 1 ? { ...libraryFilters.value } : {},
    )));
    const successful = responses.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!successful.length) {
      const failure = responses.find((result) => result.status === "rejected");
      throw failure?.status === "rejected" ? failure.reason : new Error("当前分类暂时无法加载");
    }
    successful.forEach(applyLibraryResponseMetadata);
    const includeFolders = activeSiteRecord.value?.contentType === "pan";
    const incoming = dedupeLibraryItems(
      successful.flatMap((response) => annotate(response?.list ?? [], activeSite.value)),
      { includeFolders },
    );
    libraryItems.value = append
      ? dedupeLibraryItems([...libraryItems.value, ...incoming], { includeFolders })
      : incoming;
    libraryPage.value = pageNumber;
    libraryPageCount.value = Math.max(
      pageNumber,
      ...successful.map((response) => Number(response?.pageCount ?? pageNumber) || pageNumber),
    );
    const failedCount = responses.length - successful.length;
    if (failedCount > 0) showUserError(`${failedCount} 个来源分类暂时不可用，已展示其余结果。`, "library");
  } catch (e) {
    if (!append) libraryItems.value = [];
    showRendererError(e, "library");
  } finally {
    libraryLoading.value = false;
  }
}

async function changeLibraryFilter(group: SourceFilterGroup, value: string) {
  libraryFilters.value = { ...libraryFilters.value, [group.key]: value };
  await loadLibraryCategoryPage(1, false);
}

async function loadMoreLibrary() {
  if (!libraryHasMore.value || libraryLoading.value) return;
  await loadLibraryCategoryPage(libraryPage.value + 1, true);
}

async function openCategory(category: string) {
  if (!activeSite.value) return;
  loading.value = true;
  clearErrorState();
  searchTitle.value = category;
  searchStatuses.value = [];
  folderTrail.value = [];
  try {
    const response = await window.tvApi.category(activeSite.value, category, "1", {});
    results.value = annotate(response?.list ?? []);
    page.value = "search";
  } catch (e) {
    results.value = [];
    showRendererError(e, "library");
  } finally {
    loading.value = false;
  }
}

function folderNeedsPanLogin(value: unknown): boolean {
  const code = (value as RendererPlaybackFailure)?.code;
  if (code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED") return true;
  return /登录|账号|cookie|token|授权|凭据|过期|扫码/i.test(friendlyError(value));
}

function folderAccessMessage(value: unknown): string {
  const message = friendlyError(value);
  if (folderNeedsPanLogin(value)) {
    return "网盘登录状态可能已失效，请重新登录后再进入该目录。";
  }
  return message || "目录暂时无法打开，可以返回上一级或刷新账号状态后重试。";
}

async function openFolder(item: Vod, trailOverride?: FolderTrailItem[], pageNumber = 1, append = false) {
  if (!item.siteKey || !item.vodId) return;
  if (append) folderLoadingMore.value = true;
  else loading.value = true;
  clearErrorState();
  try {
    const response = await window.tvApi.category(item.siteKey, item.vodId, String(pageNumber), {});
    const incoming = (response?.list ?? []).map(normalizeVod).map((entry: Vod) => ({
      ...entry,
      siteKey: entry.siteKey || item.siteKey,
      siteName: entry.siteName || item.siteName,
    }));
    results.value = append
      ? dedupeLibraryItems([...results.value, ...incoming], { includeFolders: true })
      : dedupeLibraryItems(incoming, { includeFolders: true });
    const pageCount = Math.max(pageNumber, Number(response?.pageCount ?? pageNumber) || pageNumber);
    folderPage.value = pageNumber;
    folderHasMore.value = response?.hasMore === true || pageNumber < pageCount;
    searchStatuses.value = [];
    searchHasMore.value = false;
    searchLoadingMore.value = false;
    searchProgress.value = { running: false, completed: 0, total: 0 };
    if (!append) {
      searchTitle.value = item.vodName;
      folderQuery.value = "";
      folderTrail.value = trailOverride ?? [...folderTrail.value.filter((entry) => entry.siteKey === item.siteKey), { siteKey: item.siteKey, folderId: item.vodId, title: item.vodName }];
      page.value = "search";
    }
    if (!incoming.length && !append) showUserError("当前目录暂无可播放文件或下级目录。", "library");
  } catch (e) {
    const provider = folderNeedsPanLogin(e)
      ? detectPanProviderFromContext(`${item.siteKey} ${item.siteName ?? ""} ${item.vodName} ${friendlyError(e)}`)
      : undefined;
    if (provider) {
      pendingPanFolder.value = {
        item,
        trail: trailOverride ?? [...folderTrail.value.filter((entry) => entry.siteKey === item.siteKey), { siteKey: item.siteKey, folderId: item.vodId, title: item.vodName }],
      };
      showRendererError(e, "account", folderAccessMessage(e));
      await startPanLogin(provider);
    } else {
      showRendererError(e, "account", folderAccessMessage(e));
    }
  } finally {
    loading.value = false;
    folderLoadingMore.value = false;
  }
}

async function loadMoreFolder() {
  const current = folderTrail.value.at(-1);
  if (!current || !folderHasMore.value || folderLoadingMore.value) return;
  await openFolder(
    { siteKey: current.siteKey, vodId: current.folderId, vodName: current.title, vodTag: "folder", contentKind: "folder" },
    folderTrail.value,
    folderPage.value + 1,
    true,
  );
}

async function openFolderTrail(index: number) {
  const target = folderTrail.value[index];
  if (!target) return;
  await openFolder({ siteKey: target.siteKey, vodId: target.folderId, vodName: target.title, vodTag: "folder", contentKind: "folder" }, folderTrail.value.slice(0, index + 1));
}

async function backFolder() {
  if (folderTrail.value.length <= 1) {
    folderTrail.value = [];
    folderQuery.value = "";
    folderPage.value = 1;
    folderHasMore.value = false;
    await loadSourceHome();
    page.value = "library";
    return;
  }
  await openFolderTrail(folderTrail.value.length - 2);
}

async function openDetail(item: Vod | FavoriteRecord | HistoryRecord, from: Page = page.value) {
  if (!item.siteKey || !item.vodId) return;
  const route = resolveContentRoute(item);
  if (route === "search") {
    await searchDiscovery(item as Vod);
    return;
  }
  if (route === "settings") {
    page.value = "settings";
    showUserError("该内容属于 CatVod 配置或登录动作，请在设置中操作。", "settings");
    return;
  }
  if (route === "live-unsupported") {
    showUserError("直播专用播放模式尚未启用。", "detail");
    return;
  }
  const referencedSource = item.siteKey.startsWith("cfg:");
  if (route === "folder" || isFolderItem(item)) {
    if (!referencedSource) activeSite.value = item.siteKey;
    await openFolder(item as Vod);
    return;
  }
  loading.value = true;
  clearErrorState();
  previousPage.value = from === "detail" ? "home" : from;
  const sourceWasMissing = !referencedSource && !sites.value.some((site) => site.key === item.siteKey);
  try {
    recoveryCandidate.value = null;
    selected.value = normalizeVod(await window.tvApi.detail(item.siteKey, item.vodId));
    if (sourceWasMissing) {
      await Promise.all([refreshSites(), loadConfigs()]);
      if (sites.value.some((site) => site.key === item.siteKey && site.supported)) activeSite.value = item.siteKey;
      await loadHome();
    }
    selectedFlag.value = resolvePreferredPlaybackLine(selected.value?.flags, linePreference.value)?.flag ?? "";
    page.value = "detail";
  } catch (e) {
    showRendererError(e, "detail");
    if (from === "favorites" || from === "history") recoveryCandidate.value = { vodName: item.vodName };
  } finally {
    loading.value = false;
  }
}

async function openAndPlay(item: Vod | FavoriteRecord | HistoryRecord, from: Page = page.value) {
  await openDetail(item, from);
  if (selected.value?.flags?.length) await playFirstEpisode();
}

function backFromDetail() {
  selected.value = null;
  page.value = previousPage.value;
}

function selectPlaybackLine(flag: string) {
  if (selected.value?.flags?.some((line) => line.flag === flag)) selectedFlag.value = flag;
}

async function toggleFavorite() {
  const item = selected.value;
  if (!item?.siteKey) return;
  if (isSelectedFavorite.value) {
    await window.tvApi.removeFavorite(item.siteKey, item.vodId);
  } else {
    await window.tvApi.saveFavorite({
      siteKey: item.siteKey,
      vodId: item.vodId,
      vodName: item.vodName,
      vodPic: item.vodPic,
      createdAt: Date.now(),
    });
  }
  await loadLibrary(false);
}

async function resolveAlternativeSourcePlayback(
  item: Vod,
  flag: string,
  episode: Episode,
  attemptedSiteKeys: readonly string[],
): Promise<{ item: Vod; flag: string; episode: Episode } | undefined> {
  const currentLine = item.flags?.find((line) => line.flag === flag);
  const currentIndex = currentLine?.episodes.findIndex((entry) => entry.url === episode.url || entry.name === episode.name) ?? -1;
  const response = await window.tvApi.searchDetailed(item.vodName, undefined, "all-configs", 1);
  const candidates = rankAlternativeSourceCandidates(
    item,
    (response?.list ?? []).map(normalizeVod),
    [...attemptedSiteKeys, item.siteKey ?? ""],
  ).slice(0, 6);

  for (const candidate of candidates) {
    if (!candidate.siteKey) continue;
    try {
      const detail = normalizeVod(await window.tvApi.detail(candidate.siteKey, candidate.vodId));
      detail.siteKey ??= candidate.siteKey;
      detail.siteName ??= candidate.siteName;
      detail.configName ??= candidate.configName;
      const target = resolvePlaybackEpisodeTarget(detail.flags, episode, currentIndex, linePreference.value);
      if (target) return { item: detail, flag: target.line.flag, episode: target.episode };
    } catch {
      // A single candidate detail failure must not prevent trying the next ranked source.
    }
  }
  return undefined;
}

function playbackEnginePreferenceKey(siteKey: string, flag: string, episodeUrl: string): string {
  return `${siteKey}\u0000${flag}\u0000${episodeUrl}`;
}

function effectivePlaybackMode(siteKey: string, flag: string, episodeUrl: string): PlaybackMode {
  if (playbackMode.value !== "auto") return playbackMode.value;
  return playbackEnginePreferences.value[playbackEnginePreferenceKey(siteKey, flag, episodeUrl)]?.engine === "compatibility"
    ? "compatibility"
    : "auto";
}

async function rememberCompatibilityPlayback(siteKey: string, flag: string, episodeUrl: string): Promise<void> {
  const key = playbackEnginePreferenceKey(siteKey, flag, episodeUrl);
  const nextEntries = Object.entries({
    ...playbackEnginePreferences.value,
    [key]: { engine: "compatibility" as const, updatedAt: Date.now() },
  })
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, 300);
  playbackEnginePreferences.value = Object.fromEntries(nextEntries);
  await window.tvApi.setSetting("playbackEnginePreferences", playbackEnginePreferences.value).catch(() => undefined);
}

async function clearPlaybackEnginePreferences(): Promise<void> {
  playbackEnginePreferences.value = {};
  await window.tvApi.setSetting("playbackEnginePreferences", {});
  playbackStatus.value = "已清除高兼容播放记忆，后续将重新智能判断播放方式。";
}

function normalizePlaybackEnginePreferences(value: unknown): Record<string, PlaybackEnginePreference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, raw]) => {
      if (!key || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const record = raw as Record<string, unknown>;
      if (record.engine !== "compatibility") return undefined;
      const updatedAt = Number(record.updatedAt);
      return [key, { engine: "compatibility" as const, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 }] as const;
    })
    .filter((entry): entry is readonly [string, PlaybackEnginePreference] => entry !== undefined)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, 300);
  return Object.fromEntries(entries);
}

async function play(
  flag: string,
  episode: Episode,
  startPosition = 0,
  attemptedFlags: readonly string[] = [],
  attemptedSiteKeys: readonly string[] = [],
  sameLineRetries = 0,
) {
  const item = selected.value;
  if (!item?.siteKey) return;
  // Pre-check netdisk credentials before resolving a pan line. A stale
  // credential is the most common reason pan original-quality playback
  // fails; guiding the user to re-login first avoids a guaranteed failed
  // attempt. Only a definitely-expired credential blocks here — a missing
  // status may still be a playable public share, so it falls through to the
  // 401/403 backstop during playback.
  const precheckProvider = detectPanPlaybackProvider(item, flag, episode);
  if (precheckProvider && await promptPanLoginBeforePlayback(precheckProvider, item, flag, episode, startPosition)) return;
  await clearExternalFallbackSession();
  const requestId = ++playbackRequestId;
  let preparedSessionId = "";
  clearErrorState();
  sniffing.value = true;
  playbackStatus.value = attemptedFlags.length
    ? `正在尝试备用线路“${flag}”…`
    : "正在解析播放地址并准备内置播放器…";
  try {
    const prepared = await window.tvApi.preparePlayback({
      siteKey: item.siteKey,
      flag,
      episodeUrl: episode.url,
      vodId: item.vodId,
      vodName: item.vodName,
      episodeName: episode.name,
      playbackMode: effectivePlaybackMode(item.siteKey, flag, episode.url),
    });
    preparedSessionId = prepared.sessionId;
    if (requestId !== playbackRequestId) {
      await window.tvApi.closePlayback(prepared.sessionId);
      return;
    }

    await window.tvApi.saveHistory({
      siteKey: item.siteKey,
      vodId: item.vodId,
      vodName: item.vodName,
      episodeName: episode.name,
      episodeUrl: episode.url,
      flag,
      position: Math.max(0, startPosition),
      duration: selectedHistory.value?.episodeUrl === episode.url ? selectedHistory.value.duration : 0,
      updatedAt: Date.now(),
    });

    selectedFlag.value = flag;
    latestPlaybackProgress.value = {
      position: Math.max(0, startPosition),
      duration: selectedHistory.value?.episodeUrl === episode.url ? selectedHistory.value.duration : 0,
      completed: false,
    };
    playing.value = {
      ...prepared,
      flag,
      title: item.vodName,
      episode: episode.name,
      siteKey: item.siteKey,
      vodId: item.vodId,
      episodeUrl: episode.url,
      startPosition: Math.max(0, startPosition),
      attemptedFlags: [...attemptedFlags],
    };
    paused.value = false;
    playbackStatus.value = prepared.resolvedBy === "browser-sniffer" ? "已通过网页嗅探获得媒体地址" : "";
    await loadLibrary(false);
  } catch (e) {
    if (requestId !== playbackRequestId) return;
    playbackStatus.value = "";
    const panProvider = playbackNeedsPanLogin(e) ? detectPanPlaybackProvider(item, flag, episode) : undefined;
    if (panProvider) {
      pendingPanPlayback.value = {
        item: { ...item, flags: item.flags?.map((line) => ({ ...line, episodes: line.episodes.map((entry) => ({ ...entry })) })) },
        flag,
        episode: { ...episode },
        startPosition: Math.max(0, startPosition),
      };
      await startPanLogin(panProvider);
      return;
    }
    // Netdisk signed links are short-lived: a 412/link-expiry usually means
    // the link expired between resolution and the first media request, not
    // that the line is dead. Re-fetch a fresh link for the SAME line once
    // before falling back to switching lines. This is the highest-yield
    // recovery for pan original-quality playback. SOURCE_RESOLVE_FAILED is
    // included because CatVod pan spiders (e.g. duoduo) intermittently time
    // out their play request (HTTP 500 "请求超时") — a same-line retry almost
    // always succeeds, while switching lines jumps the user to another
    // provider entirely.
    const failureCode = (e as RendererPlaybackFailure)?.code;
    if (sameLineRetries === 0 && (failureCode === "MEDIA_URL_EXPIRED" || failureCode === "SOURCE_RESOLVE_FAILED")) {
      if (preparedSessionId) await window.tvApi.closePlayback(preparedSessionId).catch(() => undefined);
      playbackStatus.value = failureCode === "MEDIA_URL_EXPIRED"
        ? "网盘播放地址已失效，正在重新获取后继续播放…"
        : "播放地址解析超时，正在重试当前线路…";
      await play(flag, episode, startPosition, attemptedFlags, attemptedSiteKeys, 1);
      return;
    }
    const fallback = autoFallbackLine.value && playbackAllowsLineFallback(e)
      ? resolveFallbackPlaybackLine(item.flags, flag, episode, attemptedFlags, linePreference.value)
      : undefined;
    if (fallback) {
      if (preparedSessionId) await window.tvApi.closePlayback(preparedSessionId).catch(() => undefined);
      // Surface the exact failure to the main-process log so line switching
      // can be diagnosed without guessing.
      console.error("[playback-line-fallback]", {
        fromFlag: flag,
        toFlag: fallback.line.flag,
        toLine: fallback.line.show ?? fallback.line.flag,
        episode: episode.name,
        code: failureCode ?? "UNKNOWN",
        message: playbackFailureMessage(e),
      });
      selectedFlag.value = fallback.line.flag;
      playbackStatus.value = `线路“${flag}”不可用，正在自动尝试“${fallback.line.show || fallback.line.flag}”…`;
      await play(fallback.line.flag, fallback.episode, startPosition, [...attemptedFlags, flag], attemptedSiteKeys);
      return;
    }
    if (autoFallbackSource.value && playbackAllowsLineFallback(e)) {
      playbackStatus.value = "当前来源的可匹配线路均不可用，正在查找其他来源…";
      const alternative = await resolveAlternativeSourcePlayback(item, flag, episode, attemptedSiteKeys).catch(() => undefined);
      if (alternative) {
        if (preparedSessionId) await window.tvApi.closePlayback(preparedSessionId).catch(() => undefined);
        const previousSourceName = item.siteName || "当前来源";
        selected.value = alternative.item;
        selectedFlag.value = alternative.flag;
        playbackStatus.value = `“${previousSourceName}”播放失败，正在切换到“${alternative.item.siteName || "其他来源"}”…`;
        await play(
          alternative.flag,
          alternative.episode,
          startPosition,
          [],
          [...attemptedSiteKeys, item.siteKey ?? ""].filter(Boolean),
        );
        return;
      }
    }
    const failureMessage = playbackFailureMessage(e);
    const attemptedLineCount = attemptedFlags.length ? attemptedFlags.length + 1 : 0;
    const attemptedSourceCount = attemptedSiteKeys.length ? attemptedSiteKeys.length + 1 : 0;
    const recoveryMessage = attemptedSourceCount
      ? `已自动尝试 ${attemptedSourceCount} 个来源，仍未成功。${failureMessage}`
      : attemptedLineCount
        ? `已自动尝试 ${attemptedLineCount} 条线路，仍未成功。${failureMessage}`
        : failureMessage;
    if (preparedSessionId) await window.tvApi.closePlayback(preparedSessionId).catch(() => undefined);
    showRendererError(e, "playback", `${recoveryMessage} 应用将只使用内置播放器，请切换线路、切换来源或重试。`);
    if (playbackFailureAffectsSource(e)) await refreshSites().catch(() => undefined);
  } finally {
    if (requestId === playbackRequestId) sniffing.value = false;
  }
}

async function playFirstEpisode() {
  const history = selectedHistory.value;
  if (history) {
    const historyLine = history.flag
      ? selected.value?.flags?.find((line) => line.flag === history.flag)
      : undefined;
    const historyEpisode = historyLine?.episodes.find((item) => item.url === history.episodeUrl || item.name === history.episodeName);
    if (historyLine && historyEpisode) {
      selectedFlag.value = historyLine.flag;
      await play(historyLine.flag, historyEpisode, history.position);
      return;
    }
    const preferredLine = resolvePreferredPlaybackLine(selected.value?.flags, linePreference.value);
    const preferredEpisode = preferredLine?.episodes.find((item) => item.name === history.episodeName);
    if (preferredLine && preferredEpisode) {
      selectedFlag.value = preferredLine.flag;
      await play(preferredLine.flag, preferredEpisode, history.position);
      return;
    }
    for (const line of selected.value?.flags ?? []) {
      const episode = line.episodes.find((item) => item.url === history.episodeUrl);
      if (episode) {
        selectedFlag.value = line.flag;
        await play(line.flag, episode, history.position);
        return;
      }
    }
  }
  const line = activeLine.value ?? resolvePreferredPlaybackLine(selected.value?.flags, linePreference.value);
  const episode = line?.episodes?.[0];
  if (line && episode) await play(line.flag, episode);
}

async function cancelSniff() {
  playbackRequestId += 1;
  await Promise.allSettled([
    window.tvApi.cancelPlaybackPreparation(),
    window.tvApi.cancelSniff(),
  ]);
  sniffing.value = false;
  playbackStatus.value = "";
}

async function saveEmbeddedProgress(progress: PlaybackProgress) {
  latestPlaybackProgress.value = { ...progress };
  const current = playing.value;
  if (!current) return;
  await window.tvApi.saveHistory({
    siteKey: current.siteKey,
    vodId: current.vodId,
    vodName: current.title,
    episodeName: current.episode,
    episodeUrl: current.episodeUrl,
    flag: current.flag,
    position: progress.position,
    duration: progress.duration,
    updatedAt: Date.now(),
  });
}

async function handleEmbeddedEnded(progress: PlaybackProgress) {
  await saveEmbeddedProgress(progress);
  if (pendingSourceImport.value) {
    const current = playing.value;
    if (current) await window.tvApi.closePlayback(current.sessionId);
    playing.value = null;
    paused.value = false;
    await loadLibrary(false);
    await applyPendingSourceImport();
    return;
  }
  const next = playingNavigation.value?.next;
  if (autoNextEpisode.value && next) {
    playbackStatus.value = `本集播放完成，正在自动播放 ${next.name}…`;
    await switchEmbeddedEpisode(next.url, progress);
  }
}


async function switchEmbeddedEpisode(episodeUrl: string, progress: PlaybackProgress) {
  const current = playing.value;
  const navigation = playingNavigation.value;
  if (!current || !navigation || episodeUrl === current.episodeUrl) return;
  const episode = navigation.episodes.find((item) => item.url === episodeUrl);
  if (!episode) return;

  await saveEmbeddedProgress(progress);
  const previousSessionId = current.sessionId;
  // Keep the current native session alive until the next one has been
  // prepared. Stopping it first leaves libmpv with an empty surface whenever a
  // provider takes a moment to resolve the next episode.
  paused.value = false;
  await play(navigation.flag, episode, 0);
  if (playing.value?.sessionId !== previousSessionId) {
    await window.tvApi.closePlayback(previousSessionId).catch(() => undefined);
  }
}

async function playPreviousEmbeddedEpisode(progress: PlaybackProgress) {
  const previous = playingNavigation.value?.previous;
  if (previous) await switchEmbeddedEpisode(previous.url, progress);
}

async function playNextEmbeddedEpisode(progress: PlaybackProgress) {
  const next = playingNavigation.value?.next;
  if (next) await switchEmbeddedEpisode(next.url, progress);
}

async function selectEmbeddedEpisode(payload: { episodeUrl: string; progress: PlaybackProgress }) {
  await switchEmbeddedEpisode(payload.episodeUrl, payload.progress);
}

async function closeEmbeddedPlayback(progress: PlaybackProgress) {
  const current = playing.value;
  if (!current) return;
  await saveEmbeddedProgress(progress);
  await window.tvApi.closePlayback(current.sessionId);
  playing.value = null;
  paused.value = false;
  await loadLibrary(false);
  await applyPendingSourceImport();
}

async function stopPlaybackAndApplyPendingSource(): Promise<void> {
  const current = playing.value;
  if (!current || !pendingSourceImport.value || loading.value) return;
  await saveEmbeddedProgress(latestPlaybackProgress.value);
  await window.tvApi.closePlayback(current.sessionId);
  playing.value = null;
  paused.value = false;
  await loadLibrary(false);
  await applyPendingSourceImport();
}

async function handleWebPlayerEngineFallback(reason: string) {
  webPlayerEngine.value = "legacy";
  playbackStatus.value = `${reason}，已自动切回稳定播放器。`;
  await window.tvApi.setSetting("webPlayerEngine", "legacy").catch(() => undefined);
}

async function fallbackEmbeddedPlayback(progress: PlaybackProgress) {
  const current = playing.value;
  if (!current) return;
  await saveEmbeddedProgress(progress);
  await rememberCompatibilityPlayback(current.siteKey, current.flag, current.episodeUrl);
  playing.value = {
    ...current,
    engine: "mpv",
    startPosition: Math.max(0, progress.position),
  };
  paused.value = false;
  playbackStatus.value = "标准播放模式无法正常加载，已切换到高兼容播放模式。";
  await loadLibrary(false);
}

async function handleWebPlayerReprepare(progress: PlaybackProgress) {
  const current = playing.value;
  if (!current) return;
  await saveEmbeddedProgress(progress);
  await window.tvApi.closePlayback(current.sessionId).catch(() => undefined);
  playing.value = null;
  paused.value = false;
  playbackStatus.value = "播放地址可能已过期，正在重新获取后继续播放…";
  await play(current.flag, { name: current.episode, url: current.episodeUrl }, Math.max(0, progress.position), [], [], 1);
}

async function handleCompatibilityPlaybackFailure(payload: CompatibilityPlaybackFailure) {
  const current = playing.value;
  if (!current) return;
  const item = selected.value?.siteKey === current.siteKey && selected.value.vodId === current.vodId
    ? selected.value
    : undefined;
  const currentLine = item?.flags?.find((line) => line.flag === current.flag);
  const currentEpisode = currentLine?.episodes.find((episode) => episode.url === current.episodeUrl)
    ?? { name: current.episode, url: current.episodeUrl };
  const attemptedFlags = current.attemptedFlags ?? [];
  const fallback = resolveFallbackPlaybackLine(item?.flags, current.flag, currentEpisode, attemptedFlags, "stable");
  if (!fallback) {
    playbackStatus.value = `${payload.reason} 当前内容没有可继续尝试的备用线路。`;
    return;
  }

  console.error(`[playback-compat-failure] ${JSON.stringify({
    fromFlag: current.flag,
    toFlag: fallback.line.flag,
    episode: currentEpisode.name,
    reason: payload.reason,
    progress: Math.round(Math.max(0, payload.progress.position)),
  })}`);
  await saveEmbeddedProgress(payload.progress);
  await window.tvApi.stop?.().catch(() => undefined);
  await window.tvApi.closePlayback(current.sessionId).catch(() => undefined);
  playing.value = null;
  paused.value = false;
  selectedFlag.value = fallback.line.flag;
  playbackStatus.value = `线路“${current.flag}”的高兼容播放失败，正在自动切换到“${fallback.line.show || fallback.line.flag}”…`;
  await play(
    fallback.line.flag,
    fallback.episode,
    Math.max(0, payload.progress.position),
    [...attemptedFlags, current.flag],
  );
}

async function refreshSourceStatus() {
  checkingSite.value = "__all__";
  contentSourceMessage.value = "正在检查并修复内容来源…";
  try {
    await refreshCatVodStatus();
    if (catVodStatus.value?.state !== "running") {
      await window.tvApi.startCatVod(catVodMd5Url.value.trim(), catVodRemoteAccessPolicy.value);
      await refreshCatVodStatus();
    }
    await Promise.all([refreshSites(), loadConfigs()]);
    await startSourceAudit(true);
    contentSourceMessage.value = sourceAuditStatus.value.running
      ? `正在检测 ${sourceAuditStatus.value.total} 个来源…`
      : `检查完成，当前 ${selectableSites.value.length} 个影视来源可用`;
  } catch (e) {
    contentSourceMessage.value = `检查失败：${friendlyError(e)}`;
  } finally {
    checkingSite.value = "";
  }
}

async function loadLibrary(changePage = false) {
  try {
    [histories.value, favorites.value] = await Promise.all([
      window.tvApi.listHistory(),
      window.tvApi.listFavorites(),
    ]);
    if (changePage) page.value = "history";
  } catch (e) {
    histories.value = [];
    favorites.value = [];
    showRendererError(e, "records");
  }
}

async function removeFavorite(item: FavoriteRecord) {
  await window.tvApi.removeFavorite(item.siteKey, item.vodId);
  await loadLibrary(false);
}

async function removeHistory(item: HistoryRecord) {
  await window.tvApi.removeHistory(item.siteKey, item.vodId, item.episodeName);
  await loadLibrary(false);
}

async function clearHistory() {
  await window.tvApi.clearHistory();
  await loadLibrary(false);
}

async function applyReplacementRegistry() {
  const source = replacementRegistrySource.value.trim();
  if (!source || !window.tvApi.loadReplacementRegistry) return;
  replacementRegistryLoading.value = true;
  replacementRegistryMessage.value = "正在加载并重建播放源…";
  try {
    const status = await window.tvApi.loadReplacementRegistry(source);
    replacementRegistrySource.value = status.source ?? source;
    replacementRegistryCount.value = Number(status.count ?? 0);
    await refreshSites();
    await loadHome();
    replacementRegistryMessage.value = `已启用 ${replacementRegistryCount.value} 条替代规则`;
  } catch (e) {
    replacementRegistryMessage.value = `加载失败：${friendlyError(e)}`;
  } finally {
    replacementRegistryLoading.value = false;
  }
}

async function clearReplacementRegistry() {
  if (!window.tvApi.clearReplacementRegistry) return;
  replacementRegistryLoading.value = true;
  replacementRegistryMessage.value = "正在清除并重建播放源…";
  try {
    await window.tvApi.clearReplacementRegistry();
    replacementRegistrySource.value = "";
    replacementRegistryCount.value = 0;
    await refreshSites();
    await loadHome();
    replacementRegistryMessage.value = "已恢复内置默认注册表";
  } catch (e) {
    replacementRegistryMessage.value = `清除失败：${friendlyError(e)}`;
  } finally {
    replacementRegistryLoading.value = false;
  }
}

function stopPanLoginPolling() {
  if (panLoginTimer !== undefined) window.clearTimeout(panLoginTimer);
  panLoginTimer = undefined;
}

async function ensureCatVodForPan() {
  await refreshCatVodStatus();
  if (catVodStatus.value?.state === "running") return;
  panLoginMessage.value = "正在启动必要服务…";
  await window.tvApi.startCatVod(catVodMd5Url.value.trim(), catVodRemoteAccessPolicy.value);
  await Promise.all([refreshCatVodStatus(), refreshSites()]);
}

async function refreshPanStatus() {
  if (!window.tvApi.getPanStatus && !window.tvApi.getPanStatuses) return;
  panStatusLoading.value = true;
  try {
    await ensureCatVodForPan();
    const statuses = window.tvApi.getPanStatuses
      ? await window.tvApi.getPanStatuses() as PanProviderStatus[]
      : await Promise.all(PAN_PROVIDER_DEFINITIONS.map((provider) => window.tvApi.getPanStatus(provider.id) as Promise<PanProviderStatus>));
    panStatuses.value = Object.fromEntries(statuses.map((status) => [status.provider, status])) as Partial<Record<PanProviderId, PanProviderStatus>>;
  } catch (e) {
    const message = friendlyError(e);
    const checkedAt = Date.now();
    panStatuses.value = Object.fromEntries(PAN_PROVIDER_DEFINITIONS.map((provider) => {
      const previous = panStatuses.value[provider.id];
      return [provider.id, {
        provider: provider.id,
        name: provider.name,
        configured: previous?.configured ?? false,
        login: previous?.login ?? false,
        accountState: "unavailable" as const,
        credentialMode: previous?.credentialMode ?? "unknown",
        state: "状态检查失败",
        label: message,
        checkedAt,
      }];
    })) as Partial<Record<PanProviderId, PanProviderStatus>>;
    showRendererError(e, "account", message);
  } finally {
    panStatusLoading.value = false;
  }
}

async function clearPanAccount(provider: PanProviderId) {
  if (!window.tvApi.clearPanAccount) return;
  panStatusLoading.value = true;
  panAccountMessage.value = "正在清除网盘凭据…";
  try {
    await ensureCatVodForPan();
    const cleared = await window.tvApi.clearPanAccount(provider) as PanProviderStatus;
    panStatuses.value = { ...panStatuses.value, [provider]: cleared };
    panAccountMessage.value = `${cleared.name} 凭据已清除`;
    await refreshPanStatus();
  } catch (e) {
    panAccountMessage.value = `清除失败：${friendlyError(e)}`;
    showRendererError(e, "account", panAccountMessage.value);
  } finally {
    panStatusLoading.value = false;
  }
}

function applyPanLoginResult(result: PanLoginResult) {
  activePanLoginProvider.value = result.provider;
  panLoginState.value = result.status;
  panLoginMessage.value = result.message;
  if (result.taskId) panLoginTaskId.value = result.taskId;
  if (result.qrImage) panLoginQrImage.value = result.qrImage;
}

function schedulePanLoginPoll() {
  stopPanLoginPolling();
  if (!panLoginOpen.value || !panLoginTaskId.value || panLoginState.value !== "waiting") return;
  panLoginTimer = window.setTimeout(() => void pollPanLogin(), 1500);
}

async function pollPanLogin() {
  const taskId = panLoginTaskId.value;
  const loginProvider = activePanLoginProvider.value;
  if (!taskId || !panLoginOpen.value || panLoginState.value !== "waiting") return;
  try {
    const result = await window.tvApi.pollPanLogin(loginProvider, taskId) as PanLoginResult;
    if (taskId !== panLoginTaskId.value || !panLoginOpen.value) return;
    applyPanLoginResult(result);
    if (result.status === "success") {
      stopPanLoginPolling();
      await refreshPanStatus();
      const pending = pendingPanPlayback.value;
      const pendingFolder = pendingPanFolder.value;
      pendingPanPlayback.value = null;
      pendingPanFolder.value = null;
      if (pending) {
        panLoginMessage.value = "登录成功，正在继续播放…";
        panLoginOpen.value = false;
        selected.value = pending.item;
        selectedFlag.value = pending.flag;
        await play(pending.flag, pending.episode, pending.startPosition);
      } else if (pendingFolder) {
        panLoginMessage.value = "登录成功，正在重新打开目录…";
        panLoginOpen.value = false;
        await openFolder(pendingFolder.item, pendingFolder.trail);
      } else {
        window.setTimeout(() => {
          if (panLoginState.value === "success") panLoginOpen.value = false;
        }, 900);
      }
      return;
    }
    if (result.terminal) {
      stopPanLoginPolling();
      return;
    }
  } catch (e) {
    if (taskId !== panLoginTaskId.value) return;
    panLoginState.value = "error";
    panLoginMessage.value = friendlyError(e);
    showRendererError(e, "account", panLoginMessage.value);
    stopPanLoginPolling();
    return;
  }
  schedulePanLoginPoll();
}

async function startPanLogin(provider: PanProviderId, loginProvider?: PanLoginProviderId) {
  const definition = PAN_PROVIDER_DEFINITIONS.find((entry) => entry.id === provider) ?? PAN_PROVIDER_DEFINITIONS[0]!;
  const targetLoginProvider = loginProvider ?? definition.loginOptions[0]!.provider;
  stopPanLoginPolling();
  const previousTask = panLoginTaskId.value;
  if (previousTask) await window.tvApi.cancelPanLogin(previousTask).catch(() => undefined);
  activePanProvider.value = provider;
  activePanLoginProvider.value = targetLoginProvider;
  panLoginOpen.value = true;
  panLoginLoading.value = true;
  panLoginTaskId.value = "";
  panLoginQrImage.value = "";
  panLoginState.value = "waiting";
  panLoginMessage.value = "正在生成登录二维码…";
  try {
    await ensureCatVodForPan();
    const result = await window.tvApi.startPanLogin(targetLoginProvider) as PanLoginResult;
    applyPanLoginResult(result);
    schedulePanLoginPoll();
  } catch (e) {
    panLoginState.value = "error";
    panLoginMessage.value = friendlyError(e);
    showRendererError(e, "account", panLoginMessage.value);
  } finally {
    panLoginLoading.value = false;
  }
}

async function switchPendingPanPlaybackSource() {
  const pending = pendingPanPlayback.value;
  if (!pending) return;
  stopPanLoginPolling();
  const taskId = panLoginTaskId.value;
  const shouldCancel = Boolean(taskId && panLoginState.value === "waiting");
  panLoginOpen.value = false;
  panLoginTaskId.value = "";
  panLoginQrImage.value = "";
  pendingPanPlayback.value = null;
  if (shouldCancel) await window.tvApi.cancelPanLogin(taskId).catch(() => undefined);

  keyword.value = pending.item.vodName;
  searchScope.value = "smart";
  await searchWithTargetSelection({
    maxSources: 6,
    excludeSiteKeys: pending.item.siteKey ? [pending.item.siteKey] : [],
  });
}

async function closePanLogin() {
  stopPanLoginPolling();
  const taskId = panLoginTaskId.value;
  panLoginOpen.value = false;
  panLoginTaskId.value = "";
  panLoginQrImage.value = "";
  pendingPanPlayback.value = null;
  pendingPanFolder.value = null;
  if (taskId && panLoginState.value === "waiting") {
    await window.tvApi.cancelPanLogin(taskId).catch(() => undefined);
  }
}

async function refreshCatVodStatus() {
  if (!window.tvApi.getCatVodStatus) return;
  catVodStatus.value = await window.tvApi.getCatVodStatus();
  if (catVodStatus.value?.sourceMd5Url) catVodMd5Url.value = catVodStatus.value.sourceMd5Url;
  if (catVodStatus.value?.remoteAccessPolicy) catVodRemoteAccessPolicy.value = catVodStatus.value.remoteAccessPolicy;
}

async function runCatVodAction(action: () => Promise<unknown>, successMessage: string): Promise<unknown | undefined> {
  catVodLoading.value = true;
  catVodMessage.value = "正在处理 CatVod 服务…";
  try {
    const result = await action();
    await refreshCatVodStatus();
    await refreshSites();
    await loadHome();
    if (page.value === "library") await loadSourceHome();
    catVodMessage.value = typeof result === "object" && result !== null && "message" in result
      ? String((result as { message?: unknown }).message ?? successMessage)
      : successMessage;
    return result;
  } catch (e) {
    catVodMessage.value = `操作失败：${friendlyError(e)}`;
    return undefined;
  } finally {
    catVodLoading.value = false;
  }
}

async function startCatVod() {
  const source = catVodMd5Url.value.trim();
  if (!source) return;
  await runCatVodAction(() => window.tvApi.startCatVod(source, catVodRemoteAccessPolicy.value), "CatVod 服务已启动");
}

async function stopCatVod() {
  await runCatVodAction(() => window.tvApi.stopCatVod(), "CatVod 服务已停止");
}

async function restartCatVod() {
  await runCatVodAction(() => window.tvApi.restartCatVod(catVodRemoteAccessPolicy.value), "CatVod 服务已重新启动");
}

async function checkCatVodUpdate() {
  const strategy = catVodUpdateStrategy.value;
  const result = await runCatVodAction(
    strategy === "notify" && window.tvApi.inspectCatVodUpdate
      ? () => window.tvApi.inspectCatVodUpdate()
      : () => window.tvApi.checkCatVodUpdate(),
    strategy === "notify" ? "更新检查完成；仅提示，不下载候选或自动切换。" : "CatVod 更新检查完成，候选版本已保留待验证。",
  );
  if (!result || strategy !== "auto-activate") return;
  await refreshCatVodStatus();
  if (!catVodStatus.value?.candidateMd5) return;
  await runCatVodAction(() => window.tvApi.activateCatVodUpdate(), "候选版本测试通过，已按策略自动激活。");
}

async function activateCatVodUpdate() {
  await runCatVodAction(() => window.tvApi.activateCatVodUpdate(), "CatVod 候选版本已激活");
}

async function rollbackCatVod() {
  await runCatVodAction(() => window.tvApi.rollbackCatVod(), "CatVod 已回滚到上一版本");
}

async function openCatVodWebsite() {
  await runCatVodAction(() => window.tvApi.openCatVodWebsite(), "CatVod 配置中心已打开");
}

async function showCatVodLogPath() {
  try {
    const logPath = await window.tvApi.getCatVodLogPath();
    catVodMessage.value = `服务日志：${logPath}`;
  } catch (e) {
    catVodMessage.value = `读取日志路径失败：${friendlyError(e)}`;
  }
}

function applyResolvedTheme(): void {
  document.documentElement.dataset.theme = resolvedTheme.value;
  document.documentElement.style.colorScheme = resolvedTheme.value;
}

function handleSystemThemeChange(event: MediaQueryListEvent): void {
  systemPrefersDark.value = event.matches;
}

async function dismissStorageRecoveryNotice() {
  storageRecoveryNotice.value = null;
  await window.tvApi.setSetting("storageRecoveryNotice", null);
}

async function saveSettings() {
  if (settingsSaving.value) return;
  settingsSaved.value = false;
  settingsSaving.value = true;
  try {
    danmakuSettings.value = normalizeDanmakuSettings({
      ...danmakuSettings.value,
      blockedWords: parseBlockedWords(danmakuBlockedWordsText.value),
    });
    subtitleSettings.value = normalizeSubtitleSettings(subtitleSettings.value);
    danmakuBlockedWordsText.value = danmakuSettings.value.blockedWords.join("，");

    const serializableDanmakuSettings = makeSerializableSetting(danmakuSettings.value);
    const serializableSubtitleSettings = makeSerializableSetting(subtitleSettings.value);
    await window.tvApi.setSetting("defaultSpeed", Number(defaultSpeed.value));
    await window.tvApi.setSetting("danmakuSettings", serializableDanmakuSettings);
    await window.tvApi.setSetting("subtitleSettings", serializableSubtitleSettings);
    await window.tvApi.setSetting("linePreference", linePreference.value);
    await window.tvApi.setSetting("autoFallbackLine", autoFallbackLine.value);
    await window.tvApi.setSetting("compatibilityFallbackMode", compatibilityFallbackMode.value);
    await window.tvApi.setSetting("playbackMode", playbackMode.value);
    await window.tvApi.setSetting("nativeLibmpvEnabled", nativeLibmpvEnabled.value);
    await window.tvApi.setSetting("webPlayerEngine", webPlayerEngine.value);
    await window.tvApi.setSetting("autoFallbackSource", autoFallbackSource.value);
    await window.tvApi.setSetting("autoNextEpisode", autoNextEpisode.value);
    await window.tvApi.setSetting("externalPlayerPreference", externalPlayerPreference.value);
    await window.tvApi.setSetting("fontSize", fontSize.value);
    await window.tvApi.setSetting("themeMode", themeMode.value);
    await window.tvApi.setSetting("homeCarouselEnabled", homeCarouselEnabled.value);
    await window.tvApi.setSetting("catVodRemoteAccessPolicy", catVodRemoteAccessPolicy.value);
    await window.tvApi.setSetting("catVodUpdateStrategy", catVodUpdateStrategy.value);

    const values = [
      ["defaultSpeed", Number(defaultSpeed.value)],
      ["danmakuSettings", serializableDanmakuSettings],
      ["subtitleSettings", serializableSubtitleSettings],
      ["linePreference", linePreference.value],
      ["autoFallbackLine", autoFallbackLine.value],
      ["compatibilityFallbackMode", compatibilityFallbackMode.value],
      ["playbackMode", playbackMode.value],
      ["nativeLibmpvEnabled", nativeLibmpvEnabled.value],
      ["webPlayerEngine", webPlayerEngine.value],
      ["autoFallbackSource", autoFallbackSource.value],
      ["autoNextEpisode", autoNextEpisode.value],
      ["externalPlayerPreference", externalPlayerPreference.value],
      ["fontSize", fontSize.value],
      ["themeMode", themeMode.value],
      ["homeCarouselEnabled", homeCarouselEnabled.value],
      ["catVodRemoteAccessPolicy", catVodRemoteAccessPolicy.value],
      ["catVodUpdateStrategy", catVodUpdateStrategy.value],
    ] as const;
    const persistedValues = await Promise.all(values.map(([key]) => window.tvApi.getSetting(key, null)));
    const failedIndex = persistedValues.findIndex((value, index) => !settingValuesEqual(value, values[index]?.[1]));
    if (failedIndex >= 0) throw new Error(`设置 ${values[failedIndex]?.[0] ?? "未知"} 写入后校验失败`);

    settingsSaved.value = true;
    window.setTimeout(() => { settingsSaved.value = false; }, 1800);
  } catch (error) {
    showUserError(`设置保存失败：${friendlyError(error)}`, "settings");
  } finally {
    settingsSaving.value = false;
  }
}

watch(homeCarouselEnabled, () => scheduleHeroRotation());
watch(resolvedTheme, applyResolvedTheme, { immediate: true });
watch(page, (next) => {
  if (next === "home") {
    scheduleHeroRotation();
    if (!homeLoading.value && homeLoadedSiteKey.value !== activeSite.value) void loadHome(activeSite.value);
  } else {
    clearHeroRotation();
  }
});

watch(activeSite, async (next, previous) => {
  if (next === previous || restoringInitialSite) return;
  rememberSource(next);
  const homeRefresh = page.value === "home" ? loadHome(next) : undefined;
  if (!homeRefresh) resetHomeContent();
  await window.tvApi.setSetting("defaultSite", next);
  libraryCategory.value = "all";
  libraryFilters.value = {};
  libraryFiltersByCategory.value = {};
  libraryItems.value = [];
  if (homeRefresh) await homeRefresh;
  if (page.value === "library") await loadSourceHome();
});

onMounted(async () => {
  loading.value = true;
  themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemPrefersDark.value = themeMediaQuery.matches;
  themeMediaQuery.addEventListener("change", handleSystemThemeChange);
  applyResolvedTheme();
  window.addEventListener("focus", handleHeroWindowFocus);
  window.addEventListener("blur", handleHeroWindowBlur);
  if (window.tvApi.onIncrementalSearchEvent) {
    removeIncrementalSearchEvent = window.tvApi.onIncrementalSearchEvent(handleIncrementalSearchEvent);
  }
  try {
    recentSearches.value = JSON.parse(window.localStorage.getItem("fongmi-recent-searches") ?? "[]");
  } catch {
    recentSearches.value = [];
  }
  try {
    const savedRecentSites = await window.tvApi.getSetting("recentSiteKeys", []);
    recentSourceKeys.value = Array.isArray(savedRecentSites)
      ? savedRecentSites.filter((key): key is string => typeof key === "string").slice(0, 8)
      : [];
    const savedFavoriteSites = await window.tvApi.getSetting("favoriteSourceKeys", []);
    favoriteSourceKeys.value = Array.isArray(savedFavoriteSites)
      ? savedFavoriteSites.filter((key): key is string => typeof key === "string").slice(0, 24)
      : [];
    await Promise.all([refreshSites(), loadConfigs(), loadLibrary(false)]);
    appInfo.value = await window.tvApi.getInfo();
    document.documentElement.dataset.platform = appInfo.value.platform;
    document.documentElement.dataset.desktopPlatform = appInfo.value.desktopPlatform ?? "unknown";
    defaultSpeed.value = await window.tvApi.getSetting("defaultSpeed", 1);
    danmakuSettings.value = normalizeDanmakuSettings(await window.tvApi.getSetting("danmakuSettings", DEFAULT_DANMAKU_SETTINGS));
    subtitleSettings.value = normalizeSubtitleSettings(await window.tvApi.getSetting("subtitleSettings", DEFAULT_SUBTITLE_SETTINGS));
    danmakuBlockedWordsText.value = danmakuSettings.value.blockedWords.join("，");
    const recovery = await window.tvApi.getSetting("storageRecoveryNotice", null);
    storageRecoveryNotice.value = recovery && typeof recovery === "object" && ["restored-backup", "reset-empty"].includes(String(recovery.state))
      ? recovery as StorageRecoveryNotice
      : null;
    linePreference.value = await window.tvApi.getSetting("linePreference", "stable") === "quality" ? "quality" : "stable";
    autoFallbackLine.value = await window.tvApi.getSetting("autoFallbackLine", true) !== false;
    compatibilityFallbackMode.value = normalizeCompatibilityFallbackMode(
      await window.tvApi.getSetting("compatibilityFallbackMode", "automatic"),
    );
    playbackMode.value = normalizePlaybackMode(await window.tvApi.getSetting("playbackMode", "auto"));
    nativeLibmpvEnabled.value = await window.tvApi.getSetting("nativeLibmpvEnabled", true) !== false;
    playbackEnginePreferences.value = normalizePlaybackEnginePreferences(
      await window.tvApi.getSetting("playbackEnginePreferences", {}),
    );
    webPlayerEngine.value = normalizeWebPlayerEngine(
      await window.tvApi.getSetting("webPlayerEngine", "legacy"),
    );
    autoFallbackSource.value = await window.tvApi.getSetting("autoFallbackSource", true) !== false;
    autoNextEpisode.value = await window.tvApi.getSetting("autoNextEpisode", true) !== false;
    const savedExternalPlayer = await window.tvApi.getSetting("externalPlayerPreference", "system");
    externalPlayerPreference.value = ["iina", "vlc", "system"].includes(savedExternalPlayer) ? savedExternalPlayer : "system";
    if (!supportsExternalIina.value && externalPlayerPreference.value === "iina") externalPlayerPreference.value = "system";
    fontSize.value = normalizeFontSize(await window.tvApi.getSetting("fontSize", "standard"));
    const savedTheme = await window.tvApi.getSetting("themeMode", "system");
    themeMode.value = ["system", "dark", "light"].includes(savedTheme) ? savedTheme : "system";
    applyResolvedTheme();
    homeCarouselEnabled.value = await window.tvApi.getSetting("homeCarouselEnabled", true) !== false;
    catVodRemoteAccessPolicy.value = await window.tvApi.getSetting("catVodRemoteAccessPolicy", "allow") === "block-startup"
      ? "block-startup"
      : "allow";
    const savedCatVodUpdateStrategy = await window.tvApi.getSetting("catVodUpdateStrategy", "notify");
    catVodUpdateStrategy.value = ["notify", "download-candidate", "auto-activate"].includes(savedCatVodUpdateStrategy)
      ? savedCatVodUpdateStrategy
      : "notify";
    if (window.tvApi.getReplacementRegistry) {
      const registry = await window.tvApi.getReplacementRegistry();
      replacementRegistrySource.value = registry?.source ?? "";
      replacementRegistryCount.value = Number(registry?.count ?? 0);
    }
    await refreshCatVodStatus();
    if (window.tvApi.onCatVodHostEvent) {
      removeCatVodHostEvent = window.tvApi.onCatVodHostEvent((payload: unknown) => {
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
        const event = payload as Record<string, unknown>;
        const action = String(event.action ?? "");
        if (action === "toast") {
          catVodMessage.value = String(event.message ?? "CatVod 服务通知");
          window.setTimeout(() => { catVodMessage.value = ""; }, Math.max(2, Number(event.duration ?? 5)) * 1000);
        } else if (action === "danmuPush") {
          playbackStatus.value = "CatVod 已推送弹幕信息，播放器将在支持时加载。";
        } else if (action === "serviceUpdated") {
          void Promise.all([refreshCatVodStatus(), refreshSites()]).then(async () => {
            await loadHome();
            await startSourceAudit(false);
          });
        } else if (action === "serviceError") {
          catVodMessage.value = `CatVod 启动失败：${String(event.message ?? "未知错误")}`;
        }
      });
    }
    const savedSite = await window.tvApi.getSetting("defaultSite", "");
    if (savedSite && selectableSites.value.some((site) => site.key === savedSite)) activeSite.value = savedSite;
    await nextTick();
    restoringInitialSite = false;
    if (activeSite.value && activeSite.value !== savedSite) await window.tvApi.setSetting("defaultSite", activeSite.value);
    await loadHome();
    await startSourceAudit(false);
  } catch (e) {
    showRendererError(e, "home");
  } finally {
    restoringInitialSite = false;
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  stopSourceAuditPolling();
  clearHeroRotation();
  window.removeEventListener("focus", handleHeroWindowFocus);
  window.removeEventListener("blur", handleHeroWindowBlur);
  themeMediaQuery?.removeEventListener("change", handleSystemThemeChange);
  themeMediaQuery = undefined;
  stopPanLoginPolling();
  if (panLoginTaskId.value && panLoginState.value === "waiting") {
    void window.tvApi.cancelPanLogin(panLoginTaskId.value).catch(() => undefined);
  }
  cancelActiveIncrementalSearch();
  removeIncrementalSearchEvent?.();
  removeIncrementalSearchEvent = undefined;
  removeCatVodHostEvent?.();
  removeCatVodHostEvent = undefined;
});
</script>

<template>
  <div class="app-shell" :class="[fontSizeClass, themeClass]">
    <aside class="sidebar">
      <div class="window-drag-zone"></div>
      <div class="brand-block">
        <div class="brand-mark"><AppIcon name="play" :size="17" /></div>
        <div>
          <strong>FongMi</strong>
          <span>Desktop Edition</span>
        </div>
      </div>

      <nav class="primary-nav">
        <button :class="{ active: page === 'home' }" @click="go('home')"><AppIcon name="home" />首页</button>
        <button :class="{ active: page === 'library' }" @click="go('library')"><AppIcon name="film" />片库</button>
        <button :class="{ active: page === 'search' }" @click="go('search')"><AppIcon name="search" />搜索</button>
      </nav>

      <div class="nav-label">我的</div>
      <nav class="primary-nav personal-nav">
        <button :class="{ active: page === 'favorites' }" @click="go('favorites')"><AppIcon name="heart" />收藏</button>
        <button :class="{ active: page === 'history' }" @click="go('history')"><AppIcon name="clock" />历史</button>
      </nav>

      <div class="nav-label">管理</div>
      <nav class="secondary-nav">
        <button :class="{ active: page === 'sources' }" @click="go('sources')"><AppIcon name="sources" />内容来源</button>
        <button :class="{ active: page === 'accounts' }" @click="go('accounts')"><AppIcon name="account" />账号与网盘</button>
        <button :class="{ active: page === 'settings' }" @click="go('settings')"><AppIcon name="settings" />设置</button>
      </nav>

      <div class="sidebar-status">
        <span class="status-dot" :class="{ offline: supportedSites.length === 0 }"></span>
        <div>
          <strong>{{ sourceOverviewTitle }}</strong>
          <span>{{ sourceOverviewSubtitle }}</span>
        </div>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar" :class="{ 'without-search': page === 'search' }">
        <div class="page-heading">
          <button v-if="page === 'detail'" class="icon-button back-button" @click="backFromDetail"><AppIcon name="back" /></button>
          <div>
            <small>{{ activeSiteName }}</small>
            <strong>{{ pageTitles[page] }}</strong>
          </div>
        </div>

        <div v-if="page !== 'search'" class="topbar-search">
          <AppIcon name="search" :size="18" />
          <input v-model="keyword" placeholder="搜索影片、电视剧、综艺" @keyup.enter="search" />
          <kbd>↵</kbd>
        </div>

        <button class="source-picker-trigger" :class="{ open: sourcePickerOpen }" aria-label="选择播放源" @click="toggleSourcePicker()">
          <span class="source-picker-trigger-dot" :class="{ offline: !activeSiteRecord }"></span>
          <span class="source-picker-trigger-copy"><small>当前播放源 · {{ activeSourcePackageLabel }}</small><strong>{{ activeSiteRecord?.name ?? '暂无可用播放源' }}</strong></span>
          <AppIcon name="chevron" :size="15" />
        </button>
      </header>

      <button v-if="sourcePickerOpen" class="source-picker-backdrop" aria-label="关闭播放源选择器" @click="toggleSourcePicker(false)"></button>
      <aside v-if="sourcePickerOpen" class="source-picker-panel" aria-label="播放源选择器">
        <div class="source-picker-heading"><div><small>QUICK SOURCE</small><h2>选择播放源</h2></div><button class="icon-button" title="关闭" @click="toggleSourcePicker(false)"><AppIcon name="close" :size="17" /></button></div>
        <div class="source-picker-context">
          <span class="source-live-dot"></span>
          <span><small>当前来源包</small><strong>{{ activeSourcePackageLabel }}</strong></span>
          <em>{{ activeSourcePackageSiteCount }} 个可用影视源</em>
        </div>
        <label class="source-picker-search"><AppIcon name="search" :size="17" /><input v-model="sourcePickerQuery" autofocus placeholder="搜索来源，例如：玩偶、4K、韩剧" /></label>
        <div class="source-picker-tabs">
          <button v-for="item in [{ key: 'all', label: '全部' }, { key: 'favorite', label: '收藏' }, { key: 'recent', label: '最近使用' }, { key: '4k', label: '4K' }, { key: 'quick', label: '秒播' }, { key: 'collect', label: '采集' }] as const" :key="item.key" :class="{ active: sourcePickerFilter === item.key }" @click="sourcePickerFilter = item.key">{{ item.label }}</button>
        </div>
        <div v-if="sourcePickerGroups.length" class="source-picker-groups">
          <section v-for="group in sourcePickerGroups" :key="group.key" class="source-picker-group">
            <div class="source-picker-group-title"><strong>{{ group.label }}</strong><span>{{ group.items.length }}</span></div>
            <button v-for="site in group.items" :key="site.key" class="source-picker-item" :class="{ active: activeSite === site.key }" @click="selectSource(site.key)">
              <span class="source-quick-icon" :class="`group-${sourceDisplayGroup(site)}`">{{ sourceGroupIcon(site) }}</span>
              <span class="source-picker-item-copy"><strong>{{ site.name }}</strong><small>{{ sourceDescription(site) }}</small></span>
              <span class="source-picker-status-stack"><span v-if="activeSite === site.key" class="source-current-label">当前</span><span v-else class="source-available-label" :class="sourceStatusClass(site)">{{ sourceStatusText(site) }}</span><span class="source-favorite-toggle" :class="{ selected: isSourceFavorite(site.key) }" role="button" :aria-label="isSourceFavorite(site.key) ? '取消收藏来源' : '收藏来源'" @click.stop="toggleSourceFavorite(site.key)"><AppIcon name="heart" :size="13" /></span></span>
            </button>
          </section>
        </div>
        <div v-else class="source-picker-empty"><AppIcon name="search" :size="24" /><strong>没有找到匹配来源</strong><span>尝试更换关键词或分类</span></div>
        <div class="source-picker-footer">当前来源包：{{ activeSourcePackageLabel }}。列表只展示其中可用的影视播放源。</div>
      </aside>

      <div v-if="displayedError" class="global-message error-message" :class="{ expanded: errorTechnicalOpen }">
        <span>!</span>
        <div class="message-copy">
          <p>{{ displayedError.message }}</p>
          <button v-if="displayedError.technicalDetail" class="technical-toggle" @click="errorTechnicalOpen = !errorTechnicalOpen">{{ errorTechnicalOpen ? '收起技术详情' : '技术详情' }}</button>
          <pre v-if="displayedError.technicalDetail && errorTechnicalOpen">{{ displayedError.technicalDetail }}</pre>
        </div>
        <div class="message-actions">
          <button v-if="recoveryCandidate" class="message-action" @click="searchAlternativeSources">查找其他来源</button>

          <button v-if="displayedError.recoveryAction" class="message-action" :disabled="loading || homeLoading || libraryLoading || panStatusLoading || checkingSite === '__all__'" @click="runErrorRecovery">{{ displayedError.recoveryLabel }}</button>
          <button @click="dismissError"><AppIcon name="close" :size="16" /></button>
        </div>
      </div>

      <div v-if="playbackStatus" class="global-message info-message">
        <AppIcon name="info" :size="18" />
        <p>{{ playbackStatus }}</p>
        <button v-if="sniffing" class="message-action" @click="cancelSniff">取消嗅探</button>
        <button v-else @click="playbackStatus = ''"><AppIcon name="close" :size="16" /></button>
      </div>

      <main class="content" :class="{ 'with-player': playing }">
        <section v-if="page === 'home'" class="page home-page redesigned-home">
          <div v-if="homeLoading" class="hero hero-loading">
            <div class="loading-spinner"></div>
            <strong>正在加载 {{ activeSiteName }} 的首页内容</strong>
            <span>切换来源后，推荐、电影和电视剧会同步刷新。</span>
          </div>

          <div v-else-if="hero" class="hero home-featured home-carousel" :class="{ 'without-image': !heroHasImage }" :style="heroStyle" @mouseenter="setHeroHovered(true)" @mouseleave="setHeroHovered(false)">
            <img v-if="heroHasImage" class="image-load-probe" :src="hero.vodPic" alt="" @error="markImageBroken(hero.vodPic)" />
            <div class="hero-content">
              <div class="featured-label">最近热播</div>
              <h1>{{ hero.vodName }}</h1>
              <div class="hero-meta featured-meta">
                <span v-if="hero.vodYear">{{ hero.vodYear }}</span>
                <span v-if="hero.typeName">{{ hero.typeName }}</span>
                <span v-if="hero.vodArea">{{ hero.vodArea }}</span>
              </div>
              <strong class="featured-ranking"><AppIcon name="play" :size="15" />推荐 {{ heroIndex + 1 }} / {{ homeRecommendations.length }}</strong>
              <p>{{ hero.vodContent || hero.vodRemarks || '当前内容来源最近热播的电影或电视剧。' }}</p>
              <div class="hero-actions">
                <button class="primary-button light-primary" @click="hero.contentKind === 'discovery' ? searchDiscovery(hero) : openAndPlay(hero, 'home')"><AppIcon name="play" :size="17" />{{ hero.contentKind === 'discovery' ? '查找播放源' : '立即播放' }}</button>
                <button class="secondary-button" @click="hero.contentKind === 'discovery' ? searchDiscovery(hero) : openDetail(hero, 'home')">{{ hero.contentKind === 'discovery' ? '查看可用来源' : '查看详情' }}</button>
              </div>
            </div>
            <div v-if="homeRecommendations.length > 1" class="hero-carousel-controls">
              <button class="hero-nav previous" title="上一条推荐" @click="moveHero(-1)"><AppIcon name="chevron" :size="18" /></button>
              <div class="hero-dots" aria-label="推荐内容切换">
                <button v-for="(item, index) in homeRecommendations" :key="homeItemIdentity(item)" :class="{ active: heroIndex === index }" :title="item.vodName" @click="selectHero(index)"></button>
              </div>
              <button class="hero-nav next" title="下一条推荐" @click="moveHero(1)"><AppIcon name="chevron" :size="18" /></button>
            </div>
          </div>

          <div v-else class="hero hero-empty">
            <div class="hero-content">
              <div class="eyebrow"><span></span>欢迎使用 FongMi</div>
              <h1>{{ sites.length ? '当前播放源暂无推荐内容' : '导入播放源，开始浏览' }}</h1>
              <p>{{ sites.length ? '可以切换其他播放源，或直接搜索想看的影视内容。' : '导入一个播放源配置后，热门内容会出现在这里。' }}</p>
              <button class="primary-button" @click="go('sources')"><AppIcon name="plus" :size="17" />{{ sites.length ? '管理播放源' : '添加播放源' }}</button>
            </div>
          </div>

          <section v-if="continueItems.length" class="content-section continue-section">
            <div class="section-heading inline-heading">
              <div><h2>继续观看</h2><small>CONTINUE WATCHING</small></div>
              <button class="text-button" @click="go('history')">查看全部 <AppIcon name="chevron" :size="15" /></button>
            </div>
            <div class="continue-row continue-poster-row">
              <button v-for="item in continueItems" :key="`${item.siteKey}:${item.vodId}:${item.episodeName}`" class="continue-card continue-landscape-card" @click="openAndPlay(item, 'home')">
                <div class="continue-cover" :style="hasUsableImage(item.vodPic) ? { backgroundImage: `linear-gradient(0deg, rgba(5,8,13,.92), rgba(5,8,13,.05) 72%), url(${item.vodPic})` } : {}">
                  <img v-if="hasUsableImage(item.vodPic)" class="image-load-probe" :src="item.vodPic" alt="" @error="markImageBroken(item.vodPic)" />
                  <div v-if="!hasUsableImage(item.vodPic)" class="continue-cover-fallback" :class="posterFallbackClass(item.vodName)"><AppIcon name="film" :size="28" /></div>
                  <div class="continue-overlay-copy"><strong>{{ item.vodName }}</strong><span>{{ item.episodeName }}</span></div>
                  <i><b :style="{ width: `${progressPercent(item)}%` }"></b></i>
                  <em>{{ Math.round(progressPercent(item)) }}%</em>
                </div>
              </button>
            </div>
          </section>

          <div v-if="homeMovieItems.length || homeTvItems.length" class="home-discovery-grid">
            <section v-if="homeMovieItems.length" class="content-section home-poster-section">
              <div class="section-heading compact-section-heading">
                <div><h2>电影推荐</h2><small>当前来源</small></div>
                <button class="text-button" @click="openStandardLibraryCategory('movie')">查看全部 <AppIcon name="chevron" :size="15" /></button>
              </div>
              <div class="poster-grid home-compact-grid">
                <button v-for="item in homeMovieItems" :key="`${item.siteKey}:${item.vodId}`" class="poster-card" @click="openDetail(item, 'home')">
                  <div class="poster-image"><img v-if="hasUsableImage(item.vodPic)" :src="item.vodPic" :alt="item.vodName" loading="lazy" @error="markImageBroken(item.vodPic)" /><div v-else class="poster-fallback" :class="posterFallbackClass(item.vodName)"><AppIcon name="film" :size="30" /><span>{{ item.vodName.slice(0, 1) }}</span></div><span v-if="item.vodRemarks" class="poster-badge">{{ item.vodRemarks }}</span><div class="poster-hover"><AppIcon name="play" :size="16" />查看详情</div></div>
                  <strong>{{ item.vodName }}</strong><span>{{ item.vodYear || item.typeName || activeSiteName }}</span>
                </button>
              </div>
            </section>

            <section v-if="homeTvItems.length" class="content-section home-poster-section popular-section">
              <div class="section-heading compact-section-heading">
                <div><h2>电视剧推荐</h2><small>当前来源</small></div>
                <button class="text-button" @click="openStandardLibraryCategory('tv')">查看全部 <AppIcon name="chevron" :size="15" /></button>
              </div>
              <div class="poster-grid home-compact-grid">
                <button v-for="item in homeTvItems" :key="`${item.siteKey}:${item.vodId}`" class="poster-card" @click="openDetail(item, 'home')">
                  <div class="poster-image"><img v-if="hasUsableImage(item.vodPic)" :src="item.vodPic" :alt="item.vodName" loading="lazy" @error="markImageBroken(item.vodPic)" /><div v-else class="poster-fallback" :class="posterFallbackClass(item.vodName)"><AppIcon name="film" :size="30" /><span>{{ item.vodName.slice(0, 1) }}</span></div><span v-if="item.vodRemarks" class="poster-badge">{{ item.vodRemarks }}</span><div class="poster-hover"><AppIcon name="play" :size="16" />查看详情</div></div>
                  <strong>{{ item.vodName }}</strong><span>{{ item.vodYear || item.typeName || activeSiteName }}</span>
                </button>
              </div>
            </section>
          </div>

          <section v-if="quickCategories.length" class="content-section quick-entry-section">
            <div class="section-heading compact-section-heading"><div><h2>分类与收藏</h2></div></div>
            <div class="quick-entry-grid">
              <button v-for="(category, index) in quickCategories" :key="category.id" class="quick-entry-card" :class="`entry-${index % 6}`" @click="openLibraryCategory(category)">
                <span class="quick-entry-icon"><AppIcon :name="category.id === '__favorites__' ? 'heart' : 'film'" :size="23" /></span>
                <span><strong>{{ category.name }}</strong><small>{{ category.id === '__favorites__' ? `${favorites.length} 部收藏` : '浏览当前来源' }}</small></span>
              </button>
            </div>
          </section>

          <div v-if="!homeWallItems.length && !homeLoading" class="empty-state compact-empty home-empty-content">
            <div class="empty-icon"><AppIcon name="film" :size="28" /></div>
            <h3>暂无首页内容</h3><p>可以前往搜索，或切换其他播放源。</p>
          </div>
        </section>

        <section v-else-if="page === 'library'" class="page library-page redesigned-library">
          <div class="library-header">
            <div><small>LIBRARY</small><h1>片库</h1><p>浏览当前内容来源提供的影片与剧集。</p></div>
            <div v-if="libraryLoading" class="loading-spinner"></div>
          </div>

          <section class="library-source-context">
            <span class="source-live-dot"></span>
            <div><small>当前来源片库</small><strong>{{ activeSiteRecord?.name ?? '暂无可用内容来源' }}</strong><p>内容、分类和筛选条件由当前来源提供，切换来源后片库会同步更新。</p></div>
            <button class="secondary-button" @click="go('sources')"><AppIcon name="sources" :size="15" />切换内容来源</button>
          </section>

          <div class="library-category-tabs">
            <button v-for="category in libraryCategories" :key="category.id || '__all__'" :class="{ active: libraryCategory === category.id }" @click="openLibraryCategory(category)">{{ category.name }}</button>
          </div>

          <div v-if="selectedLibraryCategory?.id === 'more'" class="library-original-categories"><span>来源原始分类</span><div><em v-for="category in selectedLibraryCategory.sourceCategories" :key="category.id">{{ category.name }}</em></div></div>

          <div v-if="hasRemoteLibraryFilters" class="library-filter-bar remote-filter-bar">
            <div v-for="group in activeLibraryFilterGroups" :key="group.key" class="library-filter-group"><span>{{ group.name }}</span><button v-for="option in group.options" :key="`${group.key}:${option.value}`" :class="{ active: libraryFilters[group.key] === option.value }" @click="changeLibraryFilter(group, option.value)">{{ option.label }}</button></div>
          </div>
          <div v-else class="library-filter-bar">
            <div v-if="libraryAreas.length > 1" class="library-filter-group"><span>地区</span><button v-for="area in libraryAreas" :key="area" :class="{ active: libraryArea === area }" @click="libraryArea = area">{{ area }}</button></div>
            <div v-if="libraryYears.length > 1" class="library-filter-group"><span>年份</span><button v-for="year in libraryYears" :key="year" :class="{ active: libraryYear === year }" @click="libraryYear = year">{{ year }}</button></div>
            <div class="library-filter-group"><span>排序</span><button v-for="sort in ['来源默认', '名称'] as const" :key="sort" :class="{ active: librarySort === sort }" @click="librarySort = sort">{{ sort }}</button></div>
          </div>

          <div class="library-summary-row"><span>共 {{ visibleLibraryItems.length }} 部</span><div><button class="library-view-button active"><AppIcon name="grid" :size="16" /></button></div></div>

          <div v-if="visibleLibraryItems.length" class="poster-grid full-library-grid">
            <button v-for="item in visibleLibraryItems" :key="`${item.siteKey}:${item.vodId}`" class="poster-card library-poster-card" @click="openDetail(item, 'library')">
              <div class="poster-image"><img v-if="hasUsableImage(item.vodPic)" :src="item.vodPic" :alt="item.vodName" loading="lazy" @error="markImageBroken(item.vodPic)" /><div v-else class="poster-fallback" :class="posterFallbackClass(item.vodName)"><AppIcon name="film" :size="30" /><span>{{ item.vodName.slice(0, 1) }}</span></div><span v-if="item.vodRemarks" class="poster-badge">{{ item.vodRemarks }}</span><div class="poster-hover"><AppIcon name="play" :size="16" />查看详情</div></div>
              <strong>{{ item.vodName }}</strong><span>{{ [item.vodYear, item.typeName].filter(Boolean).join(' · ') || item.siteName || activeSiteName }}</span>
            </button>
          </div>
          <div v-else-if="!libraryLoading" class="empty-state"><div class="empty-icon"><AppIcon name="film" :size="30" /></div><h2>当前分类暂无内容</h2><p>可以切换分类或其他播放源后再次查看。</p></div>
          <div v-if="selectedLibraryCategory?.sourceCategories.length && libraryHasMore" class="library-load-more"><button class="secondary-button" :disabled="libraryLoading" @click="loadMoreLibrary">{{ libraryLoading ? '加载中…' : `加载更多（${libraryPage}/${libraryPageCount}）` }}</button></div>
        </section>

        <section v-else-if="page === 'search'" class="page search-page redesigned-search">
          <div class="search-header-row">
            <div><small>{{ folderTrail.length ? 'FOLDER' : 'SEARCH' }}</small><h1>{{ folderTrail.length ? searchTitle : '搜索' }}</h1></div>
            <div v-if="!folderTrail.length" class="search-scope"><button :class="{ active: searchScope === 'smart' }" @click="setSearchScope('smart')">智能搜索</button><button :class="{ active: searchScope === 'current' }" @click="setSearchScope('current')">仅当前来源</button></div>
            <button v-else class="secondary-button" @click="backFolder"><AppIcon name="back" :size="15" />返回上级</button>
          </div>

          <div v-if="folderTrail.length" class="folder-breadcrumb">
            <button @click="go('library')">片库</button>
            <template v-for="(folder, index) in folderTrail" :key="`${folder.siteKey}:${folder.folderId}:${index}`">
              <span>/</span><button :class="{ active: index === folderTrail.length - 1 }" @click="openFolderTrail(index)">{{ folder.title }}</button>
            </template>
            <em>{{ visibleFolderItems.length }} / {{ results.length }} 项</em>
          </div>

          <div v-if="folderTrail.length" class="folder-toolbar">
            <label><AppIcon name="search" :size="16" /><input v-model="folderQuery" placeholder="搜索当前目录" /></label>
            <select v-model="folderSort" aria-label="目录排序"><option value="default">来源默认</option><option value="name-asc">名称升序</option><option value="name-desc">名称降序</option><option value="type">按类型</option></select>
            <span>文件夹优先 · 当前第 {{ folderPage }} 页</span>
          </div>

          <div v-if="!folderTrail.length" class="search-command-panel">
            <div class="search-command-input"><AppIcon name="search" :size="23" /><input v-model="keyword" placeholder="搜索影片、电视剧、演员" @keyup.enter="search" /><button v-if="keyword" @click="keyword = ''"><AppIcon name="close" :size="16" /></button></div>
            <div class="search-suggestions">
              <div><strong><AppIcon name="clock" :size="14" />最近搜索</strong><div><button v-for="item in recentSearches" :key="item" @click="searchSuggestion(item)">{{ item }}</button><span v-if="!recentSearches.length">暂无搜索记录</span></div></div>
              <div><strong><AppIcon name="play" :size="14" />热门搜索</strong><div><button v-for="item in hotSearchTerms" :key="item" @click="searchSuggestion(item)">{{ item }}</button><span v-if="!hotSearchTerms.length">暂无热门内容</span></div></div>
            </div>
          </div>

          <div v-if="results.length" class="search-result-header">
            <div><h2>{{ folderTrail.length ? `当前目录 ${results.length} 项` : `找到 ${results.length} 个结果，已聚合为 ${searchGroups.length} 部内容` }}</h2><span v-if="!folderTrail.length && (searchStatuses.length || searchProgress.running)">{{ searchProgress.running ? (searchScope === 'smart' && !searchExpandedToAllSources ? `正在搜索首批来源 ${searchProgress.completed}/${searchProgress.total || '…'}` : `正在搜索更多来源 ${searchProgress.completed}/${searchProgress.total || '…'}`) : searchExpandedToAllSources ? '已按质量优先搜索更多来源' : searchScope === 'smart' ? '已优先搜索当前、最近和高质量来源' : '仅搜索当前来源' }}<template v-if="searchStatuses.length"> · {{ searchSuccessCount }} 个来源返回<span v-if="searchErrorCount"> · {{ searchErrorCount }} 个来源异常</span></template></span><span v-else-if="folderTrail.length">文件夹会继续进入目录，文件会打开详情或直接播放。</span></div>
            <div v-if="!folderTrail.length" class="search-category-tabs"><button v-for="category in searchCategoryOptions" :key="category" :class="{ active: searchCategory === category }" @click="searchCategory = category">{{ category }}</button></div>
          </div>

          <div v-if="searchGroups.length" class="search-result-grid">
            <article v-for="group in searchGroups" :key="group.key" class="search-result-card">
              <div class="search-result-poster"><img v-if="hasUsableImage(group.primary.vodPic)" :src="group.primary.vodPic" :alt="group.primary.vodName" @error="markImageBroken(group.primary.vodPic)" /><div v-else class="poster-fallback" :class="posterFallbackClass(group.primary.vodName)"><AppIcon name="film" :size="28" /><span>{{ group.primary.vodName.slice(0, 1) }}</span></div></div>
              <div class="search-result-copy">
                <h3>{{ group.primary.vodName }}</h3>
                <p v-if="folderTrail.length">{{ folderItemTypeLabel(group.primary) }}<template v-if="group.primary.vodRemarks"> · {{ group.primary.vodRemarks }}</template></p>
                <p v-else>{{ [group.primary.vodYear, group.primary.typeName, group.primary.vodArea].filter(Boolean).join(' · ') }}</p>
                <span v-if="folderTrail.length">{{ group.primary.siteName || '当前网盘目录' }}</span><span v-else>{{ group.items.length }} 个可用来源</span>
                <div v-if="!folderTrail.length" class="search-source-list">
                  <button v-for="item in group.items.slice(0, 6)" :key="`${item.siteKey}:${item.vodId}`" @click="openDetail(item, 'search')">
                    <strong>{{ item.siteName || '未命名来源' }}</strong>
                    <small v-if="item.configName">{{ item.configName }}</small>
                  </button>
                  <em v-if="group.items.length > 6">+{{ group.items.length - 6 }}</em>
                </div>
                <div v-if="folderTrail.length" class="search-result-actions"><button class="secondary-button" :disabled="isSubtitleFolderItem(group.primary)" @click="openDetail(group.primary, 'search')"><AppIcon :name="isFolderItem(group.primary) ? 'sources' : 'play'" :size="15" />{{ isFolderItem(group.primary) ? '打开目录' : isSubtitleFolderItem(group.primary) ? '字幕文件' : '打开文件' }}</button></div>
                <div v-else class="search-result-actions"><button class="search-play-button" @click="openAndPlay(group.primary, 'search')"><AppIcon name="play" :size="16" /></button><button class="secondary-button" @click="openDetail(group.primary, 'search')">查看详情</button></div>
              </div>
            </article>
          </div>
          <div v-if="!folderTrail.length && searchProgress.running" class="search-load-more"><button class="secondary-button" disabled>正在搜索更多来源 {{ searchProgress.completed }}/{{ searchProgress.total || '…' }}</button></div>
          <div v-else-if="!folderTrail.length && keyword && searchScope === 'smart' && !searchExpandedToAllSources" class="search-load-more"><button class="secondary-button" :disabled="searchLoadingMore || loading" @click="searchMoreSources">搜索更多来源</button></div>
          <div v-else-if="!folderTrail.length && searchGroups.length && searchHasMore" class="search-load-more"><button class="secondary-button" :disabled="searchLoadingMore" @click="loadMoreSearch">{{ searchLoadingMore ? '正在加载下一页…' : `加载更多搜索结果（第 ${searchPage + 1} 页）` }}</button></div>
          <div v-else-if="folderTrail.length && folderHasMore" class="search-load-more"><button class="secondary-button" :disabled="folderLoadingMore" @click="loadMoreFolder">{{ folderLoadingMore ? '正在加载目录下一页…' : `加载更多目录内容（第 ${folderPage + 1} 页）` }}</button></div>

          <div v-if="!folderTrail.length && searchProgress.running && !searchGroups.length" class="empty-state compact-empty search-empty"><div class="loading-spinner"></div><h2>正在搜索其他可用来源</h2><p>有结果的来源会立即显示，无需等待全部来源完成。</p></div>
          <div v-else-if="!searchGroups.length && !loading" class="empty-state search-empty"><div class="empty-icon"><AppIcon :name="folderTrail.length ? 'sources' : 'search'" :size="30" /></div><h2>{{ folderTrail.length ? '当前目录为空' : searchEmptyState.title }}</h2><p>{{ folderTrail.length ? '可以返回上一级目录，或刷新账号状态后重试。' : searchEmptyState.description }}</p></div>
        </section>

        <section v-else-if="page === 'detail' && selected" class="page detail-page">
          <div class="detail-hero" :class="{ 'without-poster': !hasUsableImage(selected.vodPic) }">
            <div class="detail-backdrop" :style="hasUsableImage(selected.vodPic) ? { backgroundImage: `url(${selected.vodPic})` } : {}"></div>
            <div class="detail-overlay"></div>
            <div class="detail-layout">
              <div class="detail-poster">
                <img v-if="hasUsableImage(selected.vodPic)" :src="selected.vodPic" :alt="selected.vodName" @error="markImageBroken(selected.vodPic)" />
                <div v-else class="poster-fallback detail-poster-fallback" :class="posterFallbackClass(selected.vodName)"><AppIcon name="film" :size="42" /><span>{{ selected.vodName.slice(0, 1) }}</span></div>
              </div>
              <div class="detail-copy">
                <span class="detail-source">{{ selected.siteName || activeSiteName }}</span>
                <h1>{{ selected.vodName }}</h1>
                <div class="detail-meta">
                  <span v-if="selected.vodYear">{{ selected.vodYear }}</span>
                  <span v-if="selected.vodArea">{{ selected.vodArea }}</span>
                  <span v-if="selected.typeName">{{ selected.typeName }}</span>
                  <span v-if="selected.vodRemarks">{{ selected.vodRemarks }}</span>
                </div>
                <p class="detail-summary">{{ selected.vodContent || '暂无内容简介。' }}</p>
                <div v-if="selected.vodDirector || selected.vodActor" class="detail-credits">
                  <p v-if="selected.vodDirector"><span>导演</span>{{ selected.vodDirector }}</p>
                  <p v-if="selected.vodActor"><span>主演</span>{{ selected.vodActor }}</p>
                </div>
                <div v-if="selectedHistory" class="resume-summary">
                  <span>上次看到 {{ selectedHistory.episodeName }}</span>
                  <strong>{{ formatDuration(selectedHistory.position) }} / {{ formatDuration(selectedHistory.duration) }}</strong>
                  <i><b :style="{ width: `${progressPercent(selectedHistory)}%` }"></b></i>
                </div>
                <div class="detail-actions">
                  <button class="primary-button" :disabled="!selected.flags?.length" @click="playFirstEpisode"><AppIcon name="play" :size="17" />{{ selectedHistory ? `继续播放 · ${selectedHistory.episodeName}` : '立即播放' }}</button>
                  <button class="secondary-button favorite-button" :class="{ selected: isSelectedFavorite }" @click="toggleFavorite"><AppIcon name="heart" :size="17" />{{ isSelectedFavorite ? '已收藏' : '收藏' }}</button>
                </div>
              </div>
            </div>
          </div>

          <div class="episode-panel">
            <div class="section-heading episode-heading">
              <div><small>EPISODES</small><h2>选集播放</h2></div>
              <span>{{ activeLine?.episodes.length ?? 0 }} 集</span>
            </div>
            <div v-if="selected.flags?.length" class="line-tabs">
              <button v-for="line in selected.flags" :key="line.flag" :class="{ active: selectedFlag === line.flag }" @click="selectPlaybackLine(line.flag)">{{ line.show || line.flag }}{{ preferredPlaybackLine?.flag === line.flag ? ' · 推荐' : '' }}</button>
            </div>
            <div v-if="activeLine?.episodes.length" class="episode-grid">
              <button v-for="episode in activeLine.episodes" :key="episode.url" :class="{ watched: selectedHistory?.episodeUrl === episode.url }" @click="play(activeLine.flag, episode, selectedHistory?.episodeUrl === episode.url ? selectedHistory.position : 0)">
                <span>{{ episode.name }}</span>
                <small v-if="selectedHistory?.episodeUrl === episode.url">继续</small>
                <AppIcon name="play" :size="15" />
              </button>
            </div>
            <div v-else class="empty-state compact-empty"><p>当前详情没有返回可播放剧集。</p></div>
          </div>
        </section>

        <section v-else-if="page === 'favorites'" class="page">
          <div class="page-title-row">
            <div><small>LIBRARY</small><h1>我的收藏</h1><p>已收藏 {{ favorites.length }} 部内容</p></div>
          </div>
          <div v-if="favorites.length" class="poster-grid library-grid">
            <article v-for="item in favorites" :key="`${item.siteKey}:${item.vodId}`" class="library-card">
              <button class="poster-card" @click="openDetail(item, 'favorites')">
                <div class="poster-image">
                  <img v-if="hasUsableImage(item.vodPic)" :src="item.vodPic" :alt="item.vodName" @error="markImageBroken(item.vodPic)" />
                  <div v-else class="poster-fallback" :class="posterFallbackClass(item.vodName)"><AppIcon name="film" :size="30" /><span>{{ item.vodName.slice(0, 1) }}</span></div>
                  <div class="poster-hover"><AppIcon name="play" :size="16" />查看详情</div>
                </div>
                <strong>{{ item.vodName }}</strong>
                <span>收藏于 {{ formatDate(item.createdAt) }}</span>
              </button>
              <button class="card-remove" title="取消收藏" @click="removeFavorite(item)"><AppIcon name="close" :size="14" /></button>
            </article>
          </div>
          <div v-else class="empty-state">
            <div class="empty-icon"><AppIcon name="heart" :size="30" /></div>
            <h2>还没有收藏内容</h2>
            <p>在影片详情页点击收藏，喜欢的内容会出现在这里。</p>
            <button class="secondary-button" @click="go('search')">去搜索</button>
          </div>
        </section>

        <section v-else-if="page === 'history'" class="page">
          <div class="page-title-row">
            <div><small>RECENTLY WATCHED</small><h1>播放历史</h1><p>最近观看的内容和剧集</p></div>
            <button v-if="histories.length" class="secondary-button danger-subtle" @click="clearHistory"><AppIcon name="trash" :size="15" />清空历史</button>
          </div>
          <div v-if="histories.length" class="history-list">
            <article v-for="item in histories" :key="`${item.siteKey}:${item.vodId}:${item.episodeName}`" class="history-item">
              <button class="history-open" @click="openDetail(item, 'history')">
                <div class="history-art"><AppIcon name="film" :size="24" /></div>
                <div class="history-copy">
                  <strong>{{ item.vodName }}</strong>
                  <span>{{ item.episodeName }} · {{ formatDuration(item.position) }} / {{ formatDuration(item.duration) }}</span>
                  <i><b :style="{ width: `${progressPercent(item)}%` }"></b></i>
                </div>
                <time>{{ formatDate(item.updatedAt) }}</time>
                <span class="history-action">继续观看 <AppIcon name="chevron" :size="15" /></span>
              </button>
              <button class="history-remove" title="删除这条历史" @click="removeHistory(item)"><AppIcon name="trash" :size="16" /></button>
            </article>
          </div>
          <div v-else class="empty-state">
            <div class="empty-icon"><AppIcon name="clock" :size="30" /></div>
            <h2>暂无播放历史</h2>
            <p>开始播放后，最近观看的内容会自动保存在这里。</p>
          </div>
        </section>

        <section v-else-if="page === 'sources'" class="page sources-page quick-source-page">
          <div class="quick-source-header">
            <div><small>CONTENT SOURCES</small><h1>内容来源</h1><p>在一个页面完成来源选择、配置导入、配置切换和可用性检查。</p></div>
            <button class="secondary-button" :disabled="sourceAuditStatus.running || checkingSite === '__all__'" @click="refreshSourceStatus"><AppIcon name="refresh" :size="16" />{{ sourceAuditStatus.running || checkingSite === '__all__' ? `检测中 ${sourceAuditProgress}%` : '检查并修复' }}</button>
          </div>

          <label class="quick-source-search"><AppIcon name="search" :size="18" /><input v-model="sourcePageQuery" placeholder="搜索播放源，例如：玩偶、4K、韩剧" /></label>
          <div class="quick-source-tabs">
            <button v-for="item in [{ key: 'all', label: '全部' }, { key: 'favorite', label: '收藏' }, { key: 'recent', label: '最近使用' }, { key: '4k', label: '4K' }, { key: 'quick', label: '秒播' }, { key: 'collect', label: '采集' }] as const" :key="item.key" :class="{ active: sourcePageFilter === item.key }" @click="sourcePageFilter = item.key">{{ item.label }}</button>
          </div>

          <section v-if="sourcePageFilter === 'all' && favoriteSourceSites.length" class="quick-source-section">
            <div class="quick-source-section-heading"><div><h2>收藏来源</h2><span>你手动固定的常用播放源</span></div><em>{{ Math.min(favoriteSourceSites.length, 4) }}</em></div>
            <div class="quick-source-grid recent-source-grid">
              <button v-for="site in favoriteSourceSites.slice(0, 4)" :key="`favorite:${site.key}`" class="quick-source-card" :class="{ active: activeSite === site.key }" @click="selectSource(site.key)">
                <span class="source-quick-icon" :class="`group-${sourceDisplayGroup(site)}`">{{ sourceGroupIcon(site) }}</span>
                <span class="quick-source-card-copy"><strong>{{ site.name }}</strong><small>{{ sourceDescription(site) }}</small></span>
                <span class="quick-source-state" :class="sourceStatusClass(site)"><i></i>{{ activeSite === site.key ? '当前' : sourceStatusText(site) }}</span>
                <span class="source-favorite-toggle quick-source-favorite selected" role="button" aria-label="取消收藏来源" @click.stop="toggleSourceFavorite(site.key)"><AppIcon name="heart" :size="13" /></span>
                <span v-if="activeSite === site.key" class="quick-source-check"><AppIcon name="check" :size="14" /></span>
              </button>
            </div>
          </section>

          <section v-if="sourcePageFilter === 'all' && recentSourceSites.length" class="quick-source-section">
            <div class="quick-source-section-heading"><div><h2>最近使用</h2><span>结合最近播放成功和响应速度排序</span></div><em>{{ Math.min(recentSourceSites.length, 4) }}</em></div>
            <div class="quick-source-grid recent-source-grid">
              <button v-for="site in recentSourceSites.slice(0, 4)" :key="`recent:${site.key}`" class="quick-source-card" :class="{ active: activeSite === site.key }" @click="selectSource(site.key)">
                <span class="source-quick-icon" :class="`group-${sourceDisplayGroup(site)}`">{{ sourceGroupIcon(site) }}</span>
                <span class="quick-source-card-copy"><strong>{{ site.name }}</strong><small>{{ sourceDescription(site) }}</small></span>
                <span class="quick-source-state" :class="sourceStatusClass(site)"><i></i>{{ activeSite === site.key ? '当前' : sourceStatusText(site) }}</span>
                <span class="source-favorite-toggle quick-source-favorite" :class="{ selected: isSourceFavorite(site.key) }" role="button" :aria-label="isSourceFavorite(site.key) ? '取消收藏来源' : '收藏来源'" @click.stop="toggleSourceFavorite(site.key)"><AppIcon name="heart" :size="13" /></span>
                <span v-if="activeSite === site.key" class="quick-source-check"><AppIcon name="check" :size="14" /></span>
              </button>
            </div>
          </section>

          <section class="quick-source-section">
            <div class="quick-source-section-heading"><div><h2>{{ sourcePageFilter === 'all' ? '全部内容来源' : sourcePageFilter === 'favorite' ? '收藏来源' : sourcePageFilter === 'recent' ? '最近使用' : sourcePageFilter === '4k' ? '4K 来源' : sourcePageFilter === 'quick' ? '秒播来源' : '采集来源' }}</h2><span>按收藏、最近使用、播放成功、搜索表现和响应速度排序</span></div><em>{{ sourcePageSites.length }}</em></div>
            <div v-if="sourcePageSites.length" class="quick-source-grid">
              <button v-for="site in sourcePageSites" :key="site.key" class="quick-source-card" :class="{ active: activeSite === site.key }" @click="selectSource(site.key)">
                <span class="source-quick-icon" :class="`group-${sourceDisplayGroup(site)}`">{{ sourceGroupIcon(site) }}</span>
                <span class="quick-source-card-copy"><strong>{{ site.name }}</strong><small>{{ sourceDescription(site) }}</small></span>
                <span class="quick-source-state" :class="sourceStatusClass(site)"><i></i>{{ activeSite === site.key ? '当前' : sourceStatusText(site) }}</span>
                <span class="source-favorite-toggle quick-source-favorite" :class="{ selected: isSourceFavorite(site.key) }" role="button" :aria-label="isSourceFavorite(site.key) ? '取消收藏来源' : '收藏来源'" @click.stop="toggleSourceFavorite(site.key)"><AppIcon name="heart" :size="13" /></span>
                <span v-if="activeSite === site.key" class="quick-source-check"><AppIcon name="check" :size="14" /></span>
              </button>
            </div>
            <div v-else class="empty-state compact-empty quick-source-empty"><div class="empty-icon"><AppIcon name="search" :size="26" /></div><h3>没有找到匹配来源</h3><p>尝试更换关键词或分类。</p></div>
          </section>

          <section class="settings-card source-config-settings-card content-source-config-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="plus" /></div><div><h2>添加内容配置</h2><p>通常只需粘贴配置地址，名称会自动识别。</p></div></div>
            <div class="source-config-overview">
              <div><span class="source-live-dot"></span><span><small>当前来源包</small><strong>{{ activeSourcePackageLabel }}</strong></span><em>{{ activeSourcePackageSiteCount }} 个可用影视源</em></div>
              <small v-if="contentSourceMessage" class="replacement-registry-message">{{ contentSourceMessage }}</small>
            </div>
            <div v-if="pendingSourceImport" class="pending-source-import-note">
              <AppIcon name="clock" :size="17" />
              <span><strong>{{ sourceImportLabel(pendingSourceImport) }} 等待切换</strong><small>当前正在播放，关闭播放器或播放完成后会自动启用新来源包。</small></span>
              <button class="secondary-button" @click="cancelPendingSourceImport">取消</button>
            </div>
            <div class="source-config-import-form simplified-source-import-form">
              <label class="source-config-url-field"><span>配置地址或本地路径</span><input v-model="configUrl" placeholder="粘贴配置地址后按回车即可导入" @keyup.enter="loadConfig()" /></label>
              <label><span>名称（可选）</span><input v-model="configName" placeholder="留空自动识别" /></label>
              <button class="primary-button" :disabled="!configUrl.trim() || loading" @click="loadConfig()"><AppIcon name="plus" :size="15" />{{ loading ? '正在导入…' : '导入并使用' }}</button>
            </div>
            <div v-if="configs.length || catVodStatus?.state === 'running'" class="source-config-settings-list">
              <article v-if="catVodStatus?.state === 'running'" class="source-config-settings-row source-runtime-settings-row" :class="{ active: activeSiteIsCatVod }">
                <span class="source-config-settings-icon"><AppIcon name="sources" :size="17" /></span>
                <div class="source-config-settings-copy"><strong>{{ catVodSourceLabel }}</strong><span>CatVod 运行环境 · {{ catVodSourceSites.length }} 个可用影视源</span></div>
                <span class="source-config-settings-state">{{ activeSiteIsCatVod ? '当前来源包' : '运行中' }}</span>
                <button v-if="!activeSiteIsCatVod && firstCatVodSourceKey" class="secondary-button" @click="selectSource(firstCatVodSourceKey)">使用</button>
              </article>
              <article v-for="config in configs" :key="config.id ?? config.url" class="source-config-settings-row" :class="{ active: config.enabled && !activeSiteIsCatVod }">
                <span class="source-config-settings-icon"><AppIcon name="sources" :size="17" /></span>
                <div v-if="editingConfigUrl === config.url" class="config-rename-row"><input v-model="editingConfigName" aria-label="配置名称" @keyup.enter="saveConfigName(config)" @keyup.esc="cancelRenameConfig" /><button class="compact-action primary" @click="saveConfigName(config)">保存</button><button class="compact-action" @click="cancelRenameConfig">取消</button></div>
                <div v-else class="source-config-settings-copy"><strong>{{ config.name }}</strong><span>{{ config.enabled ? (activeSiteIsCatVod ? '配置已载入' : '当前使用') : `更新于 ${formatDate(config.updatedAt)}` }}</span></div>
                <span class="source-config-settings-state">{{ config.enabled ? (activeSiteIsCatVod ? '已载入' : '当前') : '可切换' }}</span>
                <button v-if="!config.enabled || activeSiteIsCatVod" class="secondary-button" @click="activateConfig(config)">{{ config.enabled ? '使用' : '切换' }}</button>
                <button class="icon-button config-icon-button" title="重命名" @click="beginRenameConfig(config)"><AppIcon name="edit" :size="15" /></button>
                <button class="icon-button config-icon-button danger" :title="deletingConfigUrl === config.url ? '再次点击确认删除' : '删除配置'" @click="deleteConfig(config)"><AppIcon name="trash" :size="15" /></button>
              </article>
            </div>
          </section>

          <div class="quick-source-note"><strong>普通使用无需进入设置。</strong> CatVod 版本、日志和运行时等技术信息仍保留在高级设置中。</div>
        </section>

        <section v-else-if="page === 'accounts'" class="page accounts-page">
          <div class="page-title-row account-page-title">
            <div><small>ACCOUNTS</small><h1>账号与网盘</h1><p>只在需要时登录，应用会自动保存状态并用于播放网盘内容。</p></div>
            <button class="secondary-button" :disabled="panStatusLoading" @click="refreshPanStatus"><AppIcon name="refresh" :size="15" />{{ panStatusLoading ? '正在检查…' : '刷新状态' }}</button>
          </div>

          <small v-if="panAccountMessage" class="replacement-registry-message pan-account-message">{{ panAccountMessage }}</small>
          <div class="pan-account-grid">
            <section v-for="provider in PAN_PROVIDER_DEFINITIONS" :key="provider.id" class="pan-account-card" :class="[{ connected: panStatuses[provider.id]?.login }, `provider-${provider.id}`]">
              <div class="pan-account-brand"><span>{{ provider.shortName }}</span></div>
              <div class="pan-account-copy">
                <div class="pan-account-title"><h2>{{ provider.name }}</h2><em :class="{ connected: panStatuses[provider.id]?.accountState === 'connected', warning: panStatuses[provider.id]?.accountState === 'expired', unavailable: panStatuses[provider.id]?.accountState === 'unavailable' }">{{ panAccountStateLabel(panStatuses[provider.id]) }}</em></div>
                <p>{{ provider.description }} 登录过程在应用内完成。</p>
                <div class="pan-account-meta"><span>{{ panStatuses[provider.id]?.state ?? '尚未检查' }}</span><span v-if="panCredentialModeLabel(panStatuses[provider.id])">凭据：{{ panCredentialModeLabel(panStatuses[provider.id]) }}</span><span v-if="panStatuses[provider.id]?.checkedAt">检查于 {{ formatDate(panStatuses[provider.id]!.checkedAt) }}</span></div>
              </div>
              <div class="pan-account-actions">
                <button v-for="option in provider.loginOptions" :key="option.provider" :class="provider.loginOptions.length > 1 ? 'secondary-button' : 'primary-button'" :disabled="panLoginLoading || panStatusLoading" @click="startPanLogin(provider.id, option.provider)"><AppIcon name="account" :size="16" />{{ panStatuses[provider.id]?.login && provider.loginOptions.length === 1 ? '重新登录' : option.label }}</button>
                <button v-if="panStatuses[provider.id]?.configured || panStatuses[provider.id]?.login" class="secondary-button danger-subtle" :disabled="panStatusLoading || panLoginLoading" @click="clearPanAccount(provider.id)"><AppIcon name="trash" :size="15" />清除凭据</button>
              </div>
            </section>
          </div>

          <section class="account-privacy-note">
            <AppIcon name="info" :size="18" />
            <div><strong>凭据由主进程安全保存</strong><p>页面只显示登录状态，不读取或展示 Cookie、Token 和账号密码。二维码任务会在取消、过期或页面关闭后自动清理。</p></div>
          </section>
        </section>

        <section v-else-if="page === 'settings'" class="page settings-page">
          <div class="page-title-row"><div><small>PREFERENCES</small><h1>设置</h1><p>调整播放偏好和应用行为。</p></div></div>
          <section class="settings-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="settings" /></div><div><h2>界面显示</h2><p>调整页面文字大小，修改后可立即预览。</p></div></div>
            <div class="setting-row"><div><strong>界面字体大小</strong><span>标准为默认舒适阅读字号，紧凑接近旧版密度</span></div><select v-model="fontSize"><option v-for="option in FONT_SIZE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option></select></div>
            <div class="setting-row"><div><strong>界面主题</strong><span>跟随系统会随 macOS 外观自动切换，也可以固定为深色或浅色</span></div><select v-model="themeMode"><option value="system">跟随系统</option><option value="dark">深色</option><option value="light">浅色</option></select></div>
            <div class="setting-row"><div><strong>首页推荐自动轮播</strong><span>每 6 秒切换一条最近热播内容，鼠标悬停和窗口失焦时自动暂停</span></div><select v-model="homeCarouselEnabled"><option :value="true">开启</option><option :value="false">关闭</option></select></div>
          </section>
          <section class="settings-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="play" /></div><div><h2>播放偏好</h2><p>应用会自动选择合适的播放器，普通使用无需了解内部实现。</p></div></div>
            <div class="setting-row"><div><strong>默认播放速度</strong><span>适用于后续打开的播放任务</span></div><select v-model.number="defaultSpeed"><option :value="0.75">0.75×</option><option :value="1">1.0×</option><option :value="1.25">1.25×</option><option :value="1.5">1.5×</option><option :value="2">2.0×</option></select></div>
            <div class="setting-row"><div><strong>默认线路偏好</strong><span>稳定优先会优先选择极速、秒播或直连；原画优先适合带宽充足时使用</span></div><select v-model="linePreference"><option value="stable">稳定优先</option><option value="quality">原画优先</option></select></div>
            <div class="setting-row"><div><strong>播放失败自动换线路</strong><span>当前线路解析、地址或分段传输失败时，自动尝试同一集的下一条可用线路</span></div><select v-model="autoFallbackLine"><option :value="true">开启</option><option :value="false">关闭</option></select></div>
            <div class="setting-row"><div><strong>线路均失败后自动换来源</strong><span>在其他内容来源中查找同名、同季和相同集数，保持当前播放进度</span></div><select v-model="autoFallbackSource"><option :value="true">开启</option><option :value="false">关闭</option></select></div>
            <div class="setting-row"><div><strong>自动播放下一集</strong><span>当前集自然播放完成后，自动继续同一线路的下一集</span></div><select v-model="autoNextEpisode"><option :value="true">开启</option><option :value="false">关闭</option></select></div>
            <div class="setting-row"><div><strong>播放模式</strong><span>智能播放会自动选择标准播放或高兼容播放；高兼容适合黑屏、只有声音、卡加载或复杂线路</span></div><select v-model="playbackMode"><option value="auto">智能播放（推荐）</option><option value="standard">标准播放</option><option value="compatibility">高兼容播放</option></select></div>
            <div class="setting-row"><div><strong>原生高兼容内核</strong><span>安装包内运行时完整时自动使用 libmpv 真内嵌；关闭后重启应用将回退 MPV IPC</span></div><select v-model="nativeLibmpvEnabled"><option :value="true">自动启用（推荐）</option><option :value="false">关闭并回退 MPV IPC</option></select></div>
            <div class="setting-row"><div><strong>标准播放内核</strong><span>仅影响标准播放模式；高兼容线路会自动使用兼容播放内核</span></div><select v-model="webPlayerEngine"><option value="legacy">稳定播放器</option><option value="artplayer">ArtPlayer 实验版</option></select></div>
            <div class="setting-row"><div><strong>播放失败兼容策略</strong><span>自动模式会先等待标准播放器恢复，再切换高兼容播放；手动模式由你决定是否切换</span></div><select v-model="compatibilityFallbackMode"><option value="automatic">自动切换</option><option value="manual">仅手动切换</option></select></div>
            <div class="setting-row"><div><strong>高兼容播放记忆</strong><span>已记住 {{ Object.keys(playbackEnginePreferences).length }} 条线路；标准播放失败后会优先使用高兼容播放</span></div><button class="secondary-button" :disabled="Object.keys(playbackEnginePreferences).length === 0" @click="clearPlaybackEnginePreferences">清除记忆</button></div>
            <div class="setting-row"><div><strong>外部播放器</strong><span>已禁用。视频仅在应用内标准播放器或高兼容内核中播放。</span></div><strong class="setting-enabled">仅应用内播放</strong></div>
            <div class="setting-row"><div><strong>记住播放进度</strong><span>返回影片时自动从上次位置继续</span></div><strong class="setting-enabled">已开启</strong></div>
          </section>
          <section class="settings-card media-presentation-settings-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="film" /></div><div><h2>字幕与弹幕</h2><p>设置会同时用于稳定播放器和 ArtPlayer，并保存在本机。</p></div></div>
            <div class="setting-row"><div><strong>字幕大小</strong><span>调整内置字幕相对字号</span></div><select v-model.number="subtitleSettings.fontScale"><option :value="0.8">较小</option><option :value="1">标准</option><option :value="1.2">较大</option><option :value="1.4">特大</option></select></div>
            <div class="setting-row"><div><strong>字幕时间偏移</strong><span>正值延后显示，负值提前显示</span></div><select v-model.number="subtitleSettings.delaySeconds"><option :value="-5">提前 5 秒</option><option :value="-2">提前 2 秒</option><option :value="0">不同步调整</option><option :value="2">延后 2 秒</option><option :value="5">延后 5 秒</option></select></div>
            <div class="setting-row"><div><strong>字幕背景</strong><span>提高复杂画面中的可读性</span></div><select v-model.number="subtitleSettings.backgroundOpacity"><option :value="0">透明</option><option :value="0.3">浅色背景</option><option :value="0.45">标准背景</option><option :value="0.7">深色背景</option></select></div>
            <div class="setting-row"><div><strong>弹幕透明度</strong><span>仅影响弹幕文字，不影响视频</span></div><select v-model.number="danmakuSettings.opacity"><option :value="0.4">40%</option><option :value="0.7">70%</option><option :value="0.9">90%</option><option :value="1">100%</option></select></div>
            <div class="setting-row"><div><strong>弹幕字号</strong><span>控制滚动、顶部和底部弹幕大小</span></div><select v-model.number="danmakuSettings.fontScale"><option :value="0.8">较小</option><option :value="1">标准</option><option :value="1.2">较大</option><option :value="1.4">特大</option></select></div>
            <div class="setting-row"><div><strong>弹幕速度</strong><span>数值越高，滚动速度越快</span></div><select v-model.number="danmakuSettings.speed"><option :value="0.7">较慢</option><option :value="1">标准</option><option :value="1.3">较快</option><option :value="1.7">快速</option></select></div>
            <div class="setting-row"><div><strong>同屏弹幕上限</strong><span>限制高密度弹幕的 DOM 数量和性能占用</span></div><select v-model.number="danmakuSettings.maxActive"><option :value="24">24 条</option><option :value="36">36 条</option><option :value="48">48 条</option><option :value="64">64 条</option></select></div>
            <div class="setting-row setting-row-input"><div><strong>弹幕屏蔽词</strong><span>使用逗号或换行分隔，最多保存 100 个</span></div><input v-model="danmakuBlockedWordsText" placeholder="例如：剧透，广告" /></div>
          </section>
          <section class="settings-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="account" /></div><div><h2>数据与隐私</h2><p>播放记录保存在本机，网盘凭据由主进程安全保存。</p></div></div>
            <div v-if="storageRecoveryNotice" class="storage-recovery-notice" :class="storageRecoveryNotice.state"><AppIcon name="info" :size="18" /><div><strong>{{ storageRecoveryNotice.state === 'restored-backup' ? '本地数据已从备份恢复' : '检测到本地数据库损坏' }}</strong><span>{{ storageRecoveryNotice.message }}</span><small v-if="storageRecoveryNotice.archivedPath">损坏文件已保留：{{ storageRecoveryNotice.archivedPath }}</small></div><button class="secondary-button" @click="dismissStorageRecoveryNotice">我知道了</button></div>
            <div class="setting-row"><div><strong>播放历史</strong><span>当前保存 {{ histories.length }} 条记录</span></div><button v-if="histories.length" class="secondary-button danger-subtle" @click="clearHistory">清空历史</button><strong v-else>暂无记录</strong></div>
            <div class="setting-row"><div><strong>网盘账号</strong><span>查看登录状态或重新扫码登录</span></div><button class="secondary-button" @click="go('accounts')">账号与网盘</button></div>
          </section>
          <section class="settings-card advanced-settings-toggle-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="settings" /></div><div><h2>高级设置</h2><p>服务版本、日志、Provider 和运行时，仅用于故障排查。</p></div></div>
            <button class="secondary-button" @click="advancedSettingsOpen = !advancedSettingsOpen">{{ advancedSettingsOpen ? '收起高级设置' : '展开高级设置' }}</button>
          </section>
          <div v-if="advancedSettingsOpen" class="advanced-settings-panel">
          <section class="settings-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="sources" /></div><div><h2>CatVod Node 服务</h2><p>管理 JS 服务版本、运行状态和远程更新；新版本下载后不会自动执行。</p></div></div>
            <div class="replacement-registry-form">
              <label><span>index.js.md5 地址</span><input v-model="catVodMd5Url" placeholder="https://example.com/cat/index.js.md5" @keyup.enter="startCatVod" /></label>
              <div class="setting-row catvod-remote-policy-row"><div><strong>启动阶段远程访问策略</strong><span>审计 CatVod 启动后 15 秒内的 HTTP/HTTPS 域名；查询参数、账号和凭据不会保存</span></div><select v-model="catVodRemoteAccessPolicy"><option value="allow">允许并记录</option><option value="block-startup">阻止并记录</option></select></div>
              <div class="setting-row catvod-remote-policy-row"><div><strong>更新策略</strong><span>默认仅检查并提示，不下载候选；自动激活前仍会执行候选冒烟和回滚保护</span></div><select v-model="catVodUpdateStrategy"><option value="notify">仅提示，不下载候选</option><option value="download-candidate">下载候选，手动激活</option><option value="auto-activate">候选测试通过后自动激活</option></select></div>
              <div class="replacement-registry-actions catvod-actions">
                <button class="primary-button" :disabled="catVodLoading || !catVodMd5Url.trim()" @click="startCatVod">{{ catVodStatus?.state === 'running' ? '重新加载站点' : '启动服务' }}</button>
                <button class="secondary-button" :disabled="catVodLoading || catVodStatus?.state !== 'running'" @click="restartCatVod">重启</button>
                <button class="secondary-button" :disabled="catVodLoading || catVodStatus?.state === 'stopped'" @click="stopCatVod">停止</button>
                <button class="secondary-button" :disabled="catVodLoading" @click="checkCatVodUpdate">检查更新</button>
                <button class="secondary-button" :disabled="catVodLoading || catVodStatus?.state !== 'running'" @click="openCatVodWebsite">打开配置中心</button>
                <button class="secondary-button" :disabled="catVodLoading" @click="showCatVodLogPath">查看日志路径</button>
                <button v-if="catVodStatus?.candidateMd5" class="secondary-button" :disabled="catVodLoading" @click="activateCatVodUpdate">测试并激活候选版</button>
                <button v-if="catVodStatus?.previousMd5" class="secondary-button" :disabled="catVodLoading" @click="rollbackCatVod">回滚</button>
              </div>
              <small v-if="catVodMessage" class="replacement-registry-message">{{ catVodMessage }}</small>
            </div>
            <div class="runtime-list catvod-runtime-list">
              <div><span>服务状态</span><strong>{{ catVodStatus?.state ?? '读取中…' }}</strong></div>
              <div><span>当前版本</span><strong>{{ catVodStatus?.versionMd5?.slice(0, 12) ?? '未安装' }}</strong></div>
              <div><span>站点数量</span><strong>{{ catVodStatus?.siteCount ?? 0 }}</strong></div>
              <div><span>本地端口</span><strong>{{ catVodStatus?.port ?? '—' }}</strong></div>
            </div>
            <div class="catvod-remote-audit">
              <div class="catvod-remote-audit-heading"><div><strong>启动阶段远程访问审计</strong><span>{{ catVodStatus?.remoteAccesses?.length ? `检测到 ${catVodStatus.remoteAccesses.length} 个远程域名` : '本次启动尚未检测到远程 HTTP/HTTPS 域名' }}</span></div><em :class="{ blocked: catVodStatus?.remoteAccessPolicy === 'block-startup' }">{{ catVodStatus?.remoteAccessPolicy === 'block-startup' ? '阻止模式' : '允许模式' }}</em></div>
              <div v-if="catVodStatus?.remoteAccesses?.length" class="catvod-remote-audit-list">
                <div v-for="access in catVodStatus.remoteAccesses" :key="`${access.origin}:${access.method}:${access.blocked}`"><span><strong>{{ access.origin }}</strong><small>{{ access.method }} · 启动阶段 · {{ access.count }} 次</small></span><em :class="{ blocked: access.blocked }">{{ access.blocked ? '已阻止' : '已记录' }}</em></div>
              </div>
              <p>策略在下次启动或重启时生效。该审计只记录协议、域名和端口，不保存 URL 查询参数、Cookie、Token 或账号信息。</p>
            </div>
          </section>
          <section class="settings-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="sources" /></div><div><h2>替代 Provider 注册表</h2><p>为具体 Android Spider 指定经过验证的桌面替代实现。</p></div></div>
            <div class="replacement-registry-form">
              <label><span>本地文件或远程 JSON 地址</span><input v-model="replacementRegistrySource" placeholder="例如 /Users/name/provider-replacements.json" @keyup.enter="applyReplacementRegistry" /></label>
              <div class="replacement-registry-actions">
                <button class="primary-button" :disabled="replacementRegistryLoading || !replacementRegistrySource.trim()" @click="applyReplacementRegistry">{{ replacementRegistryLoading ? '处理中…' : '加载注册表' }}</button>
                <button class="secondary-button" :disabled="replacementRegistryLoading || (!replacementRegistrySource && replacementRegistryCount === 0)" @click="clearReplacementRegistry">清除</button>
              </div>
              <small v-if="replacementRegistryMessage" class="replacement-registry-message">{{ replacementRegistryMessage }}</small>
            </div>
            <div class="setting-row"><div><strong>当前替代规则</strong><span>加载后会立即重建当前配置的播放源；默认注册表为空</span></div><strong>{{ replacementRegistryCount }}</strong></div>
            <div v-if="replacementSites.length" class="replacement-attribution-list">
              <div v-for="site in replacementSites" :key="site.key"><strong>{{ site.name }}</strong><span>替代 Provider：{{ site.replacement?.sourceName }}</span></div>
            </div>
          </section>
          <section class="settings-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="info" /></div><div><h2>播放器运行内核</h2><p>用于判断当前版本可直接内置播放的媒体范围。</p></div></div>
            <div class="runtime-list">
              <div><span>应用版本</span><strong>{{ appInfo?.version ?? '读取中…' }}</strong></div>
              <div><span>Electron</span><strong>{{ appInfo?.electron ?? '读取中…' }}</strong></div>
              <div><span>Chromium</span><strong>{{ appInfo?.chrome ?? '读取中…' }}</strong></div>
              <div><span>Node.js</span><strong>{{ appInfo?.node ?? '读取中…' }}</strong></div>
              <div><span>系统架构</span><strong>{{ appInfo ? `${appInfo.platform} / ${appInfo.arch}` : '读取中…' }}</strong></div>
              <div><span>HLS 播放</span><strong>{{ nativeHlsSupported ? '系统原生内置播放' : 'HLS.js / MSE 内置播放' }}</strong></div>
              <div><span>高兼容后端</span><strong>{{ appInfo?.playerBackend === 'native-libmpv' ? 'libmpv 原生内嵌' : appInfo?.playerBackend === 'unavailable' ? '暂不可用' : 'MPV JSON IPC（仅诊断）' }}</strong></div>
              <div><span>libmpv 原生内嵌</span><strong>{{ appInfo?.nativeLibmpv?.available ? '已启用' : (appInfo?.nativeLibmpv?.reason || '未启用') }}</strong></div>
            </div>
          </section>
          <section class="settings-card">
            <div class="settings-card-heading"><div class="settings-icon"><AppIcon name="sources" /></div><div><h2>当前运行环境</h2><p>播放源运行时和兼容能力概览。</p></div></div>
            <div class="runtime-list">
              <div v-for="entry in runtimeStats" :key="entry[0]"><span>{{ runtimeNames[entry[0]] ?? entry[0] }}</span><strong>{{ entry[1] }}</strong></div>
              <div v-if="!runtimeStats.length"><span>尚未载入播放源</span><strong>0</strong></div>
            </div>
          </section>
          </div>
          <div class="settings-footer"><span v-if="settingsSaved" class="saved-indicator"><AppIcon name="check" :size="16" />设置已保存并校验</span><button class="primary-button" :disabled="settingsSaving" @click="saveSettings">{{ settingsSaving ? '正在保存…' : '保存设置' }}</button></div>
        </section>
      </main>

    </div>

    <div v-if="panLoginOpen" class="pan-login-layer" role="dialog" aria-modal="true" :aria-label="`${activePanDefinition.name}扫码登录`">
      <button class="pan-login-backdrop" aria-label="关闭登录" @click="closePanLogin"></button>
      <section class="pan-login-dialog">
        <header><div><small>PAN LOGIN</small><h2>登录{{ activePanDefinition.name }}</h2></div><button class="icon-button" title="关闭" @click="closePanLogin"><AppIcon name="close" :size="17" /></button></header>
        <div class="pan-login-body">
          <div class="pan-qr-frame" :class="`state-${panLoginState}`">
            <img v-if="panLoginQrImage" :src="panLoginQrImage" :alt="`${activePanDefinition.name}登录二维码`" />
            <div v-else-if="panLoginLoading" class="pan-login-loading"><span class="loading-spinner"></span><strong>正在生成二维码</strong></div>
            <div v-else class="pan-login-placeholder"><AppIcon :name="panLoginState === 'success' ? 'check' : 'info'" :size="34" /><strong>{{ panLoginState === 'expired' ? '二维码已过期' : panLoginState === 'success' ? '登录成功' : '二维码生成失败' }}</strong></div>
          </div>
          <div class="pan-login-status" :class="`state-${panLoginState}`"><span></span><strong>{{ panLoginMessage || `请使用${activePanDefinition.appName}扫码并确认` }}</strong></div>
          <p>扫码后无需点击任何确认按钮，应用会自动检测登录结果。</p>
        </div>
        <footer>
          <button v-if="pendingPanPlayback && panLoginState !== 'success'" class="secondary-button" :disabled="panLoginLoading" @click="switchPendingPanPlaybackSource"><AppIcon name="search" :size="15" />换一个来源</button>
          <button v-if="panLoginState === 'expired' || panLoginState === 'error'" class="primary-button" :disabled="panLoginLoading" @click="startPanLogin(activePanProvider, activePanLoginProvider)"><AppIcon name="refresh" :size="15" />重新生成二维码</button>
          <button class="secondary-button" @click="closePanLogin">{{ panLoginState === 'success' ? '完成' : '取消' }}</button>
        </footer>
      </section>
    </div>

    <PlayerContainer
      v-if="playing"
      :engine="webPlayerEngine"
      :session="playing"
      :default-speed="defaultSpeed"
      :compatibility-fallback-mode="compatibilityFallbackMode"
      :episodes="playingNavigation?.episodes ?? []"
      :current-episode-url="playing.episodeUrl"
      :has-previous="Boolean(playingNavigation?.previous)"
      :has-next="Boolean(playingNavigation?.next)"
      :danmaku-settings="danmakuSettings"
      :subtitle-settings="subtitleSettings"
      @progress="saveEmbeddedProgress"
      @previous="playPreviousEmbeddedEpisode"
      @next="playNextEmbeddedEpisode"
      @ended="handleEmbeddedEnded"
      @select-episode="selectEmbeddedEpisode"
      @close="closeEmbeddedPlayback"
      @fallback="fallbackEmbeddedPlayback"
      @reprepare="handleWebPlayerReprepare"
      @compatibility-failure="handleCompatibilityPlaybackFailure"
      @engine-fallback="handleWebPlayerEngineFallback"
    />
    <div v-if="playing && pendingSourceImport" class="pending-source-switch-banner">
      <AppIcon name="sources" :size="18" />
      <span><strong>{{ sourceImportLabel(pendingSourceImport) }} 已准备切换</strong><small>当前视频继续播放；关闭播放器或本集播放完成后自动切换。</small></span>
      <button class="primary-button" :disabled="loading" @click="stopPlaybackAndApplyPendingSource">立即切换</button>
      <button class="secondary-button" :disabled="loading" @click="cancelPendingSourceImport">取消</button>
    </div>
  </div>
</template>
