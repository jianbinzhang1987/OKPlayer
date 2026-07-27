import path from "node:path";
import { expandVodConfigs, loadConfigDocument, loadVodConfig, parseVodConfigText } from "./config-loader.ts";
import { probeMediaUrl } from "./media-probe.ts";
import type { PlayerResult, ResolvedMedia, SiteConfig, SourceResult, Vod, VodConfig } from "./models.ts";
import { ProviderManager } from "./provider-manager.ts";
import { loadProviderReplacements } from "./provider-replacement-registry.ts";
import { resolvePlayerResult } from "./resolver.ts";
import type { SourceAdapter, SourceHealth } from "./source-adapter.ts";
import { SourceAdapterFactory } from "./source-adapter-factory.ts";
import { getSiteCapability } from "./source-capability.ts";
import {
  classifyQualityFailure,
  qualityHidesSource,
  sourceFingerprint,
  sourceQualityMetrics,
  type SourceAuditStatus,
  type SourceQualityRecord,
  type SourceQualityStage,
  type SourceQualityState,
} from "./source-quality.ts";
import { compareSourcesByQuality } from "./source-ranking.ts";
import { decodeSourceReference, encodeSourceReference } from "./source-reference.ts";
import { SqliteStorage } from "./sqlite-storage.ts";

export interface SearchItem extends Vod {}

export type SearchScope = "all-configs" | "current-site";

export interface SearchTargetSelection {
  includeSiteKeys?: string[];
  excludeSiteKeys?: string[];
  maxSources?: number;
}

export interface SearchSiteStatus {
  siteKey: string;
  siteName: string;
  configName?: string;
  state: "success" | "error";
  count: number;
  page?: number;
  pageCount?: number;
  hasMore?: boolean;
  message?: string;
}

export interface DetailedSearchResult {
  list: Vod[];
  statuses: SearchSiteStatus[];
  page: number;
  hasMore: boolean;
}

export interface IncrementalSearchEvent {
  type: "source" | "complete";
  list: Vod[];
  status?: SearchSiteStatus;
  page: number;
  completed: number;
  total: number;
  hasMore: boolean;
}

export interface BestHomeResult {
  siteKey: string;
  list: Vod[];
  pageCount: number;
  message: string;
}

interface SourceContext {
  adapter: SourceAdapter;
  config: VodConfig;
  configSource: string;
  configName: string;
  publicSiteKey: string;
  referenced: boolean;
}

interface GlobalSearchTarget {
  site: SiteConfig;
  config: VodConfig;
  configSource: string;
  configName: string;
  sourceRef: string;
  quality?: SourceQualityRecord;
}

interface QualityTarget {
  site: SiteConfig;
  config: VodConfig;
  configSource: string;
}

interface AuditOutcome {
  state: "healthy" | "unknown" | "degraded" | "blocked";
  stage: SourceQualityStage;
  reason: string;
  latencyMs: number;
}

const GLOBAL_SEARCH_CONCURRENCY = 16;
const GLOBAL_SEARCH_TIMEOUT_MS = 30_000;
const SOURCE_SEARCH_TIMEOUT_MS = 8_000;
const PROVIDER_CACHE_CAPACITY = 2_048;
const HOME_FALLBACK_BATCH_SIZE = 8;
const HOME_FALLBACK_MAX_SOURCES = 64;
const SOURCE_AUDIT_CONCURRENCY = 8;
const SOURCE_AUDIT_OPERATION_TIMEOUT_MS = 8_000;
const SOURCE_AUDIT_MEDIA_TIMEOUT_MS = 5_000;
const SOURCE_AUDIT_FRESH_MS = 24 * 60 * 60 * 1_000;
const SOURCE_AUDIT_SEARCH_TERMS = ["庆余年", "斗罗大陆"];
const DIRECT_MEDIA_PATTERN = /\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i;
const CATVOD_CONFIG_SOURCE = "catvod://runtime/config";

export class AppService {
  private config?: VodConfig;
  private dynamicSites: SiteConfig[] = [];
  private dynamicConfig?: VodConfig;
  private sources = new Map<string, SourceAdapter>();
  private searchController?: AbortController;
  private auditController?: AbortController;
  private auditPromise?: Promise<void>;
  private auditStatus: SourceAuditStatus = emptyAuditStatus();
  private readonly providerManager: ProviderManager;
  private readonly adapterFactory: SourceAdapterFactory;
  readonly storage: SqliteStorage;

  constructor(databasePath = path.resolve("fongmi-desktop.sqlite"), adapterFactory = new SourceAdapterFactory()) {
    this.storage = new SqliteStorage(databasePath);
    this.adapterFactory = adapterFactory;
    // A large TVBox configuration can contain hundreds of providers. AppService keeps the
    // adapters in its source map, so the provider cache must not evict and destroy adapters
    // that are still referenced by that map.
    this.providerManager = new ProviderManager(adapterFactory, PROVIDER_CACHE_CAPACITY);
  }

  async loadConfig(source: string, name = "默认配置"): Promise<VodConfig> {
    const document = await loadConfigDocument(source);
    if (document.kind === "config") return this.activateConfig(source, name, document.config);

    const expanded = await expandVodConfigs(source, { maxDepth: 3, maxConfigs: 100, concurrency: 6 });
    if (expanded.entries.length === 0) {
      const details = expanded.failures.slice(0, 5).map((item) => `${item.source}：${item.message}`).join("；");
      throw new Error(`多仓配置未找到可用的下级线路${details ? `：${details}` : ""}`);
    }

    const now = Date.now();
    for (const entry of expanded.entries) {
      this.storage.saveConfig({ name: entry.name, url: entry.source, enabled: false, updatedAt: now });
    }
    const first = expanded.entries[0]!;
    return this.activateConfig(first.source, first.name, first.config);
  }

  async loadConfigText(text: string, source: string, name = "默认配置"): Promise<VodConfig> {
    return this.activateConfig(source, name, parseVodConfigText(text, source));
  }

  async restoreActiveConfig(): Promise<VodConfig | undefined> {
    const source = this.storage.getSetting<string>("activeConfig", "");
    if (!source) return undefined;
    const savedName = this.storage.listConfigs().find((record) => record.url === source)?.name ?? "默认配置";
    try {
      return await this.loadConfig(source, savedName);
    } catch {
      return undefined;
    }
  }

  getConfig(): VodConfig | undefined {
    return this.config;
  }

  async setDynamicSites(sites: SiteConfig[]): Promise<void> {
    this.dynamicSites = sites.map((site) => ({ ...site }));
    this.dynamicConfig = {
      sourceUrl: CATVOD_CONFIG_SOURCE,
      sites: this.dynamicSites,
      parses: [],
      flags: [],
      headers: [],
      proxy: [],
      rules: [],
      hosts: [],
      ads: [],
    };
    await this.rebuildSources();
  }

