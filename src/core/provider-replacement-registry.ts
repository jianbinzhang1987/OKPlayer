import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SiteConfig } from "./models.ts";
import { getSiteCapability, type SourceCapability, type SourceRuntime } from "./source-capability.ts";
import type { SourceCapabilities } from "./source-adapter.ts";

export type ReplacementRuntime = Exclude<SourceRuntime, "android-dex" | "unknown" | "catvod-node">;

export interface ProviderReplacement {
  id: string;
  enabled?: boolean;
  match: {
    api: string;
    jarHash?: string;
  };
  replacement: {
    runtime: ReplacementRuntime;
    api?: string;
    ext?: string;
    type?: number;
    header?: Record<string, string>;
  };
  capabilities?: Partial<SourceCapabilities>;
  source: {
    name: string;
    repository?: string;
    license?: string;
    verifiedAt?: string;
  };
  notes?: string;
}

export interface ProviderReplacementInfo {
  id: string;
  originalApi: string;
  runtime: ReplacementRuntime;
  sourceName: string;
  repository?: string;
  license?: string;
  verifiedAt?: string;
  notes?: string;
}

export interface ProviderReplacementResolution {
  entry: ProviderReplacement;
  originalSite: SiteConfig;
  effectiveSite: SiteConfig;
  capability: SourceCapability;
  info: ProviderReplacementInfo;
}

const RUNTIME_DEFAULTS: Record<ReplacementRuntime, { type: number; api: string }> = {
  http: { type: 1, api: "" },
  javascript: { type: 3, api: "" },
  drpy: { type: 3, api: "csp_Drpy" },
  t4: { type: 4, api: "" },
  appysv2: { type: 11, api: "csp_AppYsV2" },
  xbpq: { type: 9, api: "csp_XBPQ" },
  xyq: { type: 10, api: "csp_XYQHiker" },
  catopen: { type: 14, api: "csp_CatOpen" },
  alist: { type: 13, api: "csp_Alist" },
};

function normalizeApi(value: string): string {
  return value.trim().toLowerCase();
}

function configuredJarHash(site: SiteConfig): string {
  const jar = site.jar?.trim() ?? "";
  const marker = ";md5;";
  const index = jar.toLowerCase().indexOf(marker);
  if (index < 0) return "";
  return jar.slice(index + marker.length).split(";")[0]?.trim().toLowerCase() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReplacement(value: unknown, index: number): ProviderReplacement {
  if (!isRecord(value)) throw new Error(`替代 Provider 第 ${index + 1} 项不是对象`);
  if (typeof value.id !== "string" || !value.id.trim()) throw new Error(`替代 Provider 第 ${index + 1} 项缺少 id`);
  if (!isRecord(value.match) || typeof value.match.api !== "string" || !value.match.api.trim()) {
    throw new Error(`替代 Provider ${value.id} 缺少 match.api`);
  }
  if (!isRecord(value.replacement) || typeof value.replacement.runtime !== "string") {
    throw new Error(`替代 Provider ${value.id} 缺少 replacement.runtime`);
  }
  const runtime = value.replacement.runtime as ReplacementRuntime;
  if (!Object.hasOwn(RUNTIME_DEFAULTS, runtime)) throw new Error(`替代 Provider ${value.id} 使用了不支持的 runtime：${runtime}`);
  if (!isRecord(value.source) || typeof value.source.name !== "string" || !value.source.name.trim()) {
    throw new Error(`替代 Provider ${value.id} 缺少 source.name`);
  }
  return value as unknown as ProviderReplacement;
}

function parseRegistryPayload(payload: unknown): ProviderReplacement[] {
  const rawEntries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.replacements)
      ? payload.replacements
      : undefined;
  if (!rawEntries) throw new Error("替代 Provider 注册表必须是数组或包含 replacements 数组的对象");
  const entries = rawEntries.map(validateReplacement);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`替代 Provider id 重复：${entry.id}`);
    ids.add(entry.id);
  }
  return entries;
}

async function readRegistryText(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`替代 Provider 注册表下载失败：HTTP ${response.status}`);
    return response.text();
  }
  const fileUrl = source.startsWith("file:") ? new URL(source) : pathToFileURL(source);
  return readFile(fileUrl, "utf8");
}

export async function loadProviderReplacements(source: string): Promise<ProviderReplacement[]> {
  const text = await readRegistryText(source);
  try {
    return parseRegistryPayload(JSON.parse(text));
  } catch (error) {
    throw new Error(`替代 Provider 注册表不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export const DEFAULT_PROVIDER_REPLACEMENTS: ProviderReplacement[] = [];

export class ProviderReplacementRegistry {
  private readonly entries: ProviderReplacement[];

  constructor(entries: ProviderReplacement[] = DEFAULT_PROVIDER_REPLACEMENTS) {
    this.entries = parseRegistryPayload(entries);
  }

  list(): ProviderReplacement[] {
    return this.entries.map((entry) => structuredClone(entry));
  }

  match(site: SiteConfig): ProviderReplacement | undefined {
    const api = normalizeApi(site.api);
    const jarHash = configuredJarHash(site);
    return this.entries.find((entry) => {
      if (entry.enabled === false || normalizeApi(entry.match.api) !== api) return false;
      const expectedHash = entry.match.jarHash?.trim().toLowerCase() ?? "";
      return !expectedHash || expectedHash === jarHash;
    });
  }

  resolve(site: SiteConfig): ProviderReplacementResolution | undefined {
    const entry = this.match(site);
    if (!entry) return undefined;
    const defaults = RUNTIME_DEFAULTS[entry.replacement.runtime];
    const effectiveSite: SiteConfig = {
      ...site,
      type: entry.replacement.type ?? defaults.type,
      api: entry.replacement.api?.trim() || defaults.api,
      ...(entry.replacement.ext !== undefined ? { ext: entry.replacement.ext } : {}),
      ...(entry.replacement.header ? { header: { ...(site.header ?? {}), ...entry.replacement.header } } : {}),
    };
    const capability = getSiteCapability(effectiveSite);
    if (!capability.supported) {
      throw new Error(`替代 Provider ${entry.id} 无法创建：${capability.reason ?? capability.runtime}`);
    }
    capability.capabilities = { ...capability.capabilities, ...(entry.capabilities ?? {}) };
    return {
      entry,
      originalSite: site,
      effectiveSite,
      capability,
      info: {
        id: entry.id,
        originalApi: site.api,
        runtime: entry.replacement.runtime,
        sourceName: entry.source.name,
        ...(entry.source.repository ? { repository: entry.source.repository } : {}),
        ...(entry.source.license ? { license: entry.source.license } : {}),
        ...(entry.source.verifiedAt ? { verifiedAt: entry.source.verifiedAt } : {}),
        ...(entry.notes ? { notes: entry.notes } : {}),
      },
    };
  }
}
