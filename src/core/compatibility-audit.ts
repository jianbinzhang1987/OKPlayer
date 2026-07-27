import type { VodConfig } from "./models.ts";
import {
  ProviderReplacementRegistry,
  type ProviderReplacementInfo,
} from "./provider-replacement-registry.ts";
import { getSiteCapability, type SourceRuntime } from "./source-capability.ts";

export interface CompatibilityAuditEntry {
  key: string;
  name: string;
  type: number;
  api: string;
  runtime: SourceRuntime;
  supported: boolean;
  reason?: string;
  replacement?: ProviderReplacementInfo;
}

export interface CompatibilityAuditReport {
  sourceUrl: string;
  total: number;
  supported: number;
  unsupported: number;
  supportRate: number;
  runtimeDistribution: Record<SourceRuntime, number>;
  androidOnly: CompatibilityAuditEntry[];
  replaced: CompatibilityAuditEntry[];
  entries: CompatibilityAuditEntry[];
}

export const SOURCE_RUNTIMES: SourceRuntime[] = [
  "http",
  "javascript",
  "drpy",
  "t4",
  "appysv2",
  "xbpq",
  "xyq",
  "catopen",
  "alist",
  "android-dex",
  "unknown",
];

export function auditVodConfig(
  config: VodConfig,
  registry: ProviderReplacementRegistry = new ProviderReplacementRegistry(),
): CompatibilityAuditReport {
  const entries = config.sites.map<CompatibilityAuditEntry>((site) => {
    const replacement = registry.resolve(site);
    const capability = replacement?.capability ?? getSiteCapability(site);
    return {
      key: site.key,
      name: site.name,
      type: site.type,
      api: site.api,
      runtime: capability.runtime,
      supported: capability.supported,
      ...(capability.reason ? { reason: capability.reason } : {}),
      ...(replacement ? { replacement: replacement.info } : {}),
    };
  });
  const runtimeDistribution = Object.fromEntries(SOURCE_RUNTIMES.map((runtime) => [runtime, 0])) as Record<SourceRuntime, number>;
  for (const entry of entries) runtimeDistribution[entry.runtime] += 1;
  const supported = entries.filter((entry) => entry.supported).length;
  const total = entries.length;
  return {
    sourceUrl: config.sourceUrl,
    total,
    supported,
    unsupported: total - supported,
    supportRate: total === 0 ? 0 : Number(((supported / total) * 100).toFixed(2)),
    runtimeDistribution,
    androidOnly: entries.filter((entry) => entry.runtime === "android-dex"),
    replaced: entries.filter((entry) => entry.replacement !== undefined),
    entries,
  };
}

export function formatCompatibilityAudit(report: CompatibilityAuditReport): string {
  const runtimeRows = Object.entries(report.runtimeDistribution)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([runtime, count]) => `  ${runtime.padEnd(13)} ${String(count).padStart(4)}`)
    .join("\n");
  const replacementRows = report.replaced.length === 0
    ? "  无"
    : report.replaced.map((entry) => `  - ${entry.name}：${entry.api} → ${entry.runtime}（${entry.replacement!.sourceName}）`).join("\n");
  const androidRows = report.androidOnly.length === 0
    ? "  无"
    : report.androidOnly.map((entry) => `  - ${entry.name} (${entry.api})`).join("\n");
  const unsupportedRows = report.entries
    .filter((entry) => !entry.supported && entry.runtime !== "android-dex")
    .map((entry) => `  - ${entry.name}：${entry.reason ?? entry.runtime}`)
    .join("\n") || "  无";

  return [
    `配置：${report.sourceUrl}`,
    `站点：${report.total}，可用：${report.supported}，不可用：${report.unsupported}，兼容率：${report.supportRate}%`,
    "",
    "运行时分布：",
    runtimeRows || "  无",
    "",
    `替代 Provider（${report.replaced.length}）：`,
    replacementRows,
    "",
    `Android-only（${report.androidOnly.length}）：`,
    androidRows,
    "",
    "其他不可用：",
    unsupportedRows,
  ].join("\n");
}
