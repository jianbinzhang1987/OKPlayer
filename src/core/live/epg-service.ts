import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { prepareHttpRequest } from "../http-auth.ts";
import type {
  EpgChannelDefinition,
  EpgMatchMethod,
  EpgProgramme,
  LiveChannelEpg,
  LiveEpgGuide,
  LiveEpgMapping,
  ParsedXmlTv,
} from "./epg-models.ts";
import { parseXmlTv } from "./epg-parser.ts";
import type { LiveChannel, LiveSource, LiveSourceDefinition } from "./live-models.ts";

export type EpgFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EpgPersistence {
  getLiveEpgCache(sourceId: string): { identity: string; guide: LiveEpgGuide; expiresAt: number } | undefined;
  saveLiveEpgCache(sourceId: string, identity: string, guide: LiveEpgGuide): void;
  deleteLiveEpgCache(sourceId: string): void;
  listLiveEpgMappings(sourceId: string): LiveEpgMapping[];
  saveLiveEpgMapping(mapping: LiveEpgMapping): void;
  removeLiveEpgMapping(sourceId: string, liveChannelId: string): void;
}

interface CachedEpgGuide {
  identity: string;
  guide: LiveEpgGuide;
}

interface ChannelMatch {
  channelId: string;
  method: EpgMatchMethod;
  confidence: number;
}

const EPG_CACHE_TTL_MS = 3 * 60 * 60 * 1_000;
const EPG_MAX_BYTES = 64 * 1024 * 1024;
const EPG_SCHEDULE_WINDOW_MS = 48 * 60 * 60 * 1_000;
const EPG_CATCHUP_HISTORY_MS = 7 * 24 * 60 * 60 * 1_000;
const EPG_SCHEDULE_LIMIT = 24;
const EPG_CATCHUP_SCHEDULE_LIMIT = 200;
const EPG_TEMPLATE_REQUEST_LIMIT = 300;
const EPG_TEMPLATE_CONCURRENCY = 6;

export class EpgService {
  private readonly fetcher: EpgFetch;
  private readonly persistence?: EpgPersistence;
  private readonly cache = new Map<string, CachedEpgGuide>();

  constructor(
    fetcher: EpgFetch = (input, init) => fetch(input, init),
    persistence?: EpgPersistence,
  ) {
    this.fetcher = fetcher;
    this.persistence = persistence;
  }

  invalidate(): void {
    this.cache.clear();
  }

  listMappings(sourceId: string): LiveEpgMapping[] {
    return this.persistence?.listLiveEpgMappings(sourceId) ?? [];
  }

  saveMapping(sourceId: string, liveChannelId: string, epgChannelId: string, epgChannelName?: string): LiveEpgMapping {
    const mapping: LiveEpgMapping = {
      sourceId,
      liveChannelId,
      epgChannelId,
      ...(epgChannelName ? { epgChannelName } : {}),
      updatedAt: Date.now(),
    };
    this.persistence?.saveLiveEpgMapping(mapping);
    this.cache.delete(sourceId);
    this.persistence?.deleteLiveEpgCache(sourceId);
    return mapping;
  }

  removeMapping(sourceId: string, liveChannelId: string): void {
    this.persistence?.removeLiveEpgMapping(sourceId, liveChannelId);
    this.cache.delete(sourceId);
    this.persistence?.deleteLiveEpgCache(sourceId);
  }

