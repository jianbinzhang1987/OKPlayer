import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import {
  combineSourceSignal,
  runSourceOperation,
  STANDARD_CAPABILITIES,
  type SourceAdapter,
  type SourceCapabilities,
} from "./source-adapter.ts";
import { parseSourceResult, parseVod } from "./vod-parser.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DIRECT_MEDIA_PATTERN = /\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i;

const LINE_NAMES: Record<string, string> = {
  bfzym3u8: "暴风",
  "1080zyk": "优质",
  kuaikan: "快看",
  lzm3u8: "量子",
  ffm3u8: "非凡",
  haiwaikan: "海外看",
  gsm3u8: "光速",
  zuidam3u8: "最大",
  bjm3u8: "八戒",
  snm3u8: "索尼",
  wolong: "卧龙",
  xlm3u8: "新浪",
  yhm3u8: "樱花",
  tkm3u8: "天空",
  jsm3u8: "极速",
  wjm3u8: "无尽",
  sdm3u8: "闪电",
  kcm3u8: "快车",
  jinyingm3u8: "金鹰",
  fsm3u8: "飞速",
  hnm3u8: "红牛",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  const first = list(value).find(isRecord);
  return first ?? {};
}

function endpoint(base: string, suffix: string): string {
  return `${base.replace(/\/$/, "")}${suffix}`;
}

function pageCount(raw: Record<string, unknown>, itemCount: number): number {
  const data = record(raw.data);
  const explicit = Number(raw.pagecount ?? data.pagecount);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const total = Number(raw.total ?? data.total);
  const limit = Number(raw.limit ?? data.limit);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(limit) && limit > 0) return Math.ceil(total / limit);
  return itemCount > 0 ? 1 : 0;
}

function episodeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((entry, index) => {
    if (typeof entry === "string") return entry.trim();
    const item = record(entry);
    const url = text(item.url ?? item.play_url ?? item.link);
    if (!url) return "";
    const name = text(item.name ?? item.title ?? item.episode ?? item.n) || String(index + 1).padStart(2, "0");
    return `${name}$${url}`;
  }).filter(Boolean).join("#");
}

