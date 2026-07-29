import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppService } from "../src/core/app-service.ts";
import { parseCatVodConfig } from "../src/core/catvod/catvod-config-parser.ts";
import { CatVodNodeClient } from "../src/core/catvod/catvod-node-client.ts";
import { SourceAdapterFactory } from "../src/core/source-adapter-factory.ts";

interface ConfigRecordRow {
  id: number;
  name: string;
  url: string;
  enabled: number;
  updated_at: number;
}

interface Args {
  dbPath: string;
  output: string;
  maxConfigs: number;
  maxMsPerConfig: number;
  includeDisabled: boolean;
  catVodBaseUrl: string;
}

function parseArgs(values: string[]): Args {
  const args: Args = {
    dbPath: path.join(os.homedir(), "Library/Application Support/FongMi Desktop/fongmi-desktop.sqlite"),
    output: path.join(process.cwd(), "artifacts/current-profile-source-e2e.json"),
    maxConfigs: Number.POSITIVE_INFINITY,
    maxMsPerConfig: 120_000,
    includeDisabled: true,
    catVodBaseUrl: process.env.FONGMI_CATVOD_BASE_URL?.trim() ?? "",
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (value === "--db") args.dbPath = values[++index] ?? args.dbPath;
    else if (value === "--output") args.output = values[++index] ?? args.output;
    else if (value === "--max-configs") args.maxConfigs = Math.max(1, Number(values[++index]) || 1);
    else if (value === "--max-ms-per-config") args.maxMsPerConfig = Math.max(10_000, Number(values[++index]) || args.maxMsPerConfig);
    else if (value === "--active-only") args.includeDisabled = false;
    else if (value === "--catvod-base-url") args.catVodBaseUrl = values[++index]?.trim() ?? "";
  }
  return args;
}

function safeSourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = parsed.search ? "?…" : "";
    return parsed.toString();
  } catch {
    return url.replace(/([^:@/\s]+):([^:@/\s]+)@/g, "***:***@");
  }
}

function readConfigs(dbPath: string, includeDisabled: boolean): ConfigRecordRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sql = includeDisabled
      ? "SELECT id,name,url,enabled,updated_at FROM configs ORDER BY enabled DESC, updated_at DESC"
      : "SELECT id,name,url,enabled,updated_at FROM configs WHERE enabled=1 ORDER BY updated_at DESC";
    return db.prepare(sql).all() as unknown as ConfigRecordRow[];
  } finally {
    db.close();
  }
}

function readStringSetting(dbPath: string, key: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined;
    if (!row?.value) return "";
    const parsed = JSON.parse(row.value) as unknown;
    return typeof parsed === "string" ? parsed.trim() : "";
  } catch {
    return "";
  } finally {
    db.close();
  }
}