  async clearDynamicSites(): Promise<void> {
    this.dynamicSites = [];
    this.dynamicConfig = undefined;
    await this.rebuildSources();
  }

  listSites() {
    const currentSource = this.currentConfigSource();
    const currentQuality = new Map(
      currentSource
        ? this.storage.listSourceQuality(currentSource).map((record) => [record.siteKey, record] as const)
        : [],
    );
    const dynamicQuality = new Map(
      this.storage.listSourceQuality(CATVOD_CONFIG_SOURCE).map((record) => [record.siteKey, record] as const),
    );

    return this.allActiveSites().map((site) => {
      const adapter = this.sources.get(site.key);
      const capability = adapter ?? getSiteCapability(site);
      const configSource = this.isDynamicSite(site.key) ? CATVOD_CONFIG_SOURCE : currentSource;
      const stored = (this.isDynamicSite(site.key) ? dynamicQuality : currentQuality).get(site.key);
      const record = stored?.fingerprint === sourceFingerprint(site) ? stored : undefined;
      const hiddenByQuality = qualityHidesSource(record);
      const supported = capability.supported && !hiddenByQuality;
      const qualityReason = record && hiddenByQuality ? record.reason : undefined;
      return {
        ...site,
        supported,
        runtime: capability.runtime,
        capabilities: capability.capabilities,
        quality: record ?? unknownQuality(configSource, site),
        ...(qualityReason || capability.reason ? { reason: qualityReason ?? capability.reason } : {}),
        ...(adapter?.replacement ? { replacement: adapter.replacement } : {}),
      };
    });
  }

  listConfigs() {
    return this.storage.listConfigs();
  }

  getReplacementRegistryStatus() {
    return {
      source: this.storage.getSetting<string>("providerRegistrySource", ""),
      count: this.adapterFactory.replacementCount(),
    };
  }

  async loadReplacementRegistry(source: string) {
    const value = source.trim();
    if (!value) throw new Error("替代 Provider 注册表地址不能为空");
    const previousEntries = this.adapterFactory.replacementEntries();
    const previousSource = this.storage.getSetting<string>("providerRegistrySource", "");
    const entries = await loadProviderReplacements(value);
    try {
      this.adapterFactory.setReplacements(entries);
      await this.rebuildSources();
      this.storage.setSetting("providerRegistrySource", value);
      return { source: value, count: entries.length };
    } catch (error) {
      this.adapterFactory.setReplacements(previousEntries);
      await this.rebuildSources().catch(() => undefined);
      this.storage.setSetting("providerRegistrySource", previousSource);
      throw error;
    }
  }

  async clearReplacementRegistry() {
    const previousEntries = this.adapterFactory.replacementEntries();
    const previousSource = this.storage.getSetting<string>("providerRegistrySource", "");
    try {
      this.adapterFactory.setReplacements([]);
      await this.rebuildSources();
      this.storage.setSetting("providerRegistrySource", "");
      return { source: "", count: 0 };
    } catch (error) {
      this.adapterFactory.setReplacements(previousEntries);
      await this.rebuildSources().catch(() => undefined);
      this.storage.setSetting("providerRegistrySource", previousSource);
      throw error;
    }
  }