export class AppYsV2Adapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "appysv2" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = { ...STANDARD_CAPABILITIES };

  private readonly api: string;
  private readonly mode: 1 | 2;
  private readonly syntheticPrefix: string;
  private readonly parseApis = new Map<string, string>();

  constructor(site: SiteConfig) {
    this.site = site;
    this.api = site.ext?.trim().replace(/\/$/, "") ?? "";
    if (!/^https?:\/\//i.test(this.api)) throw new Error("AppYsV2 播放源必须在 ext 中配置 HTTP/HTTPS API 地址");
    this.mode = this.api.includes(".vod") ? 1 : 2;
    this.syntheticPrefix = `appysv2:${encodeURIComponent(site.key)}:`;
  }

  async init(): Promise<void> {}

  async home(signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "home", async () => {
      const raw = await this.request(this.mode === 1 ? "/vodPhbAll" : "/index_video", signal);
      const data = record(raw.data);
      const groups = list(this.mode === 1 ? data.list : raw.list ?? raw.data);
      const items = groups.flatMap((entry) => {
        const group = record(entry);
        const nested = list(this.mode === 1 ? group.vod_list : group.vlist);
        return nested.length > 0 ? nested : [entry];
      });
      return this.result(raw, items);
    });
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      const filters = new URLSearchParams({
        class: extend.class ?? "",
        area: extend.area ?? "",
        lang: extend.lang ?? "",
        letter: extend.letter ?? "",
        year: extend.year ?? "",
        by: extend.by ?? "",
      });
      const suffix = this.mode === 1
        ? `?tid=${encodeURIComponent(tid)}&page=${encodeURIComponent(page)}&${filters}`
        : `/video?tid=${encodeURIComponent(tid)}&pg=${encodeURIComponent(page)}&${filters}`;
      const raw = await this.request(suffix, signal);
      return this.result(raw, this.extractList(raw));
    });
  }

  async search(keyword: string, page = "1", _quick = false, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      const suffix = this.mode === 1
        ? `?wd=${encodeURIComponent(keyword)}&page=${encodeURIComponent(page)}`
        : `/search?text=${encodeURIComponent(keyword)}&pg=${encodeURIComponent(page)}`;
      const raw = await this.request(suffix, signal);
      return this.result(raw, this.extractList(raw));
    });
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      const realId = await this.resolveId(id, signal);
      const suffix = this.mode === 1
        ? `/detail?vod_id=${encodeURIComponent(realId)}`
        : `/video_detail?id=${encodeURIComponent(realId)}`;
      const raw = await this.request(suffix, signal);
      const data = record(raw.data);
      const source = firstRecord(this.mode === 1 ? data.vod_info ?? data : data.vod_info ?? raw.data ?? raw);
      const normalized = this.normalizeDetail(source, realId);
      normalized.siteKey = this.site.key;
      normalized.siteName = this.site.name;
      return normalized;
    });
  }

  player(flag: string, episodeUrl: string): PlayerResult {
    const configuredPlayUrl = this.site.playUrl ?? "";
    const parseApi = this.parseApis.get(flag) ?? "";
    const playUrl = configuredPlayUrl || parseApi;
    return {
      key: this.site.key,
      flag,
      url: episodeUrl,
      parse: DIRECT_MEDIA_PATTERN.test(episodeUrl) && playUrl === "" ? 0 : 1,
      playUrl,
      header: { ...(this.site.header ?? {}) },
    };
  }

  async destroy(): Promise<void> {
    this.parseApis.clear();
  }

  private extractList(raw: Record<string, unknown>): unknown[] {
    const data = record(raw.data);
    return list(this.mode === 1 ? data.list : raw.list ?? raw.data);
  }

  private result(raw: Record<string, unknown>, rawItems: unknown[]): SourceResult {
    const normalizedItems = rawItems.map((entry) => {
      const item = record(entry);
      if (text(item.vod_id ?? item.id)) return item;
      const name = text(item.vod_name ?? item.name);
      return name ? { ...item, vod_id: `${this.syntheticPrefix}${encodeURIComponent(name)}` } : item;
    });
    const result = parseSourceResult({ list: normalizedItems, pagecount: pageCount(raw, normalizedItems.length) });
    result.list.forEach((vod) => {
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
    });
    return result;
  }

  private normalizeDetail(source: Record<string, unknown>, fallbackId: string): Vod {
    if (text(source.vod_play_from) && text(source.vod_play_url)) {
      return parseVod({ ...source, vod_id: source.vod_id ?? fallbackId });
    }

    const rawEpisodes = list(this.mode === 1 ? source.vod_play_list : source.vod_url_with_player);
    const playMap = new Map<string, string[]>();

    for (const entry of rawEpisodes) {
      const episode = record(entry);
      const playerInfo = record(episode.player_info);
      const code = text(this.mode === 1
        ? playerInfo.from ?? playerInfo.show ?? episode.from ?? episode.show
        : episode.code ?? episode.name ?? episode.from ?? episode.show);
      if (!code) continue;
      const flag = LINE_NAMES[code] ?? code;
      const urls = episodeText(episode.url ?? episode.urls ?? episode.play_url);
      if (!urls) continue;
      const current = playMap.get(flag) ?? [];
      current.push(urls);
      playMap.set(flag, current);
      const parseApi = text(episode.parse_api ?? playerInfo.parse_api);
      if (parseApi) this.parseApis.set(flag, parseApi);
    }

    const vodPlayFrom = [...playMap.keys()].join("$$$");
    const vodPlayUrl = [...playMap.values()].map((entries) => entries.join("#")).join("$$$");
    return parseVod({
      ...source,
      vod_id: source.vod_id ?? fallbackId,
      vod_play_from: vodPlayFrom,
      vod_play_url: vodPlayUrl,
    });
  }

  private async resolveId(id: string, signal?: AbortSignal): Promise<string> {
    if (!id.startsWith(this.syntheticPrefix)) return id;
    const keyword = decodeURIComponent(id.slice(this.syntheticPrefix.length));
    const found = (await this.search(keyword, "1", false, signal)).list.find((vod) => !vod.vodId.startsWith(this.syntheticPrefix));
    if (!found) throw new Error(`AppYsV2 无法根据片名定位影片：${keyword}`);
    return found.vodId;
  }

  private async request(suffix: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeoutMs = Math.max(1, this.site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const response = await fetch(endpoint(this.api, suffix), {
      headers: { ...(this.site.header ?? {}) },
      redirect: "follow",
      signal: combineSourceSignal(timeoutMs, signal),
    });
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    const payload = await response.text();
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!isRecord(parsed)) throw new Error("响应不是 JSON 对象");
      return parsed;
    } catch (error) {
      throw new Error(`AppYsV2 返回的内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
