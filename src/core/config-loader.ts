import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseLooseData } from "./drpy-operation-runtime.ts";
import type { ParseConfig, SiteConfig, VodConfig } from "./models.ts";

export interface ConfigWarehouseEntry {
  name: string;
  url: string;
}

export interface ConfigWarehouse {
  sourceUrl: string;
  entries: ConfigWarehouseEntry[];
}

export type LoadedConfigDocument =
  | { kind: "config"; config: VodConfig }
  | { kind: "warehouse"; warehouse: ConfigWarehouse };

export interface ExpandedVodConfigEntry {
  name: string;
  source: string;
  config: VodConfig;
}

export interface ExpandedVodConfigs {
  configs: VodConfig[];
  entries: ExpandedVodConfigEntry[];
  warehouses: ConfigWarehouse[];
  failures: Array<{ source: string; message: string }>;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveResource(value: unknown, baseUrl: URL): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^csp_/i.test(trimmed) || trimmed.startsWith("data:")) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

function stripJsonComments(source: string): string {
  let output = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        output += char;
      } else {
        output += " ";
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }

    if (quote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
      continue;
    }
    output += char;
  }
  return output;
}

export function parseConfigText(text: string): Record<string, unknown> {
  const source = text.replace(/^\uFEFF/, "");
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}

  const cleaned = stripJsonComments(source);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}

  try {
    const parsed = parseLooseData(cleaned);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error("配置根节点不是对象");
  } catch (error) {
    throw new Error(`配置不是有效 JSON/JSON5：${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeSite(input: unknown, baseUrl: URL, globalSpider?: string): SiteConfig | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.key !== "string" || typeof raw.name !== "string") return null;
  const type = typeof raw.type === "number" ? raw.type : Number(raw.type ?? 0) || 0;
  const apiValue = typeof raw.api === "string" ? raw.api : "";
  const api = type === 3 && /^csp_/i.test(apiValue) ? apiValue : resolveResource(apiValue, baseUrl) ?? apiValue;
  const site: SiteConfig = {
    key: raw.key,
    name: raw.name,
    type,
    api,
  };

  const ext = typeof raw.ext === "object" && raw.ext !== null
    ? JSON.stringify(raw.ext)
    : resolveResource(raw.ext, baseUrl);
  const jar = resolveResource(raw.jar, baseUrl) ?? globalSpider;
  if (ext !== undefined) site.ext = ext;
  if (jar !== undefined) site.jar = jar;
  if (typeof raw.click === "string") site.click = raw.click;
  if (typeof raw.playUrl === "string") site.playUrl = raw.playUrl;
  if (typeof raw.hide === "number") site.hide = raw.hide;
  if (typeof raw.timeout === "number") site.timeout = raw.timeout;
  if (typeof raw.searchable === "number") site.searchable = raw.searchable;
  if (typeof raw.filterable === "number") site.filterable = raw.filterable;
  if (typeof raw.changeable === "number") site.changeable = raw.changeable;
  if (typeof raw.quickSearch === "number") site.quickSearch = raw.quickSearch;
  if (typeof raw.indexs === "number") site.indexs = raw.indexs;
  if (Array.isArray(raw.categories)) {
    site.categories = raw.categories.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [{ id: item.trim(), name: item.trim() }];
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const category = item as Record<string, unknown>;
      const id = String(category.id ?? category.type_id ?? category.value ?? "").trim();
      const name = String(category.name ?? category.type_name ?? category.label ?? id).trim();
      return id && name ? [{ id, name }] : [];
    });
  }
  if (typeof raw.runtimeGroup === "string") site.runtimeGroup = raw.runtimeGroup;
  if (["vod", "discovery", "live", "short-drama", "comic", "pan", "tool"].includes(String(raw.contentType))) {
    site.contentType = raw.contentType as SiteConfig["contentType"];
  }
  if (typeof raw.originKey === "string") site.originKey = raw.originKey;
  if (typeof raw.header === "object" && raw.header !== null) {
    site.header = Object.fromEntries(
      Object.entries(raw.header).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  return site;
}

function normalizeParse(input: unknown, baseUrl: URL): ParseConfig | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.name !== "string" || typeof raw.url !== "string") return null;
  return {
    name: raw.name,
    type: typeof raw.type === "number" ? raw.type : Number(raw.type ?? 0) || 0,
    url: resolveResource(raw.url, baseUrl) ?? raw.url,
    ...(typeof raw.ext === "object" && raw.ext !== null ? { ext: raw.ext as ParseConfig["ext"] } : {}),
  };
}

function normalizeWarehouse(raw: Record<string, unknown>, baseUrl: URL, sourceUrl: string): ConfigWarehouse | undefined {
  if (!Array.isArray(raw.urls)) return undefined;
  const entries = raw.urls.map((item): ConfigWarehouseEntry | undefined => {
    if (typeof item !== "object" || item === null) return undefined;
    const entry = item as Record<string, unknown>;
    const url = resolveResource(entry.url, baseUrl);
    if (!url) return undefined;
    return {
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : url,
      url,
    };
  }).filter((item): item is ConfigWarehouseEntry => item !== undefined);
  return entries.length > 0 ? { sourceUrl, entries } : undefined;
}

export type ConfigFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let configFetch: ConfigFetch = (input, init) => fetch(input, init);

export function setConfigFetch(fetcher?: ConfigFetch): void {
  configFetch = fetcher ?? ((input, init) => fetch(input, init));
}

async function readHttpText(source: string): Promise<{ text: string; sourceUrl: string }> {
  try {
    const response = await configFetch(source, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`配置下载失败：HTTP ${response.status}`);
    return { text: await response.text(), sourceUrl: response.url || source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`配置下载失败：${message}`);
  }
}

async function readText(source: string): Promise<{ text: string; sourceUrl: string }> {
  if (isHttpUrl(source)) return readHttpText(source);

  const fileUrl = source.startsWith("file:") ? new URL(source) : pathToFileURL(source);
  return { text: await readFile(fileUrl, "utf8"), sourceUrl: fileUrl.toString() };
}

function normalizeVodConfig(raw: Record<string, unknown>, sourceUrl: string): VodConfig {
  if (typeof raw.msg === "string" && raw.msg !== "") throw new Error(raw.msg);
  const baseUrl = new URL(sourceUrl);
  const spider = resolveResource(raw.spider, baseUrl);
  const sites = (Array.isArray(raw.sites) ? raw.sites : [])
    .map((item) => normalizeSite(item, baseUrl, spider))
    .filter((item): item is SiteConfig => item !== null);
  if (sites.length === 0) throw new Error("配置中没有可用的 sites");

  return {
    sourceUrl,
    ...(spider !== undefined ? { spider } : {}),
    sites,
    parses: (Array.isArray(raw.parses) ? raw.parses : [])
      .map((item) => normalizeParse(item, baseUrl))
      .filter((item): item is ParseConfig => item !== null),
    flags: Array.isArray(raw.flags) ? raw.flags.filter((item): item is string => typeof item === "string") : [],
    headers: Array.isArray(raw.headers) ? raw.headers : [],
    proxy: Array.isArray(raw.proxy) ? raw.proxy : [],
    rules: Array.isArray(raw.rules) ? raw.rules : [],
    hosts: Array.isArray(raw.hosts) ? raw.hosts.filter((item): item is string => typeof item === "string") : [],
    ads: Array.isArray(raw.ads) ? raw.ads.filter((item): item is string => typeof item === "string") : [],
  };
}

export function parseVodConfigText(text: string, sourceUrl: string): VodConfig {
  return normalizeVodConfig(parseConfigText(text), sourceUrl);
}

export async function loadConfigDocument(source: string): Promise<LoadedConfigDocument> {
  const { text, sourceUrl } = await readText(source);
  const raw = parseConfigText(text);
  const warehouse = normalizeWarehouse(raw, new URL(sourceUrl), sourceUrl);
  if (warehouse && !Array.isArray(raw.sites)) return { kind: "warehouse", warehouse };
  return { kind: "config", config: normalizeVodConfig(raw, sourceUrl) };
}

export async function loadVodConfig(source: string): Promise<VodConfig> {
  const document = await loadConfigDocument(source);
  if (document.kind === "warehouse") {
    throw new Error(`该地址是影视仓多仓索引，包含 ${document.warehouse.entries.length} 条下级配置，请先选择具体线路`);
  }
  return document.config;
}

export async function expandVodConfigs(
  source: string,
  options: { maxDepth?: number; maxConfigs?: number; concurrency?: number } = {},
): Promise<ExpandedVodConfigs> {
  const maxDepth = Math.max(0, options.maxDepth ?? 2);
  const maxConfigs = Math.max(1, options.maxConfigs ?? 100);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 12));
  const configs: VodConfig[] = [];
  const entries: ExpandedVodConfigEntry[] = [];
  const warehouses: ConfigWarehouse[] = [];
  const failures: Array<{ source: string; message: string }> = [];
  const visited = new Set<string>();
  const queue: Array<{ source: string; depth: number; name?: string }> = [{ source, depth: 0 }];

  while (queue.length > 0 && configs.length < maxConfigs) {
    const pending: Array<{ source: string; depth: number; name?: string }> = [];
    while (pending.length < concurrency && queue.length > 0) {
      const candidate = queue.shift()!;
      if (visited.has(candidate.source)) continue;
      visited.add(candidate.source);
      pending.push(candidate);
    }
    if (pending.length === 0) continue;

    const results = await Promise.all(pending.map(async (candidate) => {
      try {
        return { candidate, document: await loadConfigDocument(candidate.source) } as const;
      } catch (error) {
        return {
          candidate,
          error: error instanceof Error ? error.message : String(error),
        } as const;
      }
    }));

    for (const result of results) {
      if ("error" in result) {
        failures.push({ source: result.candidate.source, message: result.error ?? "配置加载失败" });
        continue;
      }
      if (result.document.kind === "config") {
        if (configs.length >= maxConfigs) break;
        configs.push(result.document.config);
        entries.push({
          name: result.candidate.name?.trim() || defaultConfigName(result.candidate.source),
          source: result.candidate.source,
          config: result.document.config,
        });
        continue;
      }

      warehouses.push(result.document.warehouse);
      if (result.candidate.depth >= maxDepth) {
        failures.push({ source: result.candidate.source, message: `多仓索引超过最大展开深度 ${maxDepth}` });
        continue;
      }
      for (const entry of result.document.warehouse.entries) {
        if (!visited.has(entry.url)) queue.push({ source: entry.url, depth: result.candidate.depth + 1, name: entry.name });
      }
    }
  }

  return { configs, entries, warehouses, failures };
}

function defaultConfigName(source: string): string {
  try {
    const url = new URL(source);
    const name = url.pathname.split("/").filter(Boolean).pop();
    return name || url.hostname || "默认配置";
  } catch {
    const normalized = source.replace(/\\/g, "/");
    return normalized.split("/").filter(Boolean).pop() || "默认配置";
  }
}