  async restoreReplacementRegistry() {
    const source = this.storage.getSetting<string>("providerRegistrySource", "");
    if (!source) return { source: "", count: this.adapterFactory.replacementCount() };
    try {
      const entries = await loadProviderReplacements(source);
      this.adapterFactory.setReplacements(entries);
      return { source, count: entries.length };
    } catch (error) {
      return {
        source,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  renameConfig(source: string, name: string) {
    this.storage.renameConfig(source, name);
  }

  async deleteConfig(source: string) {
    const activeSource = this.storage.getSetting<string>("activeConfig", "");
    const fallbackRecords = activeSource === source
      ? this.storage.listConfigs().filter((record) => record.url !== source)
      : [];

    this.storage.deleteConfig(source);
    this.storage.clearSourceQuality(source);
    if (activeSource !== source) {
      await this.rebuildSources();
      return;
    }

    this.cancelSourceAudit();
    this.sources.clear();
    await this.providerManager.clear();
    this.config = undefined;
    this.storage.setSetting("activeConfig", "");

    for (const record of fallbackRecords) {
      try {
        const config = await loadVodConfig(record.url);
        await this.activateConfig(record.url, record.name, config);
        return;
      } catch {
        // Try the next saved configuration. A stale or offline entry must not block deletion.
      }
    }
  }

  async home(siteKey: string) {
    const context = await this.ensureSourceContext(siteKey);
    const startedAt = Date.now();
    try {
      const result = await context.adapter.home();
      if (result.list.length > 0) {
        this.recordQualitySuccess(context.configSource, context.adapter.site, "home", Date.now() - startedAt, "首页内容获取正常");
      } else {
        this.recordQualityFailure(context.configSource, context.adapter.site, "home", "首页未返回任何内容", Date.now() - startedAt);
      }
      this.annotateReferencedResult(result, context);
      return result;
    } catch (error) {
      this.recordQualityFailure(context.configSource, context.adapter.site, "home", errorMessage(error), Date.now() - startedAt);
      throw error;
    }
  }

  async bestHome(preferredSiteKey?: string): Promise<BestHomeResult> {
    if (!this.config && !this.dynamicConfig) return { siteKey: "", list: [], pageCount: 0, message: "尚未载入配置" };
    const activeSiteKey = preferredSiteKey || this.storage.getSetting<string>("defaultSite", "");
    const recentSiteKeys = this.storage.getSetting<string[]>("recentSiteKeys", []);
    const candidates = this.allActiveSites()
      .filter((site) => {
        const capability = getSiteCapability(site);
        if (!capability.supported || !capability.capabilities.home) return false;
        if (["tool", "live", "comic", "audio", "short-drama"].includes(site.contentType ?? "")) return false;
        return !qualityHidesSource(this.matchingQuality(this.configSourceForSite(site), site));
      })
      .sort((left, right) => compareSourcesByQuality(
        { key: left.key, name: left.name, quality: this.matchingQuality(this.configSourceForSite(left), left) },
        { key: right.key, name: right.name, quality: this.matchingQuality(this.configSourceForSite(right), right) },
        { activeSiteKey, recentSiteKeys },
        "browse",
      ))
      .slice(0, HOME_FALLBACK_MAX_SOURCES);

    for (let index = 0; index < candidates.length; index += HOME_FALLBACK_BATCH_SIZE) {
      const batch = candidates.slice(index, index + HOME_FALLBACK_BATCH_SIZE);
      const batchController = new AbortController();
      const attempts = batch.map(async (site): Promise<BestHomeResult> => {
        const adapter = this.sources.get(site.key) ?? await this.providerManager.acquire(site);
        const configSource = this.configSourceForSite(site);
        const startedAt = Date.now();
        try {
          const timeout = AbortSignal.timeout(Math.min(6_000, Math.max(2_000, (site.timeout ?? 6) * 1_000)));
          const signal = AbortSignal.any([batchController.signal, timeout]);
          const result = await adapter.home(signal);
          if (!result.list.length) throw new Error("首页未返回任何内容");
          this.recordQualitySuccess(configSource, site, "home", Date.now() - startedAt, "首页内容获取正常");
          result.list.forEach((vod) => {
            vod.siteKey = site.key;
            vod.siteName ??= site.name;
          });
          return { siteKey: site.key, ...result };
        } catch (error) {
          if (!batchController.signal.aborted) {
            this.recordQualityFailure(configSource, site, "home", errorMessage(error), Date.now() - startedAt);
          }
          throw error;
        }
      });
      try {
        const found = await Promise.any(attempts);
        batchController.abort();
        void Promise.allSettled(attempts);
        return found;
      } catch {
        batchController.abort();
      }
    }

    return { siteKey: "", list: [], pageCount: 0, message: "已检测的播放源均未返回首页内容" };
  }

  async category(siteKey: string, tid: string, page = "1", extend: Record<string, string> = {}) {
    const context = await this.ensureSourceContext(siteKey);
    const startedAt = Date.now();
    try {
      const result = await context.adapter.category(tid, page, extend);
      if (result.list.length > 0) {
        this.recordQualitySuccess(context.configSource, context.adapter.site, "home", Date.now() - startedAt, "分类内容获取正常");
      }
      this.annotateReferencedResult(result, context);
      return result;
    } catch (error) {
      this.recordQualityFailure(context.configSource, context.adapter.site, "home", errorMessage(error), Date.now() - startedAt);
      throw error;
    }
  }

  async search(
    keyword: string,
    siteKey?: string,
    scope: SearchScope = "all-configs",
    page = 1,
    selection?: SearchTargetSelection,
  ): Promise<Vod[]> {
    return (await this.searchDetailed(keyword, siteKey, scope, page, selection)).list;
  }

  async searchDetailed(
    keyword: string,
    siteKey?: string,
    scope: SearchScope = "all-configs",
    page = 1,
    selection?: SearchTargetSelection,
  ): Promise<DetailedSearchResult> {
    return this.runSearch(keyword, siteKey, scope, page, undefined, selection);
  }

  async searchDetailedIncremental(
    keyword: string,
    siteKey: string | undefined,
    scope: SearchScope = "all-configs",
    page = 1,
    onEvent: (event: IncrementalSearchEvent) => void,
    selection?: SearchTargetSelection,
  ): Promise<DetailedSearchResult> {
    return this.runSearch(keyword, siteKey, scope, page, onEvent, selection);
  }

  cancelSearch(): void {
    this.searchController?.abort(new Error("搜索已取消"));
  }

  private async runSearch(
    keyword: string,
    siteKey: string | undefined,
    scope: SearchScope,
    page: number,
    onEvent?: (event: IncrementalSearchEvent) => void,
    selection?: SearchTargetSelection,
  ): Promise<DetailedSearchResult> {
    const value = keyword.trim();
    if (!value) throw new Error("搜索关键词不能为空");
    const pageNumber = Math.max(1, Math.floor(Number(page) || 1));

    this.searchController?.abort(new Error("搜索已取消"));
    const controller = new AbortController();
    this.searchController = controller;

    try {
      let result: DetailedSearchResult;
      if (scope === "current-site" || siteKey) {
        result = await this.searchCurrentSite(value, siteKey, pageNumber, controller.signal);
        const status = result.statuses[0];
        if (status) {
          publishSearchEvent(onEvent, {
            type: "source",
            list: result.list,
            status,
            page: pageNumber,
            completed: 1,
            total: 1,
            hasMore: Boolean(status.hasMore),
          });
        }
      } else {
        result = await this.searchAllConfigs(value, pageNumber, controller, onEvent, selection);
      }
      publishSearchEvent(onEvent, {
        type: "complete",
        list: [],
        page: pageNumber,
        completed: result.statuses.length,
        total: result.statuses.length,
        hasMore: result.hasMore,
      });
      return result;
    } finally {
      if (this.searchController === controller) this.searchController = undefined;
    }
  }

  async detail(siteKey: string, vodId: string): Promise<Vod> {
    const context = await this.ensureSourceContext(siteKey);
    const startedAt = Date.now();
    try {
      const vod = await context.adapter.detail(vodId);
      const episodeCount = vod.flags.reduce((count, line) => count + line.episodes.length, 0);
      if (episodeCount === 0) {
        const message = `播放源 ${context.adapter.site.name} 返回了详情，但没有可播放剧集`;
        this.recordQualityFailure(context.configSource, context.adapter.site, "detail", message, Date.now() - startedAt, "blocked");
        throw new Error(message);
      }
      this.recordQualitySuccess(context.configSource, context.adapter.site, "detail", Date.now() - startedAt, `详情和剧集正常，共 ${episodeCount} 集`);
      vod.siteKey = context.publicSiteKey;
      vod.siteName = context.referenced ? `${context.adapter.site.name} · ${context.configName}` : (vod.siteName ?? context.adapter.site.name);
      if (context.referenced) vod.configName = context.configName;
      return vod;
    } catch (error) {
      if (!/没有可播放剧集/.test(errorMessage(error))) {
        this.recordQualityFailure(context.configSource, context.adapter.site, "detail", errorMessage(error), Date.now() - startedAt);
      }
      throw error;
    }
  }

  async playerResult(siteKey: string, flag: string, episodeUrl: string, signal?: AbortSignal): Promise<PlayerResult> {
    const context = await this.ensureSourceContext(siteKey);
    const startedAt = Date.now();
    try {
      const result = await context.adapter.player(flag, episodeUrl, context.config.flags ?? [], signal);
      if (!result.url?.trim()) throw new Error("播放源未返回有效播放地址");
      return result;
    } catch (error) {
      this.recordQualityFailure(context.configSource, context.adapter.site, "player", errorMessage(error), Date.now() - startedAt);
      throw error;
    }
  }

  async resolve(siteKey: string, flag: string, episodeUrl: string, signal?: AbortSignal): Promise<ResolvedMedia> {
    const context = await this.ensureSourceContext(siteKey);
    const startedAt = Date.now();
    try {
      const player = await context.adapter.player(flag, episodeUrl, context.config.flags ?? [], signal);
      const resolved = await resolvePlayerResult(player, context.config.parses ?? [], signal);
      if (!resolved.url?.trim()) throw new Error("解析器未返回有效播放地址");
      return resolved;
    } catch (error) {
      this.recordQualityFailure(context.configSource, context.adapter.site, "player", errorMessage(error), Date.now() - startedAt);
      throw error;
    }
  }

  async health(siteKey: string): Promise<SourceHealth> {
    const target = await this.findQualityTarget(siteKey);
    const controller = new AbortController();
    const outcome = await this.auditSingleSource(target.site, target.config, controller.signal);
    this.saveAuditOutcome(target.configSource, target.site, outcome);
    return {
      ok: outcome.state === "healthy",
      latencyMs: outcome.latencyMs,
      message: outcome.reason,
    };
  }

  getSourceAuditStatus(): SourceAuditStatus {
    return { ...this.auditStatus };
  }

  startSourceAudit(force = false): SourceAuditStatus {
    if (this.auditStatus.running) return this.getSourceAuditStatus();
    if (!this.config) {
      this.auditStatus = emptyAuditStatus();
      return this.getSourceAuditStatus();
    }

    const config = this.config;
    const configSource = this.currentConfigSource();
    const now = Date.now();
    const supportedSites: SiteConfig[] = [];
    const unsupportedSites: SiteConfig[] = [];
    const existing = new Map(this.storage.listSourceQuality(configSource).map((record) => [record.siteKey, record] as const));
    const skippedSites: SiteConfig[] = [];
    const pendingSites: SiteConfig[] = [];

    for (const site of config.sites) {
      const capability = getSiteCapability(site);
      if (!capability.supported) {
        unsupportedSites.push(site);
        this.saveStaticBlocked(configSource, site, capability.reason ?? "当前设备不支持该播放源运行时");
        continue;
      }
      supportedSites.push(site);
      const record = existing.get(site.key);
      const terminal = record?.state === "healthy" || record?.state === "unknown" || record?.state === "degraded" || record?.state === "blocked";
      const fresh = record?.fingerprint === sourceFingerprint(site)
        && terminal
        && now - record.checkedAt < SOURCE_AUDIT_FRESH_MS;
      if (!force && fresh) skippedSites.push(site);
      else pendingSites.push(site);
    }

    const counts = countAuditStates(skippedSites.map((site) => existing.get(site.key)));
    this.auditStatus = {
      running: pendingSites.length > 0,
      total: config.sites.length,
      completed: skippedSites.length + unsupportedSites.length,
      healthy: counts.healthy,
      unknown: counts.unknown,
      degraded: counts.degraded,
      blocked: counts.blocked + unsupportedSites.length,
      skipped: skippedSites.length,
      startedAt: now,
      ...(pendingSites.length === 0 ? { finishedAt: now } : {}),
    };

    if (!pendingSites.length) return this.getSourceAuditStatus();

    const controller = new AbortController();
    this.auditController = controller;
    this.auditPromise = mapConcurrent(pendingSites, SOURCE_AUDIT_CONCURRENCY, async (site) => {
      if (controller.signal.aborted) return;
      this.auditStatus.currentSiteKey = site.key;
      this.auditStatus.currentSiteName = site.name;
      this.saveChecking(configSource, site);
      const outcome = await this.auditSingleSource(site, config, controller.signal);
      if (controller.signal.aborted) return;
      this.saveAuditOutcome(configSource, site, outcome);
      this.auditStatus.completed += 1;
      this.auditStatus[outcome.state] += 1;
    }).then(() => undefined).finally(() => {
      if (this.auditController === controller) this.auditController = undefined;
      this.auditPromise = undefined;
      this.auditStatus.running = false;
      this.auditStatus.currentSiteKey = undefined;
      this.auditStatus.currentSiteName = undefined;
      this.auditStatus.finishedAt = Date.now();
    });

    return this.getSourceAuditStatus();
  }

  cancelSourceAudit(): void {
    this.auditController?.abort();
    this.auditController = undefined;
    this.auditStatus.running = false;
    this.auditStatus.currentSiteKey = undefined;
    this.auditStatus.currentSiteName = undefined;
    this.auditStatus.finishedAt = Date.now();
  }

  async recordPlaybackSuccess(siteKey: string, latencyMs = 0): Promise<void> {
    const target = await this.findQualityTarget(siteKey);
    this.recordQualitySuccess(target.configSource, target.site, "media", latencyMs, "已验证可正常播放");
  }

  async recordPlaybackFailure(
    siteKey: string,
    reason: string,
    latencyMs = 0,
    sourceImpact?: "none" | "degraded" | "blocked",
  ): Promise<void> {
    if (sourceImpact === "none") return;
    const target = await this.findQualityTarget(siteKey).catch(() => undefined);
    if (!target) return;
    this.recordQualityFailure(target.configSource, target.site, "media", reason, latencyMs, sourceImpact);
  }

  close() {
    this.searchController?.abort(new Error("应用已关闭"));
    this.searchController = undefined;
    this.cancelSourceAudit();
    this.sources.clear();
    void this.providerManager.clear();
    this.storage.close();
  }

  private async searchCurrentSite(keyword: string, siteKey: string | undefined, page: number, signal: AbortSignal): Promise<DetailedSearchResult> {
    if (!siteKey) throw new Error("请选择当前播放源后再搜索");
    const context = await this.ensureSourceContext(siteKey);
    const source = context.adapter;
    if (!source.capabilities.search) throw new Error(`播放源 ${source.site.name} 不支持搜索`);
    try {
      const startedAt = Date.now();
      const result = await source.search(keyword, String(page), false, signal);
      result.list.forEach((vod) => {
        vod.siteKey = siteKey;
        vod.siteName ??= source.site.name;
        vod.configName ??= context.configName;
      });
      if (result.list.length > 0) {
        this.recordQualitySuccess(context.configSource, source.site, "search", Date.now() - startedAt, "搜索接口正常");
      }
      const pageCount = Math.max(page, Number(result.pageCount || page));
      return {
        list: result.list,
        statuses: [{ siteKey, siteName: source.site.name, configName: context.configName, state: "success", count: result.list.length, page, pageCount, hasMore: page < pageCount }],
        page,
        hasMore: page < pageCount,
      };
    } catch (error) {
      this.recordQualityFailure(context.configSource, source.site, "search", errorMessage(error), 0);
      return {
        list: [],
        statuses: [{
          siteKey,
          siteName: source.site.name,
          configName: context.configName,
          state: "error",
          count: 0,
          page,
          pageCount: page,
          hasMore: false,
          message: errorMessage(error),
        }],
        page,
        hasMore: false,
      };
    }
  }

  private async searchAllConfigs(
    keyword: string,
    page: number,
    controller: AbortController,
    onEvent?: (event: IncrementalSearchEvent) => void,
    selection?: SearchTargetSelection,
  ): Promise<DetailedSearchResult> {
    const globalTimeout = AbortSignal.timeout(GLOBAL_SEARCH_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, globalTimeout]);
    const records = this.searchConfigRecords();
    if (records.length === 0 && this.dynamicSites.length === 0) {
      throw new Error("尚未保存任何配置源，请先导入播放源配置");
    }

    const loadResults = await mapConcurrent(records, 4, async (record) => {
      try {
        const activeSource = this.storage.getSetting<string>("activeConfig", "");
        const config = record.url === activeSource && this.config ? this.config : await loadVodConfig(record.url);
        return { record, config } as const;
      } catch (error) {
        return { record, error: errorMessage(error) } as const;
      }
    });

    const statuses: SearchSiteStatus[] = [];
    const targets: GlobalSearchTarget[] = [];
    const seenProviders = new Set<string>();
    let searchableSiteCount = 0;
    let androidDexSearchableCount = 0;

    for (const loaded of loadResults) {
      if ("error" in loaded) {
        statuses.push({
          siteKey: `config:${loaded.record.url}`,
          siteName: loaded.record.name,
          configName: loaded.record.name,
          state: "error",
          count: 0,
          message: `配置加载失败：${loaded.error}`,
        });
        continue;
      }
      for (const site of loaded.config.sites) {
        const capability = getSiteCapability(site);
        if (!isSearchEligibleSite(site)) continue;
        searchableSiteCount += 1;
        if (capability.runtime === "android-dex") androidDexSearchableCount += 1;
        if (!capability.supported || !capability.capabilities.search) continue;
        if (qualityHidesSource(this.matchingQuality(loaded.record.url, site))) continue;
        const identity = providerSearchIdentity(site);
        if (seenProviders.has(identity)) continue;
        seenProviders.add(identity);
        targets.push({
          site,
          config: loaded.config,
          configSource: loaded.record.url,
          configName: loaded.record.name,
          sourceRef: encodeSourceReference(loaded.record.url, site.key),
          quality: this.matchingQuality(loaded.record.url, site),
        });
      }
    }

    if (this.dynamicConfig) {
      for (const site of this.dynamicSites) {
        const capability = getSiteCapability(site);
        if (!isSearchEligibleSite(site)) continue;
        searchableSiteCount += 1;
        if (!capability.supported || !capability.capabilities.search) continue;
        if (qualityHidesSource(this.matchingQuality(CATVOD_CONFIG_SOURCE, site))) continue;
        const identity = providerSearchIdentity(site);
        if (seenProviders.has(identity)) continue;
        seenProviders.add(identity);
        targets.push({
          site,
          config: this.dynamicConfig,
          configSource: CATVOD_CONFIG_SOURCE,
          configName: "CatVod 服务",
          sourceRef: site.key,
          quality: this.matchingQuality(CATVOD_CONFIG_SOURCE, site),
        });
      }
    }

    const activeConfigSource = this.storage.getSetting<string>("activeConfig", "");
    const activeSiteKey = this.storage.getSetting<string>("defaultSite", "");
    const recentSiteKeys = this.storage.getSetting<string[]>("recentSiteKeys", []);
    const rankingKey = (target: GlobalSearchTarget) => target.configSource === activeConfigSource || target.configSource === CATVOD_CONFIG_SOURCE
      ? target.site.key
      : target.sourceRef;
    targets.sort((left, right) => compareSourcesByQuality(
      { key: rankingKey(left), name: left.site.name, quality: left.quality },
      { key: rankingKey(right), name: right.site.name, quality: right.quality },
      { activeSiteKey, recentSiteKeys },
      "search",
    ));

    const availableTargetCount = targets.length;
    const includeSiteKeys = normalizedSearchSiteKeys(selection?.includeSiteKeys);
    const excludeSiteKeys = normalizedSearchSiteKeys(selection?.excludeSiteKeys);
    const selectedTargets = targets.filter((target) => {
      const identities = [target.sourceRef, target.site.key];
      if (includeSiteKeys.size > 0 && !identities.some((key) => includeSiteKeys.has(key))) return false;
      return !identities.some((key) => excludeSiteKeys.has(key));
    });
    const maxSources = normalizeSearchSourceLimit(selection?.maxSources);
    targets.splice(0, targets.length, ...selectedTargets.slice(0, maxSources));

    const total = statuses.length + targets.length;
    let completed = 0;
    for (const status of statuses) {
      completed += 1;
      publishSearchEvent(onEvent, {
        type: "source",
        list: [],
        status,
        page,
        completed,
        total,
        hasMore: false,
      });
    }

    if (targets.length === 0) {
      if (statuses.length > 0 || (availableTargetCount > 0 && selection)) return { list: [], statuses, page, hasMore: false };
      if (searchableSiteCount > 0 && androidDexSearchableCount === searchableSiteCount) {
        throw new Error("可搜索站点均依赖 Android Dex/JAR Spider，当前桌面版本无法直接执行");
      }
      throw new Error("所有已保存配置中都没有通过检测的可搜索播放源");
    }

    const outcomes = await mapConcurrent(targets, GLOBAL_SEARCH_CONCURRENCY, async (target) => {
      if (signal.aborted) {
        const message = globalTimeout.aborted ? "全局搜索超过 30 秒，已停止剩余来源" : "搜索已取消";
        const status: SearchSiteStatus = {
          siteKey: target.sourceRef,
          siteName: target.site.name,
          configName: target.configName,
          state: "error",
          count: 0,
          page,
          pageCount: page,
          hasMore: false,
          message,
        };
        completed += 1;
        publishSearchEvent(onEvent, {
          type: "source",
          list: [],
          status,
          page,
          completed,
          total,
          hasMore: false,
        });
        return { target, error: message, status } as const;
      }
      const adapter = this.adapterFactory.create(target.site);
      const startedAt = Date.now();
      try {
        const sourceTimeout = Math.min(
          10_000,
          Math.max(2_500, (target.site.timeout ?? SOURCE_SEARCH_TIMEOUT_MS / 1000) * 1_000),
        );
        const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(sourceTimeout)]);
        const result = await adapter.search(keyword, String(page), true, sourceSignal);
        result.list.forEach((vod) => {
          vod.siteKey = target.sourceRef;
          vod.siteName = target.site.name;
          vod.configName = target.configName;
        });
        if (result.list.length > 0) {
          this.recordQualitySuccess(target.configSource, target.site, "search", Date.now() - startedAt, "搜索接口正常");
        }
        const pageCount = Math.max(page, Number(result.pageCount || page));
        const status: SearchSiteStatus = {
          siteKey: target.sourceRef,
          siteName: target.site.name,
          configName: target.configName,
          state: "success",
          count: result.list.length,
          page,
          pageCount,
          hasMore: page < pageCount,
        };
        completed += 1;
        publishSearchEvent(onEvent, {
          type: "source",
          list: result.list,
          status,
          page,
          completed,
          total,
          hasMore: Boolean(status.hasMore),
        });
        return { target, list: result.list, pageCount, status } as const;
      } catch (error) {
        const message = errorMessage(error);
        this.recordQualityFailure(target.configSource, target.site, "search", message, Date.now() - startedAt);
        const status: SearchSiteStatus = {
          siteKey: target.sourceRef,
          siteName: target.site.name,
          configName: target.configName,
          state: "error",
          count: 0,
          page,
          pageCount: page,
          hasMore: false,
          message,
        };
        completed += 1;
        publishSearchEvent(onEvent, {
          type: "source",
          list: [],
          status,
          page,
          completed,
          total,
          hasMore: false,
        });
        return { target, error: message, status } as const;
      } finally {
        await adapter.destroy().catch(() => undefined);
      }
    });

    const list: Vod[] = [];
    for (const outcome of outcomes) {
      if ("list" in outcome && Array.isArray(outcome.list)) list.push(...outcome.list);
      statuses.push(outcome.status);
    }

    return { list, statuses, page, hasMore: statuses.some((status) => status.hasMore === true) };
  }

