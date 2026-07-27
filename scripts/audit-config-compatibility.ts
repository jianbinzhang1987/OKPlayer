import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditVodConfig, formatCompatibilityAudit } from "../src/core/compatibility-audit.ts";
import { loadVodConfig } from "../src/core/config-loader.ts";
import { loadProviderReplacements, ProviderReplacementRegistry } from "../src/core/provider-replacement-registry.ts";

interface ParsedArguments {
  sources: string[];
  json: boolean;
  output?: string;
  registry?: string;
}

function parseArguments(values: string[]): ParsedArguments {
  const sources: string[] = [];
  let json = false;
  let output: string | undefined;
  let registry: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--output") {
      output = values[index + 1];
      index += 1;
      continue;
    }
    if (value === "--registry") {
      registry = values[index + 1];
      index += 1;
      continue;
    }
    sources.push(value);
  }
  return { sources, json, ...(output ? { output } : {}), ...(registry ? { registry } : {}) };
}

const args = parseArguments(process.argv.slice(2));
if (args.sources.length === 0) {
  console.error("用法：npm run audit:config -- <配置URL或文件> [更多配置] [--registry 注册表.json] [--json] [--output 报告文件]");
  process.exitCode = 1;
} else {
  let registry = new ProviderReplacementRegistry();
  if (args.registry) {
    try {
      registry = new ProviderReplacementRegistry(await loadProviderReplacements(args.registry));
    } catch (error) {
      console.error(`替代 Provider 注册表加载失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  const reports = [];
  if (!process.exitCode) {
    for (const source of args.sources) {
      try {
        reports.push(auditVodConfig(await loadVodConfig(source), registry));
      } catch (error) {
        console.error(`配置审计失败 ${source}：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  }

  if (reports.length > 0) {
    const output = args.json
      ? JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)
      : reports.map(formatCompatibilityAudit).join("\n\n========================================\n\n");
    console.log(output);
    if (args.output) {
      const outputPath = resolve(args.output);
      await writeFile(outputPath, `${output}\n`, "utf8");
      console.error(`报告已写入：${outputPath}`);
    }
  }
}
