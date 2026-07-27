export type SourceRankingIntent = "browse" | "search";

export interface RankableSourceQuality {
  state?: "unknown" | "checking" | "healthy" | "degraded" | "blocked";
  latencyMs?: number;
  checkedAt?: number;
  failureCount?: number;
  successCount?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastSearchSuccessAt?: number;
  searchSuccessCount?: number;
  searchFailureCount?: number;
  lastMediaSuccessAt?: number;
  mediaSuccessCount?: number;
  mediaFailureCount?: number;
}

export interface RankableSource {
  key: string;
  name?: string;
  quality?: RankableSourceQuality;
}

export interface SourceRankingContext {
  activeSiteKey?: string;
  favoriteSiteKeys?: readonly string[];
  recentSiteKeys?: readonly string[];
  now?: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function ratioScore(success: number, failure: number, maximum: number): number {
  const total = success + failure;
  if (total <= 0) return 0;
  const smoothed = (success + 1) / (total + 2);
  const confidence = Math.min(1, total / 6);
  return maximum * smoothed * confidence;
}

function recencyScore(timestamp: number, now: number, windowMs: number, maximum: number): number {
  if (!timestamp || timestamp > now + 60_000) return 0;
  const age = Math.max(0, now - timestamp);
  if (age >= windowMs) return 0;
  return maximum * (1 - age / windowMs);
}

function latencyScore(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 0;
  if (latencyMs <= 500) return 5_000;
  if (latencyMs <= 1_500) return 3_500;
  if (latencyMs <= 3_000) return 2_000;
  if (latencyMs <= 6_000) return 500;
  return -Math.min(3_000, (latencyMs - 6_000) / 2);
}

export function sourceRankingScore(
  source: RankableSource,
  context: SourceRankingContext = {},
  intent: SourceRankingIntent = "browse",
): number {
  const quality = source.quality;
  const now = context.now ?? Date.now();
  let score = 0;

  if (source.key === context.activeSiteKey) score += 100_000;
  const favoriteIndex = context.favoriteSiteKeys?.indexOf(source.key) ?? -1;
  if (favoriteIndex >= 0) score += Math.max(10_000, 40_000 - favoriteIndex * 1_600);
  const recentIndex = context.recentSiteKeys?.indexOf(source.key) ?? -1;
  if (recentIndex >= 0) score += Math.max(2_000, 16_000 - recentIndex * 1_600);

  const stateScore = {
    healthy: 12_000,
    unknown: 3_000,
    checking: 1_500,
    degraded: -4_000,
    blocked: -20_000,
  } as const;
  score += stateScore[quality?.state ?? "unknown"];
  score += latencyScore(Number(quality?.latencyMs ?? 0));

  const successCount = Number(quality?.successCount ?? 0);
  const failureCount = Number(quality?.failureCount ?? 0);
  const searchSuccessCount = Number(quality?.searchSuccessCount ?? 0);
  const searchFailureCount = Number(quality?.searchFailureCount ?? 0);
  const mediaSuccessCount = Number(quality?.mediaSuccessCount ?? 0);
  const mediaFailureCount = Number(quality?.mediaFailureCount ?? 0);

  score += ratioScore(successCount, failureCount, 2_500);
  score += ratioScore(searchSuccessCount, searchFailureCount, intent === "search" ? 9_000 : 2_500);
  score += ratioScore(mediaSuccessCount, mediaFailureCount, intent === "browse" ? 10_000 : 4_000);

  score += recencyScore(Number(quality?.lastSuccessAt ?? 0), now, 14 * DAY_MS, 4_000);
  score += recencyScore(Number(quality?.lastSearchSuccessAt ?? 0), now, 21 * DAY_MS, intent === "search" ? 10_000 : 2_000);
  score += recencyScore(Number(quality?.lastMediaSuccessAt ?? 0), now, 30 * DAY_MS, intent === "browse" ? 14_000 : 7_000);

  const lastFailureAt = Number(quality?.lastFailureAt ?? 0);
  const lastSuccessAt = Number(quality?.lastSuccessAt ?? 0);
  if (lastFailureAt > lastSuccessAt) {
    score -= recencyScore(lastFailureAt, now, 7 * DAY_MS, 6_000);
  }

  return Math.round(score);
}

export function compareSourcesByQuality<T extends RankableSource>(
  left: T,
  right: T,
  context: SourceRankingContext = {},
  intent: SourceRankingIntent = "browse",
): number {
  const scoreDifference = sourceRankingScore(right, context, intent) - sourceRankingScore(left, context, intent);
  if (scoreDifference !== 0) return scoreDifference;
  return String(left.name ?? left.key).localeCompare(String(right.name ?? right.key), "zh-CN");
}

export function sortSourcesByQuality<T extends RankableSource>(
  sources: readonly T[],
  context: SourceRankingContext = {},
  intent: SourceRankingIntent = "browse",
): T[] {
  return [...sources].sort((left, right) => compareSourcesByQuality(left, right, context, intent));
}

export function sourceQualityLabel(source: RankableSource, now = Date.now()): string {
  const quality = source.quality;
  if (!quality) return "待验证";
  if (quality.state === "checking") return "检测中";
  if (quality.state === "blocked") return "已屏蔽";
  if (Number(quality.lastMediaSuccessAt ?? 0) > now - 30 * DAY_MS) return "最近播放成功";
  const searchSuccess = Number(quality.searchSuccessCount ?? 0);
  const searchFailure = Number(quality.searchFailureCount ?? 0);
  if (searchSuccess >= 2 && searchSuccess / Math.max(1, searchSuccess + searchFailure) >= 0.75) return "搜索稳定";
  if (quality.state === "healthy") return "已验证可播";
  if (Number(quality.latencyMs ?? 0) > 0 && Number(quality.latencyMs ?? 0) <= 1_500) return "响应较快";
  if (quality.state === "degraded") return "偶有异常";
  return "待验证";
}
