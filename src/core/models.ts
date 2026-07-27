export type HeadersMap = Record<string, string>;

export interface SourceCategory {
  id: string;
  name: string;
}

export interface SourceFilterOption {
  label: string;
  value: string;
}

export interface SourceFilterGroup {
  key: string;
  name: string;
  options: SourceFilterOption[];
  defaultValue?: string;
}

export type ContentKind = "playable" | "discovery" | "folder" | "action" | "live";
export type SiteContentType = "vod" | "discovery" | "live" | "short-drama" | "comic" | "audio" | "pan" | "tool";

export interface SiteConfig {
  key: string;
  name: string;
  type: number;
  api: string;
  ext?: string;
  jar?: string;
  click?: string;
  playUrl?: string;
  hide?: number;
  timeout?: number;
  searchable?: number;
  filterable?: number;
  changeable?: number;
  quickSearch?: number;
  indexs?: number;
  categories?: SourceCategory[];
  runtimeGroup?: string;
  contentType?: SiteContentType;
  originKey?: string;
  header?: HeadersMap;
}

export interface ParseConfig {
  name: string;
  type: number;
  url: string;
  ext?: {
    flag?: string[];
    header?: HeadersMap;
  };
}

export interface VodConfig {
  sourceUrl: string;
  spider?: string;
  sites: SiteConfig[];
  parses: ParseConfig[];
  flags: string[];
  headers: unknown[];
  proxy: unknown[];
  rules: unknown[];
  hosts: string[];
  ads: string[];
}

export interface Episode {
  name: string;
  url: string;
  desc?: string;
  index: number;
}

export interface Flag {
  flag: string;
  show: string;
  episodes: Episode[];
}

export interface Vod {
  vodId: string;
  vodName: string;
  vodTag?: "file" | "folder" | "action" | string;
  contentKind?: ContentKind;
  actionType?: string;
  actionPayload?: unknown;
  typeName: string;
  vodPic: string;
  vodRemarks: string;
  vodYear: string;
  vodArea: string;
  vodDirector: string;
  vodActor: string;
  vodContent: string;
  vodPlayFrom: string;
  vodPlayUrl: string;
  flags: Flag[];
  siteKey?: string;
  siteName?: string;
  configName?: string;
}

export interface SourceResult {
  list: Vod[];
  categories?: SourceCategory[];
  filters?: Record<string, SourceFilterGroup[]>;
  page?: number;
  pageCount: number;
  total?: number;
  limit?: number;
  message: string;
}

export interface PlayerResult {
  key: string;
  flag: string;
  url: string;
  parse: number;
  playUrl: string;
  header: HeadersMap;
  format?: string;
  subtitleUrl?: string;
  danmakuUrl?: string;
  contentKind?: "vod" | "live";
}

export interface ResolvedMedia {
  url: string;
  headers: HeadersMap;
  format?: string;
  subtitleUrl?: string;
  danmakuUrl?: string;
  contentKind?: "vod" | "live";
  resolvedBy: "direct" | "prefix" | "json-api" | "browser-sniffer";
}