  private searchConfigRecords() {
    const records = this.storage.listConfigs();
    const activeSource = this.storage.getSetting<string>("activeConfig", "");
    if (this.config && activeSource && !records.some((record) => record.url === activeSource)) {
      records.unshift({ name: "当前配置", url: activeSource, enabled: true, updatedAt: Date.now() });
    }
    return records;
  }

  private activeConfigName(): string {
    const activeSource = this.storage.getSetting<string>("activeConfig", "");
    return this.storage.listConfigs().find((record) => record.url === activeSource)?.name ?? "当前配置";
  }

  private currentConfigSource(): string {
    return this.config?.sourceUrl || this.storage.getSetting<string>("activeConfig", "");
  }

  private allActiveSites(): SiteConfig[] {
    return [...(this.config?.sites ?? []), ...this.dynamicSites];
  }

  private isDynamicSite(siteKey: string): boolean {
    return this.dynamicSites.some((site) => site.key === siteKey);
  }

  private configSourceForSite(site: SiteConfig): string {
    return this.isDynamicSite(site.key) ? CATVOD_CONFIG_SOURCE : this.currentConfigSource();
  }

  private async rebuildSources(): Promise<void> {
    this.sources.clear();
    await this.providerManager.clear();
    for (const site of this.allActiveSites()) {
      this.sources.set(site.key, await this.providerManager.acquire(site));
    }
  }

