import {
  SOURCE_RUNTIMES,
  type CompatibilityAuditReport,
} from "./compatibility-audit.ts";
import type { SourceRuntime } from "./source-capability.ts";

export interface CompatibilityAuditFailure {
  source: string;
  message: string;
}

export interface AndroidApiRankingEntry {
  api: string;
  occurrences: number;
  configCount: number;
  siteNames: string[];
  sourceUrls: string[];
}

export interface CompatibilityBatchReport {
  totalConfigs: number;
  succeededConfigs: number;
  failedConfigs: number;
  totalSites: number;
  supportedSites: number;
  unsupportedSites: number;
  supportRate: number;
  replacementCount: number;
  runtimeDistribution: Record<SourceRuntime, number>;
  androidApiRanking: AndroidApiRankingEntry[];
  failures: CompatibilityAuditFailure[];
  reports: CompatibilityAuditReport[];
}

export function aggregateCompatibilityReports(
  reports: CompatibilityAuditReport[],
  failures: CompatibilityAuditFailure[] = [],
): CompatibilityBatchReport {
  const runtimeDistribution = Object.fromEntries(SOURCE_RUNTIMES.map((runtime) => [runtime, 0])) as Record<SourceRuntime, number>;
  const ranking = new Map<string, {
    api: string;
    occurrences: number;
    names: Set<string>;
    sources: Set<string>;
  }>();

  let totalSites = 0;
  let supportedSites = 0;
  let replacementCount = 0;
  for (const report of reports) {
    totalSites += report.total;
    supportedSites += report.supported;
    replacementCount += report.replaced.length;
    for (const runtime of SOURCE_RUNTIMES) runtimeDistribution[runtime] += report.runtimeDistribution[runtime];
    for (const entry of report.androidOnly) {
      const key = entry.api.trim().toLowerCase();
      const current = ranking.get(key) ?? {
        api: entry.api,
        occurrences: 0,
        names: new Set<string>(),
        sources: new Set<string>(),
      };
      current.occurrences += 1;
      current.names.add(entry.name);
      current.sources.add(report.sourceUrl);
      ranking.set(key, current);
    }
  }

  const androidApiRanking = [...ranking.values()]
    .map<AndroidApiRankingEntry>((entry) => ({
      api: entry.api,
      occurrences: entry.occurrences,
      configCount: entry.sources.size,
      siteNames: [...entry.names].sort((left, right) => left.localeCompare(right, "zh-CN")),
      sourceUrls: [...entry.sources].sort(),
    }))
    .sort((left, right) => right.occurrences - left.occurrences || right.configCount - left.configCount || left.api.localeCompare(right.api));

  return {
    totalConfigs: reports.length + failures.length,
    succeededConfigs: reports.length,
    failedConfigs: failures.length,
    totalSites,
    supportedSites,
    unsupportedSites: totalSites - supportedSites,
    supportRate: totalSites === 0 ? 0 : Number(((supportedSites / totalSites) * 100).toFixed(2)),
    replacementCount,
    runtimeDistribution,
    androidApiRanking,
    failures,
    reports,
  };
}

export function formatCompatibilityBatch(report: CompatibilityBatchReport, top = 30): string {
  const runtimeRows = Object.entries(report.runtimeDistribution)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([runtime, count]) => `  ${runtime.padEnd(13)} ${String(count).padStart(5)}`)
    .join("\n") || "  无";
  const rankingRows = report.androidApiRanking.length === 0
    ? "  无"
    : report.androidApiRanking.slice(0, Math.max(1, top)).map((entry, index) =>
      `  ${String(index + 1).padStart(2)}. ${entry.api}：${entry.occurrences} 次 / ${entry.configCount} 份配置 · ${entry.siteNames.slice(0, 4).join("、")}`,
    ).join("\n");
  const failureRows = report.failures.length === 0
    ? "  无"
    : report.failures.map((failure) => `  - ${failure.source}：${failure.message}`).join("\n");

  return [
    `配置：${report.totalConfigs}，成功：${report.succeededConfigs}，失败：${report.failedConfigs}`,
    `站点：${report.totalSites}，可用：${report.supportedSites}，不可用：${report.unsupportedSites}，兼容率：${report.supportRate}%`,
    `已应用替代 Provider：${report.replacementCount}`,
    "",
    "运行时分布：",
    runtimeRows,
    "",
    `Android-only API 排名（前 ${Math.min(top, report.androidApiRanking.length)}）：`,
    rankingRows,
    "",
    "配置加载失败：",
    failureRows,
  ].join("\n");
}
