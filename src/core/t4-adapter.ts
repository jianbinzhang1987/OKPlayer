import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import {
  combineSourceSignal,
  runSourceOperation,
  type SourceAdapter,
  type SourceCapabilities,
  type SourceHealth,
} from "./source-adapter.ts";
import { parseSourceResult } from "./vod-parser.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

function encodeUrlSafeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("T4 服务响应不是有效 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function headers(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function playerUrl(value: unknown, fallback: string): string {
  if (typeof value === "string") return value || fallback;
  if (Array.isArray(value)) {
    for (let index = 1; index < value.length; index += 2) {
      const candidate = value[index];
      if (typeof candidate === "string" && candidate) return candidate;
    }
  }
  return fallback;
}

export class T4Adapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "t4" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = {
    home: true,
    category: true,
    search: true,
    detail: true,
    player: true,
    proxy: true,
    health: true,
  };

  private resolvedExtend: string | undefined;

  constructor(site: SiteConfig) {
    this.site = site;
    if (![4, 6, 8].includes(site.type)) {
      throw new Error(`T4Adapter 当前仅支持 type=4/6/8，实际为 type=${site.type}`);
    }
    if (!/^https?:\/\//i.test(site.api)) throw new Error("T4 服务地址必须使用 HTTP/HTTPS");
  }

  async init(): Promise<void> {
    await this.resolveExtend();
  }

  async home(signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "home", async () => {
      const raw = await this.callObject({ filter: "true" }, signal);
      return this.mark(parseSourceResult(raw));
    });
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      const encodedExtend = this.site.type === 4
        ? encodeUrlSafeBase64(JSON.stringify(extend))
        : Buffer.from(JSON.stringify({ src: JSON.stringify(extend) }), "utf8").toString("base64");
      const raw = await this.callObject({
        ac: this.site.type === 4 ? "detail" : "videolist",
        t: tid,
        pg: page,
        ext: encodedExtend,
      }, signal);
      return this.mark(parseSourceResult(raw));
    });
  }

  async search(keyword: string, page = "1", quick = false, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      const params: Record<string, string> = this.site.type === 4
        ? { wd: keyword, quick: String(quick), extend: "" }
        : { wd: keyword, pg: page };
      if (this.site.type === 4 && page !== "1") params.pg = page;
      const raw = await this.callObject(params, signal);
      return this.mark(parseSourceResult(raw));
    });
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      const raw = await this.callObject({ ac: "detail", ids: id }, signal);
      const result = this.mark(parseSourceResult(raw));
      const vod = result.list[0];
      if (vod === undefined) throw new Error("T4 服务未返回影片详情");
      return vod;
    });
  }

  async player(flag: string, episodeUrl: string, _flags: string[] = [], signal?: AbortSignal): Promise<PlayerResult> {
    return runSourceOperation(this.site, "player", async () => {
      const raw = await this.callObject({ flag, play: episodeUrl }, signal);
      const responseHeaders = headers(raw.header ?? raw.headers);
      return {
        key: this.site.key,
        flag,
        url: playerUrl(raw.url, episodeUrl),
        parse: Number(raw.parse ?? raw.jx ?? 0),
        playUrl: typeof raw.playUrl === "string" ? raw.playUrl : "",
        header: { ...(this.site.header ?? {}), ...responseHeaders },
        ...(typeof raw.format === "string" ? { format: raw.format } : {}),
      };
    });
  }

  async proxy(params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    return runSourceOperation(this.site, "proxy", async () => this.call(params, signal));
  }

  async healthCheck(signal?: AbortSignal): Promise<SourceHealth> {
    return runSourceOperation(this.site, "health", async () => {
      const startedAt = Date.now();
      await this.callObject({ filter: "true" }, signal);
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        message: "T4 服务可用",
      };
    });
  }

  async destroy(): Promise<void> {
    this.resolvedExtend = undefined;
  }

  private mark(result: SourceResult): SourceResult {
    result.list.forEach((vod) => {
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
    });
    return result;
  }

  private async callObject(params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return record(await this.call(params, signal));
  }

  private async call(params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const timeoutMs = Math.max(1, this.site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const requestParams = { ...params };
    const extend = await this.resolveExtend(signal);
    if (extend) requestParams.extend = extend;

    const requestSignal = combineSourceSignal(timeoutMs, signal);
    const requestHeaders = { ...(this.site.header ?? {}) };
    let response: Response;
    if (extend.length > 1000) {
      requestHeaders["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
      response = await fetch(this.site.api, {
        method: "POST",
        headers: requestHeaders,
        body: new URLSearchParams(requestParams),
        redirect: "follow",
        signal: requestSignal,
      });
    } else {
      const url = new URL(this.site.api);
      for (const [key, value] of Object.entries(requestParams)) url.searchParams.set(key, value);
      response = await fetch(url, {
        headers: requestHeaders,
        redirect: "follow",
        signal: requestSignal,
      });
    }
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    const payload = await response.text();
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }

  private async resolveExtend(signal?: AbortSignal): Promise<string> {
    if (this.resolvedExtend !== undefined) return this.resolvedExtend;
    const configured = this.site.ext?.trim() ?? "";
    if (!/^https?:\/\//i.test(configured)) {
      this.resolvedExtend = configured;
      return configured;
    }

    const timeoutMs = Math.max(1, this.site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    try {
      const response = await fetch(configured, {
        headers: { ...(this.site.header ?? {}) },
        redirect: "follow",
        signal: combineSourceSignal(timeoutMs, signal),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = (await response.text()).trim();
      this.resolvedExtend = value || configured;
    } catch {
      this.resolvedExtend = configured;
    }
    return this.resolvedExtend;
  }
}