  private async activateConfig(source: string, name: string, config: VodConfig): Promise<VodConfig> {
    this.cancelSourceAudit();
    this.config = config;
    this.sources.clear();
    await this.providerManager.clear();
    for (const site of this.allActiveSites()) this.sources.set(site.key, await this.providerManager.acquire(site));
    this.storage.saveConfig({ name, url: source, enabled: true, updatedAt: Date.now() });
    this.storage.setActiveConfig(source);
    this.storage.setSetting("activeConfig", source);
    return config;
  }

  private async ensureSourceContext(siteKey: string): Promise<SourceContext> {
    const reference = decodeSourceReference(siteKey);
    if (reference) {
      const config = await loadVodConfig(reference.configSource);
      const site = config.sites.find((item) => item.key === reference.siteKey);
      if (!site) throw new Error(`配置中未找到播放源：${reference.siteKey}`);
      this.assertQualityAvailable(reference.configSource, site);
      const adapter = this.assertSupported(await this.providerManager.acquire(site));
      const configName = this.storage.listConfigs().find((record) => record.url === reference.configSource)?.name ?? "已保存配置";
      return {
        adapter,
        config,
        configSource: reference.configSource,
        configName,
        publicSiteKey: siteKey,
        referenced: true,
      };
    }

    const current = this.sources.get(siteKey);
    if (current) {
      if (this.isDynamicSite(siteKey) && this.dynamicConfig) {
        this.assertQualityAvailable(CATVOD_CONFIG_SOURCE, current.site);
        return {
          adapter: this.assertSupported(current),
          config: this.dynamicConfig,
          configSource: CATVOD_CONFIG_SOURCE,
          configName: "CatVod 服务",
          publicSiteKey: siteKey,
          referenced: false,
        };
      }
      if (this.config) {
        this.assertQualityAvailable(this.currentConfigSource(), current.site);
        return {
          adapter: this.assertSupported(current),
          config: this.config,
          configSource: this.currentConfigSource(),
          configName: this.activeConfigName(),
          publicSiteKey: siteKey,
          referenced: false,
        };
      }
    }

    const activeSource = this.storage.getSetting<string>("activeConfig", "");
    const savedConfigs = this.storage.listConfigs().filter((record) => record.url !== activeSource);
    const failures: string[] = [];

    for (const record of savedConfigs) {
      try {
        const config = await loadVodConfig(record.url);
        const site = config.sites.find((item) => item.key === siteKey);
        if (!site) continue;
        this.assertQualityAvailable(record.url, site);
        await this.activateConfig(record.url, record.name, config);
        const restored = this.sources.get(siteKey);
        if (restored && this.config) {
          return {
            adapter: this.assertSupported(restored),
            config: this.config,
            configSource: record.url,
            configName: record.name,
            publicSiteKey: siteKey,
            referenced: false,
          };
        }
      } catch (error) {
        failures.push(`${record.name}：${errorMessage(error)}`);
      }
    }

    const suffix = failures.length > 0 ? `；已保存配置恢复失败：${failures.join("；")}` : "";
    throw new Error(`播放源 ${siteKey} 不在当前配置中，请切换回包含该源的配置${suffix}`);
  }