  async loadGuide(source: LiveSource, definition: LiveSourceDefinition, force = false, now = Date.now()): Promise<LiveEpgGuide> {
    const aggregateUrls = collectAggregateEpgUrls(source, definition);
    const templateUrls = collectTemplateEpgUrls(source, definition);
    const mappings = this.listMappings(source.id);
    const identity = JSON.stringify({
      aggregateUrls,
      templateUrls,
      timeZone: source.timeZone ?? definition.timeZone,
      channels: source.groups.flatMap((group) => group.channels).map((channel) => [channel.id, channel.tvgId, channel.tvgName, channel.name, channel.epgUrl]),
      mappings: mappings.map((mapping) => [mapping.liveChannelId, mapping.epgChannelId, mapping.updatedAt]),
    });
    const cached = this.cache.get(source.id);
    if (!force && cached?.identity === identity && cached.guide.expiresAt > now) return cached.guide;

    if (!force) {
      const persisted = this.persistence?.getLiveEpgCache(source.id);
      if (persisted?.identity === identity && persisted.expiresAt > now) {
        this.cache.set(source.id, { identity, guide: persisted.guide });
        return persisted.guide;
      }
    }

    const warnings: string[] = [];
    if (aggregateUrls.length === 0 && templateUrls.length === 0) {
      const empty = emptyGuide(source.id, now, ["当前直播源未配置可加载的 EPG 地址"]);
      this.rememberGuide(source.id, identity, empty);
      return empty;
    }

    const documents: ParsedXmlTv[] = [];
    const aggregateResults = await Promise.all(aggregateUrls.map(async (url) => {
      try {
        const text = await this.readEpgText(url, definition);
        return parseXmlTv(text, { now, timeZone: source.timeZone ?? definition.timeZone });
      } catch (error) {
        warnings.push(`${safeSourceLabel(url)}：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }));
    documents.push(...aggregateResults.flatMap((document) => document ?? []));

    const templateRequests = buildTemplateRequests(source, templateUrls, now, source.timeZone ?? definition.timeZone);
    if (templateRequests.length > EPG_TEMPLATE_REQUEST_LIMIT) {
      warnings.push(`按频道 EPG 请求共 ${templateRequests.length} 个，本次仅加载前 ${EPG_TEMPLATE_REQUEST_LIMIT} 个`);
    }
    const selectedTemplateRequests = templateRequests.slice(0, EPG_TEMPLATE_REQUEST_LIMIT);
    const templateDocuments = await mapConcurrentResult(selectedTemplateRequests, EPG_TEMPLATE_CONCURRENCY, async (request) => {
      try {
        const text = await this.readEpgText(request.url, definition);
        return parseXmlTv(text, { now, timeZone: source.timeZone ?? definition.timeZone });
      } catch (error) {
        warnings.push(`${request.channelName}：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    });
    documents.push(...templateDocuments.flatMap((document) => document ?? []));

    const parsed = mergeXmlTv(documents);
    const guide = buildLiveEpgGuide(
      source,
      parsed,
      now,
      aggregateUrls.length + selectedTemplateRequests.length,
      unique(warnings).slice(0, 50),
      mappings,
    );
    this.rememberGuide(source.id, identity, guide);
    return guide;
  }

  private rememberGuide(sourceId: string, identity: string, guide: LiveEpgGuide): void {
    this.cache.set(sourceId, { identity, guide });
    this.persistence?.saveLiveEpgCache(sourceId, identity, guide);
  }

  private async readEpgText(source: string, definition: LiveSourceDefinition): Promise<string> {
    const url = new URL(source);
    let bytes: Uint8Array;
    if (url.protocol === "file:") {
      const file = await readFile(fileURLToPath(url));
      bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    } else {
      if (!["http:", "https:"].includes(url.protocol)) throw new Error(`不支持的 EPG 协议：${url.protocol}`);
      const timeoutMs = Math.max(5_000, Math.min(60_000, Math.round((definition.timeout ?? 20) * 1_000)));
      const request = prepareHttpRequest(url.toString(), {
        redirect: "follow",
        headers: sourceHeaders(definition),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const response = await this.fetcher(request.url, request.init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > EPG_MAX_BYTES) throw new Error("EPG 文件超过 64 MB 安全上限");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > EPG_MAX_BYTES) throw new Error("EPG 文件超过 64 MB 安全上限");
      bytes = new Uint8Array(buffer);
    }
    const inflated = isGzip(bytes) ? gunzipSync(bytes) : bytes;
    if (inflated.byteLength > EPG_MAX_BYTES) throw new Error("解压后的 XMLTV 文件超过 64 MB 安全上限");
    const text = new TextDecoder("utf-8").decode(inflated);
    if (!text.trim()) throw new Error("EPG 内容为空");
    return text;
  }
}

export function buildLiveEpgGuide(
  source: LiveSource,
  parsed: ParsedXmlTv,
  now = Date.now(),
  epgSourceCount = 1,
  warnings: string[] = [],
  mappings: LiveEpgMapping[] = [],
): LiveEpgGuide {
  const channels = completeEpgChannels(parsed);
  const programmesByChannel = new Map<string, EpgProgramme[]>();
  for (const programme of parsed.programmes) {
    const values = programmesByChannel.get(programme.channelId) ?? [];
    values.push(programme);
    programmesByChannel.set(programme.channelId, values);
  }
  for (const values of programmesByChannel.values()) values.sort((left, right) => left.startAt - right.startAt);

  const manualMappings = new Map(mappings.map((mapping) => [mapping.liveChannelId, mapping.epgChannelId] as const));
  const guideChannels: Record<string, LiveChannelEpg> = {};
  let matchedChannelCount = 0;
  for (const liveChannel of source.groups.flatMap((group) => group.channels)) {
    const match = matchEpgChannel(liveChannel, channels, manualMappings.get(liveChannel.id));
    if (!match) {
      guideChannels[liveChannel.id] = { liveChannelId: liveChannel.id, confidence: 0, schedule: [] };
      continue;
    }
    matchedChannelCount += 1;
    const allProgrammes = programmesByChannel.get(match.channelId) ?? [];
    const supportsCatchup = Boolean(liveChannel.catchup?.source || (liveChannel.catchup?.regex && liveChannel.catchup?.replace));
    const earliestProgramme = supportsCatchup ? now - EPG_CATCHUP_HISTORY_MS : now - 5 * 60_000;
    const schedule = allProgrammes
      .filter((programme) => programme.endAt >= earliestProgramme && programme.startAt <= now + EPG_SCHEDULE_WINDOW_MS)
      .slice(0, supportsCatchup ? EPG_CATCHUP_SCHEDULE_LIMIT : EPG_SCHEDULE_LIMIT);
    const current = schedule.find((programme) => programme.startAt <= now && programme.endAt > now);
    const next = schedule.find((programme) => programme.startAt >= (current?.endAt ?? now));
    guideChannels[liveChannel.id] = {
      liveChannelId: liveChannel.id,
      epgChannelId: match.channelId,
      matchMethod: match.method,
      confidence: match.confidence,
      ...(current ? { current } : {}),
      ...(next ? { next } : {}),
      schedule,
    };
  }

  return {
    sourceId: source.id,
    loadedAt: now,
    expiresAt: now + EPG_CACHE_TTL_MS,
    epgSourceCount,
    epgChannelCount: channels.length,
    programmeCount: parsed.programmes.length,
    matchedChannelCount,
    channels: guideChannels,
    epgChannels: channels
      .map((channel) => ({ ...channel, names: [...channel.names] }))
      .sort((left, right) => (left.names[0] ?? left.id).localeCompare(right.names[0] ?? right.id, "zh-CN")),
    warnings: [...warnings],
  };
}

export function matchEpgChannel(
  channel: LiveChannel,
  epgChannels: EpgChannelDefinition[],
  manualEpgChannelId?: string,
): ChannelMatch | undefined {
  const byId = new Map(epgChannels.map((item) => [normalizeExact(item.id), item] as const));
  const nameEntries = epgChannels.flatMap((item) => item.names.map((name) => ({ channel: item, exact: normalizeExact(name), normalized: normalizeChannelName(name) })));

  const manual = normalizeExact(manualEpgChannelId ?? "");
  if (manual && byId.has(manual)) return { channelId: byId.get(manual)!.id, method: "manual", confidence: 100 };

  const tvgId = normalizeExact(channel.tvgId ?? "");
  if (tvgId && byId.has(tvgId)) return { channelId: byId.get(tvgId)!.id, method: "tvg-id", confidence: 100 };

  const tvgName = normalizeExact(channel.tvgName ?? "");
  if (tvgName) {
    const match = nameEntries.find((entry) => entry.exact === tvgName);
    if (match) return { channelId: match.channel.id, method: "tvg-name", confidence: 95 };
  }

  const exactName = normalizeExact(channel.name);
  if (exactName) {
    const match = nameEntries.find((entry) => entry.exact === exactName);
    if (match) return { channelId: match.channel.id, method: "channel-name", confidence: 90 };
  }

  const candidates = [channel.tvgName, channel.name].map((value) => normalizeChannelName(value ?? "")).filter((value) => value.length >= 2);
  for (const candidate of candidates) {
    const matches = nameEntries.filter((entry) => entry.normalized === candidate);
    if (matches.length === 1) return { channelId: matches[0]!.channel.id, method: "normalized-name", confidence: 80 };
  }
  return undefined;
}

export function normalizeChannelName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/(?:超高清|高清|标清|频道|电视台|直播|uhd|fhd|hd|sd|4k|8k)$/gi, "")
    .replace(/[\s\p{P}\p{S}_]+/gu, "")
    .replace(/中央电视台/g, "cctv")
    .replace(/央视/g, "cctv");
}

export function expandEpgTemplate(url: string, channel: LiveChannel, now = Date.now(), timeZone?: string): string {
  const values: Record<string, string> = {
    name: channel.name,
    id: channel.tvgId ?? channel.id,
    "tvg-id": channel.tvgId ?? channel.id,
    "tvg-name": channel.tvgName ?? channel.name,
    date: formatTemplateDate(now, timeZone),
  };
  return url.replace(/\{(name|id|date|tvg-id|tvg-name)\}/gi, (_match, key: string) => encodeURIComponent(values[key.toLowerCase()] ?? ""));
}

function completeEpgChannels(parsed: ParsedXmlTv): EpgChannelDefinition[] {
  const channels = new Map<string, EpgChannelDefinition>(parsed.channels.map((channel) => [channel.id, { ...channel, names: [...channel.names] }]));
  for (const programme of parsed.programmes) {
    if (!channels.has(programme.channelId)) channels.set(programme.channelId, { id: programme.channelId, names: [programme.channelId] });
  }
  return [...channels.values()];
}

function mergeXmlTv(documents: ParsedXmlTv[]): ParsedXmlTv {
  const channels = new Map<string, EpgChannelDefinition>();
  const programmes = new Map<string, EpgProgramme>();
  for (const document of documents) {
    for (const channel of document.channels) {
      const existing = channels.get(channel.id);
      channels.set(channel.id, existing
        ? { ...existing, names: [...new Set([...existing.names, ...channel.names])], icon: existing.icon ?? channel.icon }
        : { ...channel, names: [...channel.names] });
    }
    for (const programme of document.programmes) programmes.set(programme.id, programme);
  }
  return { channels: [...channels.values()], programmes: [...programmes.values()].sort((left, right) => left.startAt - right.startAt) };
}

function emptyGuide(sourceId: string, now: number, warnings: string[]): LiveEpgGuide {
  return {
    sourceId,
    loadedAt: now,
    expiresAt: now + EPG_CACHE_TTL_MS,
    epgSourceCount: 0,
    epgChannelCount: 0,
    programmeCount: 0,
    matchedChannelCount: 0,
    channels: {},
    epgChannels: [],
    warnings,
  };
}

function collectAllEpgUrls(source: LiveSource, definition: LiveSourceDefinition): string[] {
  return [...new Set([
    ...source.epgUrls,
    ...definition.epgUrls,
    ...source.groups.flatMap((group) => group.channels.flatMap((channel) => channel.epgUrl ? [channel.epgUrl] : [])),
  ].filter(Boolean))];
}

function collectAggregateEpgUrls(source: LiveSource, definition: LiveSourceDefinition): string[] {
  return collectAllEpgUrls(source, definition).filter((url) => !isPerChannelTemplate(url));
}

function collectTemplateEpgUrls(source: LiveSource, definition: LiveSourceDefinition): string[] {
  return collectAllEpgUrls(source, definition).filter(isPerChannelTemplate);
}

function isPerChannelTemplate(url: string): boolean {
  return /\{(?:name|id|date|tvg-id|tvg-name)\}/i.test(url);
}

function buildTemplateRequests(source: LiveSource, templates: string[], now: number, timeZone?: string): Array<{ url: string; channelName: string }> {
  const requests = new Map<string, { url: string; channelName: string }>();
  for (const channel of source.groups.flatMap((group) => group.channels)) {
    const channelTemplates = channel.epgUrl && isPerChannelTemplate(channel.epgUrl)
      ? unique([channel.epgUrl, ...templates])
      : templates;
    for (const template of channelTemplates) {
      const url = expandEpgTemplate(template, channel, now, timeZone);
      if (!requests.has(url)) requests.set(url, { url, channelName: channel.name });
    }
  }
  return [...requests.values()];
}

function formatTemplateDate(now: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(now));
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function sourceHeaders(definition: LiveSourceDefinition): Record<string, string> {
  return {
    ...definition.header,
    ...(definition.ua ? { "User-Agent": definition.ua } : {}),
    ...(definition.origin ? { Origin: definition.origin } : {}),
    ...(definition.referer ? { Referer: definition.referer } : {}),
  };
}

function isGzip(value: Uint8Array): boolean {
  return value.byteLength >= 2 && value[0] === 0x1f && value[1] === 0x8b;
}

function normalizeExact(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function safeSourceLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "EPG 来源";
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function mapConcurrentResult<T, R>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const current = index++;
      results[current] = await worker(values[current]!);
    }
  });
  await Promise.all(runners);
  return results;
}
