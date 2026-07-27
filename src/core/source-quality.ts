import { createHash } from "node:crypto";
import type { SiteConfig } from "./models.ts";

export type SourceQualityState = "unknown" | "checking" | "healthy" | "degraded" | "blocked";

export type SourceQualityStage = "static" | "home" | "search" | "detail" | "player" | "media" | "runtime";

export interface SourceQualityRecord {
  configSource: string;
  siteKey: string;
  fingerprint: string;
  state: SourceQualityState;
  stage: SourceQualityStage;
  reason: string;
  latencyMs: number;
  checkedAt: number;
  failureCount: number;
  successCount: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastSearchSuccessAt?: number;
  searchSuccessCount?: number;
  searchFailureCount?: number;
  lastMediaSuccessAt?: number;
  mediaSuccessCount?: number;
  mediaFailureCount?: number;
}

export interface SourceAuditStatus {
  running: boolean;
  total: number;
  completed: number;
  healthy: number;
  unknown: number;
  degraded: number;
  blocked: number;
  skipped: number;
  currentSiteKey?: string;
  currentSiteName?: string;
  startedAt?: number;
  finishedAt?: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function sourceFingerprint(site: SiteConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(site)))
    .digest("hex")
    .slice(0, 24);
}

export function qualityHidesSource(record: SourceQualityRecord | undefined): boolean {
  if (record?.state !== "blocked") return false;
  // 首页无推荐、搜索无结果、网络超时或规则运行时暂时失败，都不足以证明
  // 该来源完全不能播放。只有静态不兼容或实际详情/播放/媒体链路的确定性失败
  // 才从默认列表中隐藏，避免一次探测就误伤大量来源。
  return ["static", "detail", "player", "media"].includes(record.stage);
}

export function qualityRecordMatches(record: SourceQualityRecord | undefined, site: SiteConfig): boolean {
  return record !== undefined && record.fingerprint === sourceFingerprint(site);
}

export function isDefinitiveSourceFailure(message: string): boolean {
  return /(?:HTTP\s*(?:404|410|451)|媒体直链不可用|未返回有效播放地址|未返回影片详情|未返回可播放剧集|没有可播放剧集|无可播放剧集|格式不匹配|返回\s*HTML|HTML\s*页面|解析器.*未返回有效|依赖 Android|无法识别该 type|当前设备不支持|网页已加载，但未发现可播放|媒体内容验证失败|内容验证均未通过)/i.test(message);
}

export function classifyQualityFailure(message: string): "degraded" | "blocked" {
  return isDefinitiveSourceFailure(message) ? "blocked" : "degraded";
}

export function sourceQualityMetrics(
  current: SourceQualityRecord | undefined,
  stage: SourceQualityStage,
  outcome: "success" | "failure" | "preserve",
  now = Date.now(),
): Pick<SourceQualityRecord,
  | "lastSuccessAt"
  | "lastFailureAt"
  | "lastSearchSuccessAt"
  | "searchSuccessCount"
  | "searchFailureCount"
  | "lastMediaSuccessAt"
  | "mediaSuccessCount"
  | "mediaFailureCount"
> {
  const success = outcome === "success";
  const failure = outcome === "failure";
  return {
    lastSuccessAt: success ? now : (current?.lastSuccessAt ?? 0),
    lastFailureAt: failure ? now : (current?.lastFailureAt ?? 0),
    lastSearchSuccessAt: stage === "search" && success ? now : (current?.lastSearchSuccessAt ?? 0),
    searchSuccessCount: (current?.searchSuccessCount ?? 0) + (stage === "search" && success ? 1 : 0),
    searchFailureCount: (current?.searchFailureCount ?? 0) + (stage === "search" && failure ? 1 : 0),
    lastMediaSuccessAt: stage === "media" && success ? now : (current?.lastMediaSuccessAt ?? 0),
    mediaSuccessCount: (current?.mediaSuccessCount ?? 0) + (stage === "media" && success ? 1 : 0),
    mediaFailureCount: (current?.mediaFailureCount ?? 0) + (stage === "media" && failure ? 1 : 0),
  };
}
