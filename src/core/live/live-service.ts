import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepareHttpRequest } from "../http-auth.ts";
import type { VodConfig } from "../models.ts";
import type { EpgProgramme, LiveEpgGuide } from "./epg-models.ts";
import { buildLiveCatchupPlayback } from "./live-catchup.ts";
import { classifyLiveFailure } from "./live-failure.ts";
import { EpgService, type EpgPersistence } from "./epg-service.ts";
import type {
  LiveChannel,
  LiveLine,
  LiveLineHealth,
  LiveLineQualityRecord,
  LivePlaybackFeedback,
  LiveSource,
  LiveSourceDefinition,
  LiveSourceSummary,
} from "./live-models.ts";
import { parseEmbeddedLive, parseLiveText } from "./live-parser.ts";

export type LiveFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LiveLineQualityPersistence {
  getLiveLineQuality(sourceId: string, channelId: string, lineId: string): LiveLineQualityRecord | undefined;
  saveLiveLineProbe(sourceId: string, channelId: string, lineId: string, lineName: string, health: LiveLineHealth): LiveLineQualityRecord;
  recordLiveLinePlayback(feedback: LivePlaybackFeedback): LiveLineQualityRecord;
}

interface CachedLiveSource {
  source?: LiveSource;
  error?: string;
}

export class LiveService {
  private readonly configProvider: () => VodConfig | undefined;
  private readonly fetcher: LiveFetch;
  private readonly cache = new Map<string, CachedLiveSource>();
  private readonly lineHealth = new Map<string, LiveLineHealth>();
  private readonly epgService: EpgService;
  private readonly lineQualityPersistence?: LiveLineQualityPersistence;
  private configIdentity = "";

  constructor(
    configProvider: () => VodConfig | undefined,
    fetcher: LiveFetch = (input, init) => fetch(input, init),
    epgPersistence?: EpgPersistence,
    lineQualityPersistence?: LiveLineQualityPersistence,
  ) {
    this.configProvider = configProvider;
    this.fetcher = fetcher;
    this.epgService = new EpgService(fetcher, epgPersistence);
    this.lineQualityPersistence = lineQualityPersistence;
  }

  invalidate(): void {
    this.cache.clear();
    this.lineHealth.clear();
    this.epgService.invalidate();
    this.configIdentity = "";
  }

  listDefinitions(): LiveSourceDefinition[] {
    this.refreshConfigIdentity();
    return [...(this.configProvider()?.lives ?? [])];
  }

  listSummaries(): LiveSourceSummary[] {
    return this.listDefinitions().map((definition) => {
      const cached = this.cache.get(definition.id);
      const source = cached?.source;
      return {
        id: definition.id,
        name: definition.name,
        ...(definition.url ? { sourceUrl: definition.url } : {}),
        boot: Boolean(definition.boot),
        loaded: Boolean(source),
        groupCount: source?.groups.length ?? 0,
        channelCount: source?.groups.reduce((sum, group) => sum + group.channels.length, 0) ?? 0,
        lineCount: source?.groups.reduce((sum, group) => sum + group.channels.reduce((subtotal, channel) => subtotal + channel.lines.length, 0), 0) ?? 0,
        ...(source ? { format: source.format, loadedAt: source.loadedAt } : {}),
        ...(cached?.error ? { error: cached.error } : {}),
      };
    });
  }

  async loadAll(force = false): Promise<LiveSourceSummary[]> {
    const definitions = this.listDefinitions();
    await Promise.all(definitions.map((definition) => this.loadSource(definition.id, force).catch(() => undefined)));
    return this.listSummaries();
  }

  async loadSource(sourceId: string, force = false): Promise<LiveSource> {
    const definition = this.requireDefinition(sourceId);
    const cached = this.cache.get(sourceId);
    if (!force && cached?.source) return cached.source;
    try {
      const source = definition.groups?.length
        ? parseEmbeddedLive(definition)
        : await this.loadExternalSource(definition);
      this.applyPersistedLineQuality(source);
      this.cache.set(sourceId, { source });
      return source;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cache.set(sourceId, { error: message });
      throw new Error(`直播源“${definition.name}”加载失败：${message}`);
    }
  }

  async searchChannels(sourceId: string, query = "", groupId?: string): Promise<LiveChannel[]> {
    const source = await this.loadSource(sourceId);
    const normalized = query.trim().toLowerCase();
    return source.groups
      .filter((group) => !groupId || group.id === groupId)
      .flatMap((group) => group.channels)
      .filter((channel) => !normalized || `${channel.name} ${channel.number ?? ""} ${channel.tvgId ?? ""} ${channel.tvgName ?? ""}`.toLowerCase().includes(normalized));
  }