  private assertSupported(source: SourceAdapter): SourceAdapter {
    if (!source.supported) throw new Error(`站点 ${source.site.name} 无法执行：${source.reason ?? "缺少可用运行时"}`);
    return source;
  }

  private assertQualityAvailable(configSource: string, site: SiteConfig): void {
    const record = this.matchingQuality(configSource, site);
    if (!qualityHidesSource(record)) return;
    throw new Error(`播放源 ${site.name} 已被自动屏蔽：${record?.reason ?? "稳定性检测未通过"}`);
  }

  private matchingQuality(configSource: string, site: SiteConfig): SourceQualityRecord | undefined {
    if (!configSource) return undefined;
    const record = this.storage.getSourceQuality(configSource, site.key);
    return record?.fingerprint === sourceFingerprint(site) ? record : undefined;
  }

  private annotateReferencedResult(result: SourceResult, context: SourceContext): void {
    result.list.forEach((vod) => {
      vod.siteKey = context.publicSiteKey;
      vod.siteName = context.referenced ? `${context.adapter.site.name} · ${context.configName}` : (vod.siteName ?? context.adapter.site.name);
      if (context.referenced) vod.configName = context.configName;
    });
  }

  private recordQualitySuccess(
    configSource: string,
    site: SiteConfig,
    stage: SourceQualityStage,
    latencyMs: number,
    reason: string,
  ): void {
    const current = this.matchingQuality(configSource, site);
    const now = Date.now();
    this.storage.saveSourceQuality({
      configSource,
      siteKey: site.key,
      fingerprint: sourceFingerprint(site),
      state: stage === "media" ? "healthy" : (current?.state === "healthy" ? "healthy" : "unknown"),
      stage,
      reason,
      latencyMs: Math.max(0, Math.round(latencyMs)),
      checkedAt: now,
      failureCount: stage === "media" ? 0 : (current?.failureCount ?? 0),
      successCount: (current?.successCount ?? 0) + 1,
      ...sourceQualityMetrics(current, stage, "success", now),
    });
  }