async function waitForAudit(service: AppService, maxMs: number): Promise<{ timedOut: boolean; status: ReturnType<AppService["getSourceAuditStatus"]> }> {
  const startedAt = Date.now();
  let status = service.getSourceAuditStatus();
  while (status.running && Date.now() - startedAt < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    status = service.getSourceAuditStatus();
    console.log(`  进度 ${status.completed}/${status.total}${status.currentSiteName ? ` · ${status.currentSiteName}` : ""}`);
  }
  if (!status.running) return { timedOut: false, status };
  service.cancelSourceAudit();
  return { timedOut: true, status: service.getSourceAuditStatus() };
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

const args = parseArgs(process.argv.slice(2));
await mkdir(path.dirname(args.output), { recursive: true });

const configs = readConfigs(args.dbPath, args.includeDisabled).slice(0, Number.isFinite(args.maxConfigs) ? args.maxConfigs : undefined);
const replacementRegistrySource = readStringSetting(args.dbPath, "providerRegistrySource");
const report = {
  generatedAt: new Date().toISOString(),
  database: args.dbPath,
  configCount: configs.length,
  replacementRegistrySource: replacementRegistrySource ? safeSourceLabel(replacementRegistrySource) : "",
  catVodBaseUrl: args.catVodBaseUrl ? safeSourceLabel(args.catVodBaseUrl) : "",
  results: [] as any[],
};

for (const config of configs) {
  console.log(`\n[配置] ${config.enabled ? "当前" : "历史"} · ${config.name} · ${safeSourceLabel(config.url)}`);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fongmi-current-source-e2e-"));
  const catVodClient = args.catVodBaseUrl
    ? new CatVodNodeClient({ baseUrl: () => args.catVodBaseUrl })
    : undefined;
  const service = new AppService(
    path.join(tempDir, "audit.sqlite"),
    catVodClient ? new SourceAdapterFactory({ catVodClient }) : new SourceAdapterFactory(),
  );
  try {
    if (replacementRegistrySource) {
      await service.loadReplacementRegistry(replacementRegistrySource);
      console.log(`  已加载替代 Provider 注册表：${safeSourceLabel(replacementRegistrySource)}`);
    }
    const loadedConfig = await service.loadConfig(config.url, config.name);
    if (catVodClient) {
      const parsedCatVod = parseCatVodConfig(await catVodClient.config());
      await service.setDynamicSites(parsedCatVod.sites);
      console.log(`  已载入 CatVod 桌面来源 ${parsedCatVod.sites.length} 个，其中网盘入口 ${parsedCatVod.sites.filter((site) => site.contentType === "pan").length} 个`);
    }
    const sites = service.listSites();
    const supportedSiteCount = sites.filter((site) => site.supported).length;
    const ignoredSiteCount = sites.length - supportedSiteCount;
    console.log(`  配置站点 ${sites.length} 个，其中桌面端检测 ${supportedSiteCount} 个，忽略 Android/未知运行时 ${ignoredSiteCount} 个`);
    service.startSourceAudit(true);
    const { timedOut, status } = await waitForAudit(service, args.maxMsPerConfig);
    const quality = service.storage.listSourceQuality(loadedConfig.sourceUrl);
    const dynamicQuality = service.storage.listSourceQuality("catvod://runtime/config");
    const qualityByKey = new Map(quality.map((item) => [item.siteKey, item] as const));
    const dynamicQualityByKey = new Map(dynamicQuality.map((item) => [item.siteKey, item] as const));
    const entries = sites.map((site) => {
      const item = site.key.startsWith("catvod:") ? dynamicQualityByKey.get(site.key) : qualityByKey.get(site.key);
      return {
        key: site.key,
        name: site.name,
        type: site.type,
        runtime: site.runtime,
        supported: site.supported,
        state: site.supported ? (item?.state ?? "not_checked") : "ignored",
        stage: site.supported ? (item?.stage ?? "unknown") : "static",
        reason: site.supported
          ? (item?.reason ?? "未完成检测")
          : `已忽略：${site.reason ?? "当前桌面版本不支持该运行时"}`,
        latencyMs: item?.latencyMs ?? 0,
      };
    });
    const stateCounts = countBy(entries.map((item) => item.state));
    const stageCounts = countBy(entries.map((item) => item.stage));
    const issues = entries
      .filter((item) => item.state !== "healthy" && item.state !== "ignored")
      .sort((a, b) => {
        const severity = { blocked: 0, degraded: 1, unknown: 2, not_checked: 3, checking: 4, ignored: 5, healthy: 6 } as Record<string, number>;
        return (severity[a.state] ?? 9) - (severity[b.state] ?? 9) || b.latencyMs - a.latencyMs;
      });
    console.log(`  完成：healthy=${stateCounts.healthy ?? 0} degraded=${stateCounts.degraded ?? 0} unknown=${stateCounts.unknown ?? 0} blocked=${stateCounts.blocked ?? 0} ignored=${stateCounts.ignored ?? 0} not_checked=${stateCounts.not_checked ?? 0}${timedOut ? " · 超时截断" : ""}`);
    for (const issue of issues.slice(0, 8)) {
      console.log(`   - [${issue.state}/${issue.stage}] ${issue.name}: ${issue.reason}`);
    }
    report.results.push({
      config: {
        id: config.id,
        name: config.name,
        enabled: Boolean(config.enabled),
        url: safeSourceLabel(config.url),
        loadedSourceUrl: safeSourceLabel(loadedConfig.sourceUrl),
      },
      timedOut,
      status,
      siteCount: sites.length,
      stateCounts,
      stageCounts,
      issues,
      entries,
    });
  } catch (error) {
    console.log(`  配置加载失败：${error instanceof Error ? error.message : String(error)}`);
    report.results.push({
      config: {
        id: config.id,
        name: config.name,
        enabled: Boolean(config.enabled),
        url: safeSourceLabel(config.url),
      },
      loadError: error instanceof Error ? error.message : String(error),
    });
  } finally {
    service.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n报告已写入：${args.output}`);
