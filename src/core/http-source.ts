import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import { combineSourceSignal, runSourceOperation, STANDARD_CAPABILITIES, type SourceAdapter, type SourceCapabilities } from "./source-adapter.ts";
import { parseJsonSourceResult, parseXmlSourceResult } from "./vod-parser.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DIRECT_MEDIA_PATTERN = /\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i;

export class HttpSource implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "http" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = { ...STANDARD_CAPABILITIES };

  constructor(site: SiteConfig) {
    this.site = site;
    if (![0, 1].includes(site.type)) {
      throw new Error(`HttpSource 当前仅支持 type=0/1，实际为 type=${site.type}`);
    }
  }

  async init(): Promise<void> {}

  async home(signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "home", async () => this.parse(await this.call({ filter: "true" }, signal)));
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      const params: Record<string, string> = { ac: "detail", t: tid, pg: page };
      if (this.site.type === 1 && Object.keys(extend).length > 0) params.f = JSON.stringify(extend);
      return this.parse(await this.call(params, signal));
    });
  }

  async search(keyword: string, page = "1", quick = false, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      const params: Record<string, string> = {
        wd: keyword,
        quick: String(quick),
        extend: "",
      };
      if (page !== "1") params.pg = page;
      const result = this.parse(await this.call(params, signal));
      result.list.forEach((vod) => {
        vod.siteKey = this.site.key;
        vod.siteName = this.site.name;
      });
      return result;
    });
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      const result = this.parse(await this.call({ ac: "detail", ids: id }, signal));
      const vod = result.list[0];
      if (vod === undefined) throw new Error(`站点 ${this.site.name} 未返回影片详情`);
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
      return vod;
    });
  }

  player(flag: string, episodeUrl: string): PlayerResult {
    const playUrl = this.site.playUrl ?? "";
    return {
      key: this.site.key,
      flag,
      url: episodeUrl,
      parse: DIRECT_MEDIA_PATTERN.test(episodeUrl) && playUrl === "" ? 0 : 1,
      playUrl,
      header: { ...(this.site.header ?? {}) },
    };
  }

  async destroy(): Promise<void> {}

  private parse(payload: string): SourceResult {
    return this.site.type === 0 ? parseXmlSourceResult(payload) : parseJsonSourceResult(payload);
  }

  private async call(params: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const requestParams = { ...params };
    if (this.site.type === 0 && requestParams.ac === undefined) requestParams.ac = "videolist";
    if (this.site.ext !== undefined && this.site.ext !== "") requestParams.extend = this.site.ext;
    const timeoutMs = Math.max(1, this.site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const requestSignal = combineSourceSignal(timeoutMs, signal);
    const headers = { ...(this.site.header ?? {}) };
    let response: Response;

    if ((this.site.ext?.length ?? 0) > 1000) {
      headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
      response = await fetch(this.site.api, {
        method: "POST",
        headers,
        body: new URLSearchParams(requestParams),
        signal: requestSignal,
      });
    } else {
      const url = new URL(this.site.api);
      for (const [key, value] of Object.entries(requestParams)) url.searchParams.set(key, value);
      response = await fetch(url, {
        headers,
        signal: requestSignal,
        redirect: "follow",
      });
    }

    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    return response.text();
  }
}
