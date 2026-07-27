import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateCompatibilityReports, formatCompatibilityBatch, type CompatibilityAuditFailure } from "../src/core/compatibility-batch-audit.ts";
import { auditVodConfig } from "../src/core/compatibility-audit.ts";
import { expandVodConfigs } from "../src/core/config-loader.ts";
import { loadProviderReplacements, ProviderReplacementRegistry } from "../src/core/provider-replacement-registry.ts";

interface ParsedArguments {
  sources: string[];
  lists: string[];
  json: boolean;
  output?: string;
  registry?: string;
  top: number;
  concurrency: number;
}

function parseArguments(values: string[]): ParsedArguments {
  const sources: string[] = [];
  const lists: string[] = [];
  let json = false;
  let output: string | undefined;
  let registry: string | undefined;
  let top = 30;
  let concurrency = 4;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--output") {
      output = values[++index];
      continue;
    }
    if (value === "--registry") {
      registry = values[++index];
      continue;
    }
    if (value === "--list") {
      const list = values[++index];
      if (list) lists.push(list);
      continue;
    }
    if (value === "--top") {
      top = Math.max(1, Number(values[++index]) || 30);
      continue;
    }
    if (value === "--concurrency") {
      concurrency = Math.min(12, Math.max(1, Number(values[++index]) || 4));
      continue;
    }
    sources.push(value);
  }
  return { sources, lists, json, top, concurrency, ...(output ? { output } : {}), ...(registry ? { registry } : {}) };
}

async function readText(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }
  const fileUrl = source.startsWith("file:") ? new URL(source) : pathToFileURL(source);
  return readFile(fileUrl, "utf8");
}

async function readSourceList(source: string): Promise<string[]> {
  const text = await readText(source);
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {}
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function mapConcurrent<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await worker(values[index]!);
    }
  });
  await Promise.all(runners);
  return output;
}

const args = parseArguments(process.argv.slice(2));
for (const listSource of args.lists) {
  try {
    args.sources.push(...await readSourceList(listSource));
  } catch (error) {
    console.error(`配置清单加载失败 ${listSource}：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
args.sources = [...new Set(args.sources.map((source) => source.trim()).filter(Boolean))];

if (args.sources.length === 0) {
  console.error("用法：npm run audit:config:batch -- <配置1> <配置2> [--list 清单文件] [--registry 注册表.json] [--top 30] [--json] [--output 报告文件]");
  process.exitCode = 1;
} else if (!process.exitCode) {
  let registry = new ProviderReplacementRegistry();
  if (args.registry) {
    try {
      registry = new ProviderReplacementRegistry(await loadProviderReplacements(args.registry));
    } catch (error) {
      console.error(`替代 Provider 注册表加载失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  if (!process.exitCode) {
    const results = await mapConcurrent(args.sources, args.concurrency, async (source) => {
      const expanded = await expandVodConfigs(source, { maxDepth: 2, maxConfigs: 100 });
      return {
        reports: expanded.configs.map((config) => auditVodConfig(config, registry)),
        failures: expanded.failures satisfies CompatibilityAuditFailure[],
      };
    });
    const reports = results.flatMap((result) => result.reports);
    const failures: CompatibilityAuditFailure[] = results.flatMap((result) => result.failures);
    const batch = aggregateCompatibilityReports(reports, failures);
    const output = args.json ? JSON.stringify(batch, null, 2) : formatCompatibilityBatch(batch, args.top);
    console.log(output);
    if (args.output) {
      const outputPath = resolve(args.output);
      await writeFile(outputPath, `${output}\n`, "utf8");
      console.error(`报告已写入：${outputPath}`);
    }
    if (failures.length > 0) process.exitCode = 2;
  }
}