  private recordQualityFailure(
    configSource: string,
    site: SiteConfig,
    stage: SourceQualityStage,
    reason: string,
    latencyMs: number,
    forcedState?: "degraded" | "blocked",
  ): void {
    const current = this.matchingQuality(configSource, site);
    const now = Date.now();
    const classified = forcedState ?? classifyQualityFailure(reason);
    const preserveVerifiedPlayback = current?.state === "healthy" && ["home", "search", "runtime"].includes(stage);
    const state = preserveVerifiedPlayback ? "healthy" : classified;
    this.storage.saveSourceQuality({
      configSource,
      siteKey: site.key,
      fingerprint: sourceFingerprint(site),
      state,
      stage: preserveVerifiedPlayback ? current.stage : stage,
      reason: preserveVerifiedPlayback ? current.reason : reason,
      latencyMs: Math.max(0, Math.round(latencyMs)),
      checkedAt: now,
      failureCount: (current?.failureCount ?? 0) + 1,
      successCount: current?.successCount ?? 0,
      ...sourceQualityMetrics(current, stage, "failure", now),
    });
  }

  private saveStaticBlocked(configSource: string, site: SiteConfig, reason: string): void {
    const current = this.matchingQuality(configSource, site);
    const now = Date.now();
    this.storage.saveSourceQuality({
      configSource,
      siteKey: site.key,
      fingerprint: sourceFingerprint(site),
      state: "blocked",
      stage: "static",
      reason,
      latencyMs: 0,
      checkedAt: current?.checkedAt || Date.now(),
      failureCount: current?.failureCount ?? 0,
      successCount: current?.successCount ?? 0,
      ...sourceQualityMetrics(current, "static", "failure", now),
    });
  }

  private saveChecking(configSource: string, site: SiteConfig): void {
    const current = this.matchingQuality(configSource, site);
    this.storage.saveSourceQuality({
      configSource,
      siteKey: site.key,
      fingerprint: sourceFingerprint(site),
      state: "checking",
      stage: "static",
      reason: "正在逐项检测首页、搜索、详情和播放链路",
      latencyMs: 0,
      checkedAt: Date.now(),
      failureCount: current?.failureCount ?? 0,
      successCount: current?.successCount ?? 0,
      ...sourceQualityMetrics(current, "static", "preserve"),
    });
  }

  private saveAuditOutcome(configSource: string, site: SiteConfig, outcome: AuditOutcome): void {
    const current = this.matchingQuality(configSource, site);
    const preserveVerifiedPlayback = current?.state === "healthy"
      && outcome.state !== "blocked"
      && ["home", "search", "runtime"].includes(outcome.stage);
    const state = preserveVerifiedPlayback ? "healthy" : outcome.state;
    const now = Date.now();
    this.storage.saveSourceQuality({
      configSource,
      siteKey: site.key,
      fingerprint: sourceFingerprint(site),
      state,
      stage: preserveVerifiedPlayback ? current.stage : outcome.stage,
      reason: preserveVerifiedPlayback ? current.reason : outcome.reason,
      latencyMs: outcome.latencyMs,
      checkedAt: now,
      failureCount: state === "healthy" ? 0 : outcome.state === "unknown" ? (current?.failureCount ?? 0) : (current?.failureCount ?? 0) + 1,
      successCount: (current?.successCount ?? 0) + (outcome.state === "healthy" ? 1 : 0),
      ...sourceQualityMetrics(
        current,
        outcome.stage,
        outcome.state === "healthy" ? "success" : outcome.state === "unknown" ? "preserve" : "failure",
        now,
      ),
    });
  }

