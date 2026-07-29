import type { PlayerResult, SiteConfig, SourceResult, Vod } from "../models.ts";
import {
  runSourceOperation,
  type SourceAdapter,
  type SourceCapabilities,
  type SourceHealth,
} from "../source-adapter.ts";
import { parseSourceResult, parseVod } from "../vod-parser.ts";
import { CatVodNodeClient } from "./catvod-node-client.ts";
import {
  resolveCatVodRuntimeUrl,
  rewriteCatVodUrl,
} from "./catvod-url-rewriter.ts";

export class CatVodNodeAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "catvod-node" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities;

  private readonly client: CatVodNodeClient;
  private initialized = false;

  constructor(site: SiteConfig, client: CatVodNodeClient) {
    this.site = site;
    this.client = client;
    this.capabilities = {
      home: true,
      category: true,
      search: site.searchable !== 0 && !["tool", "discovery", "pan"].includes(site.contentType ?? ""),
      detail: site.contentType !== "tool" && site.contentType !== "discovery",
      player: site.contentType !== "tool" && site.contentType !== "discovery",
      proxy: true,
      health: true,
    };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await runSourceOperation(this.site, "init", async () => {
      await this.client.spider(this.site.api, "init", {
        ext: this.site.ext ?? "",
        extend: this.site.ext ?? "",
      });
      this.initialized = true;
    });
  }

  async home(signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "home", async () => {
      await this.ensureInitialized();
      const raw = await this.client.spider(this.site.api, "home", { filter: true }, signal);
      return this.mark(parseSourceResult(normalizePayload(raw)));
    });
  }

  async category(
    tid: string,
    page = "1",
    extend: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      await this.ensureInitialized();
      const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
      const raw = await this.client.spider(this.site.api, "category", {
        id: tid,
        tid,
        page: currentPage,
        pg: currentPage,
        filter: true,
        filters: extend,
        extend,
      }, signal);
      return this.mark(parseSourceResult(normalizePayload(raw)));
    });
  }

  async search(keyword: string, page = "1", quick = false, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      await this.ensureInitialized();
      const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
      const raw = await this.client.spider(this.site.api, "search", {
        wd: keyword,
        key: keyword,
        page: currentPage,
        pg: currentPage,
        quick,
      }, signal);
      return this.mark(parseSourceResult(normalizePayload(raw)));
    });
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      await this.ensureInitialized();
      const raw = normalizePayload(await this.client.spider(this.site.api, "detail", { id: [id] }, signal));
      const result = parseSourceResult(raw);
      const vod = result.list[0] ?? parseVod(raw);
      return this.markVod(vod);
    });
  }

  async player(flag: string, episodeUrl: string, flags: string[] = [], signal?: AbortSignal): Promise<PlayerResult> {
    return runSourceOperation(this.site, "player", async () => {
      await this.ensureInitialized();
      const raw = normalizePayload(await this.client.spider(this.site.api, "play", {
        flag,
        id: episodeUrl,
        flags,
      }, signal));
      const value = record(raw);
      const url = resolveCatVodRuntimeUrl(extractPlayerUrl(value.url, episodeUrl), this.client.baseUrl());
      const playUrl = resolveCatVodRuntimeUrl(text(value.playUrl), this.client.baseUrl());
      const subtitleUrl = resolveCatVodRuntimeUrl(text(value.subtitle ?? value.subt), this.client.baseUrl());
      const danmakuUrl = resolveCatVodRuntimeUrl(text(value.danmaku ?? value.danmu), this.client.baseUrl());
      return {
        key: this.site.key,
        flag: text(value.flag) || flag,
        url,
        parse: finiteNumber(value.parse ?? value.jx) ?? 0,
        playUrl,
        header: { ...(this.site.header ?? {}), ...headers(value.header ?? value.headers) },
        ...(text(value.format) ? { format: text(value.format) } : {}),
        ...(subtitleUrl ? { subtitleUrl } : {}),
        ...(danmakuUrl ? { danmakuUrl } : {}),
        contentKind: this.site.contentType === "live" ? "live" : "vod",
      };
    });
  }

  async proxy(params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    return runSourceOperation(this.site, "proxy", async () => {
      const pathname = params.path ?? params.url ?? "/";
      return this.client.request(pathname, { method: "GET", signal });
    });
  }

  async healthCheck(signal?: AbortSignal): Promise<SourceHealth> {
    return runSourceOperation(this.site, "health", async () => {
      const startedAt = Date.now();
      const health = await this.client.health(signal);
      return {
        ok: health.ok === true,
        latencyMs: Date.now() - startedAt,
        message: health.ok ? "CatVod 本地服务可用" : "CatVod 本地服务健康检查失败",
      };
    });
  }

  async destroy(): Promise<void> {
    this.initialized = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.init();
  }

  private mark(result: SourceResult): SourceResult {
    if (result.categories?.length) this.site.categories = result.categories;
    result.list = result.list.map((vod) => this.markVod(vod));
    return result;
  }

  private markVod(vod: Vod): Vod {
    const explicit = vod.contentKind;
    const contentKind = explicit
      ?? (this.site.contentType === "discovery" ? "discovery"
        : this.site.contentType === "live" ? "live"
          : this.site.contentType === "tool" ? "action"
            : vod.vodTag === "folder" ? "folder"
              : vod.vodTag === "action" ? "action"
                : "playable");
    return {
      ...vod,
      siteKey: this.site.key,
      siteName: this.site.name,
      contentKind,
      vodPic: rewriteCatVodUrl(vod.vodPic, this.client.baseUrl()),
    };
  }
}

function normalizePayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const source = value.trim();
  if (!source) return {};
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return value;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function headers(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => item === undefined || item === null ? [] : [[key, String(item)]]),
  );
}

function extractPlayerUrl(value: unknown, fallback: string): string {
  if (typeof value === "string") return value || fallback;
  if (Array.isArray(value)) {
    for (let index = 1; index < value.length; index += 2) {
      if (typeof value[index] === "string" && value[index]) return value[index] as string;
    }
  }
  return fallback;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}