  async getChannel(sourceId: string, channelId: string): Promise<LiveChannel> {
    const source = await this.loadSource(sourceId);
    const channel = source.groups.flatMap((group) => group.channels).find((item) => item.id === channelId);
    if (!channel) throw new Error("直播频道不存在或已从来源中移除");
    return channel;
  }

  async getLine(sourceId: string, channelId: string, lineId?: string): Promise<{ channel: LiveChannel; line: LiveLine }> {
    const channel = await this.getChannel(sourceId, channelId);
    const line = lineId ? channel.lines.find((item) => item.id === lineId) : channel.lines[0];
    if (!line) throw new Error("直播频道没有可用线路");
    return { channel, line };
  }

  async loadEpgGuide(sourceId: string, force = false): Promise<LiveEpgGuide> {
    const definition = this.requireDefinition(sourceId);
    const source = await this.loadSource(sourceId);
    return this.epgService.loadGuide(source, definition, force);
  }

  saveEpgMapping(sourceId: string, liveChannelId: string, epgChannelId: string, epgChannelName?: string) {
    this.requireDefinition(sourceId);
    return this.epgService.saveMapping(sourceId, liveChannelId, epgChannelId, epgChannelName);
  }

  removeEpgMapping(sourceId: string, liveChannelId: string): void {
    this.requireDefinition(sourceId);
    this.epgService.removeMapping(sourceId, liveChannelId);
  }

  async resolveCatchup(sourceId: string, channelId: string, programme: EpgProgramme, lineId?: string) {
    const { channel, line } = await this.getLine(sourceId, channelId, lineId);
    return buildLiveCatchupPlayback(channel, line, programme);
  }

  recordPlaybackFeedback(feedback: LivePlaybackFeedback): LiveLineQualityRecord | undefined {
    const persistence = this.lineQualityPersistence;
    if (!persistence) return undefined;
    const record = persistence.recordLiveLinePlayback(feedback);
    const health = healthFromQualityRecord(record);
    this.lineHealth.set(lineHealthKey(feedback.sourceId, feedback.channelId, feedback.lineId), health);
    const source = this.cache.get(feedback.sourceId)?.source;
    const line = source?.groups
      .flatMap((group) => group.channels)
      .find((channel) => channel.id === feedback.channelId)
      ?.lines.find((item) => item.id === feedback.lineId);
    if (line) line.health = health;
    return record;
  }

  async inspectChannel(sourceId: string, channelId: string, force = false, lineId?: string): Promise<LiveChannel> {
    const definition = this.requireDefinition(sourceId);
    const channel = await this.getChannel(sourceId, channelId);
    const lines = lineId
      ? channel.lines.filter((line) => line.id === lineId)
      : channel.lines;
    if (lineId && lines.length === 0) throw new Error("指定的直播线路不存在或已从来源中移除");
    const quick = Boolean(lineId);
    await mapConcurrent(lines, 3, async (line) => {
      line.health = await this.inspectLine(sourceId, channel.id, definition, line, force, quick);
    });
    return channel;
  }

