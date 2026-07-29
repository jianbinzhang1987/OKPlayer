import type { SiteConfig } from "../models.ts";
import {
  CATVOD_RUNTIME_GROUP,
  CATVOD_SITE_PREFIX,
  type CatVodContentType,
  type CatVodServiceConfigSummary,
} from "./catvod-types.ts";

export interface ParsedCatVodConfig {
  sites: SiteConfig[];
  summary: CatVodServiceConfigSummary;
}

export function parseCatVodConfig(payload: unknown): ParsedCatVodConfig {
  const root = record(payload);
  const video = record(root.video);
  const rawSites = Array.isArray(video.sites) ? video.sites : [];
  const seen = new Set<string>();
  const sites: SiteConfig[] = [];

  for (const raw of rawSites) {
    const item = record(raw);
    const rawKey = text(item.key);
    const apiPath = text(item.api);
    if (!rawKey || !apiPath) continue;
    let key = `${CATVOD_SITE_PREFIX}${rawKey}`;
    if (seen.has(key)) {
      let suffix = 2;
      while (seen.has(`${key}:${suffix}`)) suffix += 1;
      key = `${key}:${suffix}`;
    }
    seen.add(key);

    const name = text(item.name) || rawKey;
    const contentType = classifyCatVodSite(rawKey, name);
    const hiddenByDefault = !["vod", "discovery", "pan"].includes(contentType);
    sites.push({
      key,
      name,
      type: 15,
      api: toInternalApi(apiPath),
      runtimeGroup: CATVOD_RUNTIME_GROUP,
      contentType,
      originKey: rawKey,
      searchable: contentType === "pan" ? 0 : number(item.searchable, 1),
      quickSearch: contentType === "pan" ? 0 : number(item.quickSearch, 1),
      filterable: number(item.filterable, 1),
      indexs: number(item.indexs, 0),
      changeable: optionalNumber(item.changeable),
      hide: item.enable === false || number(item.hide, hiddenByDefault ? 1 : 0) === 1 ? 1 : 0,
    });
  }

  return {
    sites,
    summary: {
      siteCount: sites.length,
      discoveryCount: sites.filter((site) => site.contentType === "discovery").length,
      vodCount: sites.filter((site) => site.contentType === "vod").length,
      hiddenCount: sites.filter((site) => site.hide === 1).length,
    },
  };
}

export function classifyCatVodSite(key: string, name: string): CatVodContentType {
  const value = `${key} ${name}`.toLowerCase();
  if (/douban|豆瓣|首页推荐|影视推荐/.test(value)) return "discovery";
  if (/baseset|setting|config|gengxin|update|配置|设置|日期|版本/.test(value)) return "tool";
  if (/huya|douyu|bililive|live|直播/.test(value)) return "live";
  if (/manju|comic|manga|漫剧|漫画/.test(value)) return "comic";
  if (/music|audio|歌曲|音乐|戏曲|相声|评书|听书|广播|有声/.test(value)) return "audio";
  if (/duanju|hema|xingya|baiduduanju|短剧|星芽|好看/.test(value)) return "short-drama";
  if (/mypan|my_pan|我的网盘|网盘管理|panservice/.test(value)) return "pan";
  return "vod";
}

export function isCatVodSiteVisibleByDefault(site: SiteConfig): boolean {
  return site.hide !== 1 && ["vod", "discovery", "pan"].includes(site.contentType ?? "vod");
}

function toInternalApi(value: string): string {
  if (/^catvod:\/\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    return `catvod://service${url.pathname}${url.search}`;
  }
  return `catvod://service/${value.replace(/^\/+/, "")}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