  private async auditSingleSource(site: SiteConfig, config: VodConfig, signal: AbortSignal): Promise<AuditOutcome> {
    const startedAt = Date.now();
    const capability = getSiteCapability(site);
    if (!capability.supported) {
      return {
        state: "blocked",
        stage: "static",
        reason: capability.reason ?? "当前设备不支持该播放源运行时",
        latencyMs: 0,
      };
    }

    const adapter = this.adapterFactory.create(site);
    const failures: string[] = [];
    try {
      await runAuditOperation(() => adapter.init(), signal);

      let sample: Vod | undefined;
      if (capability.capabilities.home) {
        try {
          const home = await runAuditOperation((operationSignal) => adapter.home(operationSignal), signal);
          sample = home.list.find((item) => item.vodTag !== "action") ?? home.list[0];
          if (!home.list.length) failures.push("首页未返回内容");
        } catch (error) {
          failures.push(`首页：${errorMessage(error)}`);
        }
      }

      if (sample?.vodTag === "folder" && capability.capabilities.category) {
        try {
          const category = await runAuditOperation((operationSignal) => adapter.category(sample!.vodId, "1", {}, operationSignal), signal);
          sample = category.list.find((item) => item.vodTag !== "folder" && item.vodTag !== "action") ?? category.list[0];
        } catch (error) {
          failures.push(`分类：${errorMessage(error)}`);
        }
      }

      if (!sample && capability.capabilities.search) {
        for (const term of SOURCE_AUDIT_SEARCH_TERMS) {
          try {
            const search = await runAuditOperation((operationSignal) => adapter.search(term, "1", true, operationSignal), signal);
            sample = search.list.find((item) => item.vodTag !== "folder" && item.vodTag !== "action") ?? search.list[0];
            if (sample) break;
          } catch (error) {
            failures.push(`搜索：${errorMessage(error)}`);
            break;
          }
        }
      }

      if (!sample) {
        return {
          state: "unknown",
          stage: capability.capabilities.search ? "search" : "home",
          reason: failures.length
            ? `本次抽样未取得可验证影片：${failures.join("；")}`
            : "首页和抽样搜索未返回结果，不能据此判定播放源不可用",
          latencyMs: Date.now() - startedAt,
        };
      }

      if (!capability.capabilities.detail || !capability.capabilities.player) {
        return {
          state: "blocked",
          stage: "static",
          reason: "播放源缺少详情或播放能力",
          latencyMs: Date.now() - startedAt,
        };
      }

      const detail = await runAuditOperation((operationSignal) => adapter.detail(sample!.vodId, operationSignal), signal);
      const episode = detail.flags.flatMap((line) => line.episodes.map((item) => ({ flag: line.flag, episode: item })))[0];
      if (!episode) {
        return {
          state: "blocked",
          stage: "detail",
          reason: "详情接口未返回可播放剧集",
          latencyMs: Date.now() - startedAt,
        };
      }

      const player = await runAuditOperation(
        (operationSignal) => Promise.resolve(adapter.player(episode.flag, episode.episode.url, config.flags ?? [], operationSignal)),
        signal,
      );
      const resolved = await runAuditOperation(
        (operationSignal) => resolvePlayerResult(player, config.parses ?? [], operationSignal),
        signal,
      );
      if (!resolved.url?.trim()) {
        return {
          state: "blocked",
          stage: "player",
          reason: "播放解析未返回有效地址",
          latencyMs: Date.now() - startedAt,
        };
      }

      if (isLikelyPlaybackPage(resolved.url)) {
        return {
          state: "degraded",
          stage: "media",
          reason: "播放依赖网页嗅探，速度和成功率低于直链来源，仍保留为兼容来源",
          latencyMs: Date.now() - startedAt,
        };
      }

      const probe = await probeMediaUrl(resolved.url, {
        headers: resolved.headers,
        ...(resolved.format ? { expectedFormat: resolved.format } : {}),
        timeoutMs: SOURCE_AUDIT_MEDIA_TIMEOUT_MS,
        signal,
      });
      if (probe.ok) {
        return {
          state: "healthy",
          stage: "media",
          reason: `首页、详情和媒体地址均通过检测${probe.format ? `（${probe.format.toUpperCase()}）` : ""}`,
          latencyMs: Date.now() - startedAt,
        };
      }

      return {
        state: classifyQualityFailure(probe.reason),
        stage: "media",
        reason: `媒体地址检测失败：${probe.reason}`,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = errorMessage(error);
      return {
        state: classifyQualityFailure(message),
        stage: inferFailureStage(message),
        reason: message,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      await adapter.destroy().catch(() => undefined);
    }
  }

  private async findQualityTarget(siteKey: string): Promise<QualityTarget> {
    const reference = decodeSourceReference(siteKey);
    if (reference) {
      const config = await loadVodConfig(reference.configSource);
      const site = config.sites.find((item) => item.key === reference.siteKey);
      if (!site) throw new Error(`配置中未找到播放源：${reference.siteKey}`);
      return { site, config, configSource: reference.configSource };
    }

    if (this.dynamicConfig) {
      const site = this.dynamicSites.find((item) => item.key === siteKey);
      if (site) return { site, config: this.dynamicConfig, configSource: CATVOD_CONFIG_SOURCE };
    }

    if (this.config) {
      const site = this.config.sites.find((item) => item.key === siteKey);
      if (site) return { site, config: this.config, configSource: this.currentConfigSource() };
    }

    for (const record of this.storage.listConfigs()) {
      const config = await loadVodConfig(record.url);
      const site = config.sites.find((item) => item.key === siteKey);
      if (site) return { site, config, configSource: record.url };
    }
    throw new Error(`未找到播放源：${siteKey}`);
  }
}

function normalizedSearchSiteKeys(values: string[] | undefined): Set<string> {
  return new Set((values ?? [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 200));
}

function normalizeSearchSourceLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(50, Math.floor(Number(value))));
}

function publishSearchEvent(
  callback: ((event: IncrementalSearchEvent) => void) | undefined,
  event: IncrementalSearchEvent,
): void {
  if (!callback) return;
  try {
    callback(event);
  } catch {
    // Search results must continue even if the renderer closes or rejects an event.
  }
}

async function mapConcurrent<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  if (values.length === 0) return [];
  const output = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await worker(values[index]!);
    }
  });
  await Promise.all(runners);
  return output;
}

async function runAuditOperation<T>(task: ((signal: AbortSignal) => Promise<T>) | (() => Promise<T>), signal: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(SOURCE_AUDIT_OPERATION_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  if (combined.aborted) throw combined.reason ?? new Error("检测已取消");
  return taskWithAbort(task(combined), combined);
}

async function taskWithAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("操作已取消");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("操作已取消"));
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isSearchEligibleSite(site: SiteConfig): boolean {
  if (site.searchable === 0 || site.hide === 1) return false;
  if (["discovery", "tool", "live", "comic", "audio"].includes(site.contentType ?? "")) return false;
  return true;
}

function providerSearchIdentity(site: SiteConfig): string {
  return JSON.stringify({
    type: site.type,
    api: site.api,
    ext: site.ext ?? "",
    jar: site.jar ?? "",
    playUrl: site.playUrl ?? "",
    header: site.header ?? {},
  });
}

function emptyAuditStatus(): SourceAuditStatus {
  return {
    running: false,
    total: 0,
    completed: 0,
    healthy: 0,
    unknown: 0,
    degraded: 0,
    blocked: 0,
    skipped: 0,
  };
}

function countAuditStates(records: Array<SourceQualityRecord | undefined>) {
  return records.reduce((counts, record) => {
    if (record?.state === "healthy") counts.healthy += 1;
    if (record?.state === "unknown") counts.unknown += 1;
    if (record?.state === "degraded") counts.degraded += 1;
    if (record?.state === "blocked") counts.blocked += 1;
    return counts;
  }, { healthy: 0, unknown: 0, degraded: 0, blocked: 0 });
}

function unknownQuality(configSource: string, site: SiteConfig): SourceQualityRecord {
  return {
    configSource,
    siteKey: site.key,
    fingerprint: sourceFingerprint(site),
    state: "unknown",
    stage: "static",
    reason: "尚未完成播放链路检测",
    latencyMs: 0,
    checkedAt: 0,
    failureCount: 0,
    successCount: 0,
  };
}

function qualityPriority(state: SourceQualityState | undefined): number {
  if (state === "healthy") return 0;
  if (state === "checking") return 1;
  if (state === "unknown" || state === undefined) return 2;
  if (state === "degraded") return 3;
  return 4;
}

function isLikelyPlaybackPage(value: string): boolean {
  if (DIRECT_MEDIA_PATTERN.test(value)) return false;
  try {
    const url = new URL(value);
    if (/\.(?:html?|shtml)(?:$|[?#])/i.test(url.pathname)) return true;
    if (/\/(?:v_show|x\/cover|x\/page|play|video)\//i.test(url.pathname)) return true;
    return /(?:^|\.)(?:iqiyi\.com|youku\.com|v\.qq\.com|mgtv\.com|bilibili\.com)$/i.test(url.hostname);
  } catch {
    return true;
  }
}

function inferFailureStage(message: string): SourceQualityStage {
  if (/媒体|m3u8|mp4|HTML|格式/.test(message)) return "media";
  if (/解析|播放地址|player/.test(message)) return "player";
  if (/详情|剧集/.test(message)) return "detail";
  if (/搜索/.test(message)) return "search";
  if (/首页|分类/.test(message)) return "home";
  return "runtime";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