  private async inspectLine(
    sourceId: string,
    channelId: string,
    definition: LiveSourceDefinition,
    line: LiveLine,
    force: boolean,
    quick = false,
  ): Promise<LiveLineHealth> {
    const key = lineHealthKey(sourceId, channelId, line.id);
    const cached = this.lineHealth.get(key);
    if (!force && cached && Date.now() - cached.checkedAt < 10 * 60 * 1_000) return cached;
    const configuredTimeoutMs = Math.max(3_000, Math.min(10_000, Math.round((definition.timeout ?? 7) * 1_000)));
    const timeoutMs = quick ? Math.min(4_000, configuredTimeoutMs) : configuredTimeoutMs;
    const checkedAt = Date.now();
    const startedAt = Date.now();
    try {
      const result = await probeLiveLine(line, timeoutMs, this.fetcher);
      const latencyMs = Date.now() - startedAt;
      const health: LiveLineHealth = {
        state: result.state,
        score: qualityScore(result.state, latencyMs, result.segmentVerified, result.height, result.bandwidthKbps),
        checkedAt,
        latencyMs,
        ...(result.resolution ? { resolution: result.resolution } : {}),
        ...(result.bandwidthKbps ? { bandwidthKbps: result.bandwidthKbps } : {}),
        ...(result.segmentVerified !== undefined ? { segmentVerified: result.segmentVerified } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
      const persisted = this.lineQualityPersistence?.saveLiveLineProbe(sourceId, channelId, line.id, line.name, health);
      const merged = persisted ? healthFromQualityRecord(persisted) : health;
      this.lineHealth.set(key, merged);
      return merged;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const reason = error instanceof Error ? error.message : String(error);
      const health: LiveLineHealth = {
        state: "degraded",
        score: qualityScore("degraded", latencyMs, false),
        checkedAt,
        latencyMs,
        reason: /timeout|aborted/i.test(reason) ? "检测超时，保留为备用线路" : `网络检测异常：${reason}`,
      };
      const persisted = this.lineQualityPersistence?.saveLiveLineProbe(sourceId, channelId, line.id, line.name, health);
      const merged = persisted ? healthFromQualityRecord(persisted) : health;
      this.lineHealth.set(key, merged);
      return merged;
    }
  }

  private applyPersistedLineQuality(source: LiveSource): void {
    const persistence = this.lineQualityPersistence;
    if (!persistence) return;
    for (const group of source.groups) {
      for (const channel of group.channels) {
        for (const line of channel.lines) {
          const record = persistence.getLiveLineQuality(source.id, channel.id, line.id);
          if (!record) continue;
          const health = healthFromQualityRecord(record);
          line.health = health;
          this.lineHealth.set(lineHealthKey(source.id, channel.id, line.id), health);
        }
      }
    }
  }

  private async loadExternalSource(definition: LiveSourceDefinition): Promise<LiveSource> {
    if (!definition.url) throw new Error("缺少直播列表 URL 或内嵌 groups");
    const { text, sourceUrl } = await this.readText(definition);
    return parseLiveText(text, definition, sourceUrl);
  }

  private async readText(definition: LiveSourceDefinition): Promise<{ text: string; sourceUrl: string }> {
    const source = definition.url!;
    const url = new URL(source);
    if (url.protocol === "file:") {
      return { text: await readFile(fileURLToPath(url), "utf8"), sourceUrl: url.toString() };
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`不支持的直播列表协议：${url.protocol}`);
    const timeoutMs = Math.max(3_000, Math.min(60_000, Math.round((definition.timeout ?? 20) * 1_000)));
    const headers = {
      ...definition.header,
      ...(definition.ua ? { "User-Agent": definition.ua } : {}),
      ...(definition.origin ? { Origin: definition.origin } : {}),
      ...(definition.referer ? { Referer: definition.referer } : {}),
    };
    const request = prepareHttpRequest(url.toString(), {
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const response = await this.fetcher(request.url, request.init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error("直播列表内容为空");
    return { text, sourceUrl: response.url || request.url };
  }

  private requireDefinition(sourceId: string): LiveSourceDefinition {
    const definition = this.listDefinitions().find((item) => item.id === String(sourceId ?? "").trim());
    if (!definition) throw new Error("直播源不存在或当前配置已切换");
    return definition;
  }

  private refreshConfigIdentity(): void {
    const config = this.configProvider();
    const identity = config ? `${config.sourceUrl}\u0000${JSON.stringify(config.lives ?? [])}` : "";
    if (identity === this.configIdentity) return;
    this.configIdentity = identity;
    this.cache.clear();
    this.lineHealth.clear();
    this.epgService.invalidate();
  }
}

function lineHealthKey(sourceId: string, channelId: string, lineId: string): string {
  return `${sourceId}\u0000${channelId}\u0000${lineId}`;
}

function healthFromQualityRecord(record: LiveLineQualityRecord, now = Date.now()): LiveLineHealth {
  const probeAge = record.lastProbeAt > 0 ? Math.max(0, now - record.lastProbeAt) : Number.POSITIVE_INFINITY;
  const state = record.state === "unavailable" && probeAge > 10 * 60 * 1_000
    ? "degraded"
    : record.state;
  const averageStartupMs = record.startupSamples > 0
    ? Math.round(record.startupTotalMs / record.startupSamples)
    : undefined;
  const recentFailure = record.lastFailureAt > 0 && now - record.lastFailureAt <= 24 * 60 * 60 * 1_000
    ? record.lastFailureReason
    : undefined;
  return {
    state,
    score: record.score,
    checkedAt: record.lastProbeAt || record.updatedAt,
    ...(record.probeLatencyMs !== undefined ? { latencyMs: record.probeLatencyMs } : {}),
    ...(record.resolution ? { resolution: record.resolution } : {}),
    ...(record.bandwidthKbps !== undefined ? { bandwidthKbps: record.bandwidthKbps } : {}),
    ...(record.segmentVerified !== undefined ? { segmentVerified: record.segmentVerified } : {}),
    playbackSuccessCount: record.playbackSuccessCount,
    playbackFailureCount: record.playbackFailureCount,
    stablePlaybackSeconds: record.stablePlaybackSeconds,
    bufferingCount: record.bufferingCount,
    bufferingDurationMs: record.bufferingDurationMs,
    failoverSuccessCount: record.failoverSuccessCount,
    failoverFailureCount: record.failoverFailureCount,
    ...(averageStartupMs !== undefined ? { averageStartupMs } : {}),
    ...(record.lastPlaybackAt > 0 ? { lastPlaybackAt: record.lastPlaybackAt } : {}),
    ...(recentFailure ? { reason: `最近播放失败：${recentFailure}` } : record.probeReason ? { reason: record.probeReason } : {}),
  };
}

interface LiveProbeOutcome {
  state: "available" | "degraded" | "unavailable";
  reason: string;
  segmentVerified?: boolean;
  resolution?: string;
  height?: number;
  bandwidthKbps?: number;
}

async function probeLiveLine(line: LiveLine, timeoutMs: number, fetcher: LiveFetch): Promise<LiveProbeOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  const hls = line.format === "hls" || /\.m3u8(?:$|[?#])/i.test(line.url);
  const dash = line.format === "dash" || /\.mpd(?:$|[?#])/i.test(line.url);
  const response = await fetchLiveResource(line.url, line.headers, signal, fetcher, hls || dash ? undefined : "bytes=0-4095");
  if (!response.ok) {
    const failure = classifyLiveFailure(`HTTP ${response.status}`, response.status);
    return {
      state: failure.definitive ? "unavailable" : "degraded",
      reason: `${failure.label}：HTTP ${response.status}${failure.definitive ? "，已暂时屏蔽" : "，保留为备用线路"}`,
    };
  }

  if (dash) {
    const manifest = await response.text();
    if (!/<MPD\b/i.test(manifest)) return { state: "unavailable", reason: "返回内容不是有效 DASH 清单，已暂时屏蔽" };
    if (/<ContentProtection\b/i.test(manifest)) {
      return { state: "unavailable", reason: `DRM 保护：DASH ContentProtection${drmSystemLabel(manifest)}` };
    }
    return { state: "degraded", reason: "DASH 清单可访问，实际分片将在播放器中验证", segmentVerified: false };
  }

  if (!hls) {
    const bytes = await readResponseSample(response);
    return bytes > 0 || Number(response.headers.get("content-length") ?? 0) > 0
      ? { state: "available", reason: "媒体端点可访问" }
      : { state: "degraded", reason: "端点可访问，但未读取到媒体数据" };
  }

  const manifest = await response.text();
  if (!/^#EXTM3U\b/m.test(manifest)) {
    return { state: "unavailable", reason: "返回内容不是有效 HLS 清单，已暂时屏蔽" };
  }
  const drm = hlsDrmLabel(manifest);
  if (drm) return { state: "unavailable", reason: `DRM 保护：${drm}` };

  const quality = bestHlsQuality(manifest);
  let mediaManifest = manifest;
  let mediaUrl = response.url || line.url;
  if (quality.variantUrl) {
    const variantUrl = new URL(quality.variantUrl, mediaUrl).toString();
    const variant = await fetchLiveResource(variantUrl, line.headers, signal, fetcher);
    if (!variant.ok) {
      const failure = classifyLiveFailure(`HTTP ${variant.status}`, variant.status);
      return {
        state: failure.definitive ? "unavailable" : "degraded",
        reason: `${failure.label}：最高质量子清单返回 HTTP ${variant.status}`,
        ...quality,
      };
    }
    mediaManifest = await variant.text();
    const variantDrm = hlsDrmLabel(mediaManifest);
    if (variantDrm) return { state: "unavailable", reason: `DRM 保护：${variantDrm}`, ...quality };
    mediaUrl = variant.url || variantUrl;
  }

  const segmentPath = firstHlsMediaUri(mediaManifest);
  if (!segmentPath) {
    return { state: "degraded", reason: "清单可访问，但暂未发现可验证分片", ...quality, segmentVerified: false };
  }
  const segmentUrl = new URL(segmentPath, mediaUrl).toString();
  const segment = await fetchLiveResource(segmentUrl, line.headers, signal, fetcher, "bytes=0-2047");
  if (!segment.ok) {
    const failure = classifyLiveFailure(`HTTP ${segment.status}`, segment.status);
    return {
      state: failure.definitive ? "unavailable" : "degraded",
      reason: `${failure.label}：直播分片返回 HTTP ${segment.status}`,
      ...quality,
      segmentVerified: false,
    };
  }
  const bytes = await readResponseSample(segment);
  if (bytes <= 0) return { state: "degraded", reason: "直播分片未返回有效数据", ...quality, segmentVerified: false };
  return { state: "available", reason: "清单和直播分片均验证通过", ...quality, segmentVerified: true };
}

async function fetchLiveResource(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetcher: LiveFetch,
  range?: string,
): Promise<Response> {
  const request = prepareHttpRequest(url, {
    redirect: "follow",
    headers: { ...headers, ...(range ? { Range: range } : {}) },
    signal,
  });
  return fetcher(request.url, request.init);
}

async function readResponseSample(response: Response): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) return 0;
  try {
    const first = await reader.read();
    return first.value?.byteLength ?? 0;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function hlsDrmLabel(manifest: string): string | undefined {
  const keyLines = manifest.split(/\r?\n/).filter((line) => /^#EXT-X-(?:KEY|SESSION-KEY):/i.test(line));
  for (const line of keyLines) {
    if (/METHOD=SAMPLE-AES/i.test(line)) return "HLS SAMPLE-AES";
    const keyFormat = line.match(/KEYFORMAT="?([^",]+)"?/i)?.[1] ?? "";
    if (/widevine|fairplay|playready|com\.apple\.streamingkeydelivery|edef8ba9|9a04f079/i.test(keyFormat)) {
      return `HLS ${keyFormat}`;
    }
  }
  return undefined;
}

function drmSystemLabel(manifest: string): string {
  if (/widevine|edef8ba9/i.test(manifest)) return "（Widevine）";
  if (/playready|9a04f079/i.test(manifest)) return "（PlayReady）";
  if (/fairplay|streamingkeydelivery/i.test(manifest)) return "（FairPlay）";
  return "";
}

function bestHlsQuality(manifest: string): Pick<LiveProbeOutcome, "resolution" | "height" | "bandwidthKbps"> & { variantUrl?: string } {
  const lines = manifest.split(/\r?\n/).map((line) => line.trim());
  let best: { variantUrl?: string; resolution?: string; height?: number; bandwidthKbps?: number; rank: number } = { rank: -1 };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    const attrs = line.slice(line.indexOf(":") + 1);
    const resolution = attrs.match(/RESOLUTION=(\d+x\d+)/i)?.[1];
    const height = Number(resolution?.split("x")[1] ?? 0) || undefined;
    const bandwidth = Number(attrs.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i)?.[1] ?? 0) || undefined;
    const variantUrl = lines.slice(index + 1).find((item) => item && !item.startsWith("#"));
    const rank = (height ?? 0) * 10_000_000 + (bandwidth ?? 0);
    if (variantUrl && rank > best.rank) best = { variantUrl, resolution, height, bandwidthKbps: bandwidth ? Math.round(bandwidth / 1_000) : undefined, rank };
  }
  return {
    ...(best.variantUrl ? { variantUrl: best.variantUrl } : {}),
    ...(best.resolution ? { resolution: best.resolution } : {}),
    ...(best.height ? { height: best.height } : {}),
    ...(best.bandwidthKbps ? { bandwidthKbps: best.bandwidthKbps } : {}),
  };
}

function firstHlsMediaUri(manifest: string): string | undefined {
  return manifest.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
}

function qualityScore(
  state: LiveLineHealth["state"],
  latencyMs: number,
  segmentVerified = false,
  height?: number,
  bandwidthKbps?: number,
): number {
  if (state === "unavailable") return 0;
  if (state === "degraded") return Math.max(5, 25 - Math.min(15, Math.round(latencyMs / 500)));
  let score = 55;
  if (segmentVerified) score += 20;
  if (latencyMs <= 500) score += 15;
  else if (latencyMs <= 1_200) score += 12;
  else if (latencyMs <= 2_500) score += 8;
  else if (latencyMs <= 5_000) score += 4;
  if ((height ?? 0) >= 2160) score += 10;
  else if ((height ?? 0) >= 1080) score += 8;
  else if ((height ?? 0) >= 720) score += 5;
  else if ((height ?? 0) >= 480) score += 2;
  if ((bandwidthKbps ?? 0) >= 8_000) score += 5;
  else if ((bandwidthKbps ?? 0) >= 4_000) score += 4;
  else if ((bandwidthKbps ?? 0) >= 2_000) score += 3;
  else if ((bandwidthKbps ?? 0) >= 800) score += 1;
  return Math.min(100, score);
}

async function mapConcurrent<T>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const value = values[index++]!;
      await worker(value);
    }
  });
  await Promise.all(runners);
}
