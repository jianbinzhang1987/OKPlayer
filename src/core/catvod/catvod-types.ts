export const DEFAULT_CATVOD_MD5_URL = "https://9280.kstore.vip/cat/index.js.md5";
export const CATVOD_RUNTIME_GROUP = "catvod-default";
export const CATVOD_SITE_PREFIX = "catvod:";

export type CatVodContentType =
  | "vod"
  | "discovery"
  | "live"
  | "short-drama"
  | "comic"
  | "audio"
  | "pan"
  | "tool";

export interface CatVodBundleVersion {
  md5: string;
  sha256: string;
  scriptUrl: string;
  downloadedAt: number;
  activatedAt?: number;
}

export interface CatVodBundleManifest {
  sourceMd5Url: string;
  current?: CatVodBundleVersion;
  previous?: CatVodBundleVersion;
  candidate?: CatVodBundleVersion;
  updatedAt: number;
}

export interface CatVodRemoteBundle {
  sourceMd5Url: string;
  scriptUrl: string;
  md5: string;
}

export interface CatVodUpdateResult {
  state: "current" | "available" | "downloaded" | "activated" | "rolled-back";
  current?: CatVodBundleVersion;
  candidate?: CatVodBundleVersion;
  previous?: CatVodBundleVersion;
  message: string;
}

export type CatVodRemoteAccessPolicy = "allow" | "block-startup";

export interface CatVodRemoteAccessRecord {
  origin: string;
  method: string;
  phase: "startup";
  blocked: boolean;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface CatVodServiceStatus {
  state: "stopped" | "starting" | "running" | "error";
  sourceMd5Url: string;
  port?: number;
  baseUrl?: string;
  versionMd5?: string;
  startedAt?: number;
  siteCount?: number;
  message?: string;
  candidateMd5?: string;
  previousMd5?: string;
  remoteAccessPolicy?: CatVodRemoteAccessPolicy;
  remoteAccesses?: CatVodRemoteAccessRecord[];
}

export interface CatVodServiceConfigSummary {
  siteCount: number;
  discoveryCount: number;
  vodCount: number;
  hiddenCount: number;
}
