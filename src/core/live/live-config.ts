import { createHash } from "node:crypto";
import type { HeadersMap } from "../models.ts";
import type { LiveCatchup, LiveSourceDefinition } from "./live-models.ts";

export function normalizeLiveDefinitions(input: unknown, baseUrl: URL): LiveSourceDefinition[] {
  if (!Array.isArray(input)) return [];
  const names = new Set<string>();
  const definitions: LiveSourceDefinition[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const normalized = normalizeLiveDefinition(input[index], baseUrl, index);
    if (!normalized) continue;
    let name = normalized.name;
    if (names.has(name)) name = `${name} ${index + 1}`;
    names.add(name);
    definitions.push({ ...normalized, name, id: stableId(baseUrl.toString(), name, normalized.url ?? `embedded-${index}`) });
  }
  return definitions;
}

function normalizeLiveDefinition(input: unknown, baseUrl: URL, index: number): LiveSourceDefinition | undefined {
  if (typeof input === "string") {
    const url = resolveResource(input, baseUrl);
    if (!url) return undefined;
    const name = inferName(url, index);
    return {
      id: stableId(baseUrl.toString(), name, url),
      name,
      url,
      epgUrls: [],
      header: {},
    };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const url = resolveResource(raw.url, baseUrl);
  const groups = Array.isArray(raw.groups) ? raw.groups : undefined;
  const rawName = stringValue(raw.name);
  const name = rawName ?? (url ? inferName(url, index) : `直播源 ${index + 1}`);
  if (!url && !groups?.length) return undefined;
  const header = normalizeHeaders(raw.header);
  const ua = stringValue(raw.ua);
  const origin = stringValue(raw.origin);
  const referer = stringValue(raw.referer ?? raw.referrer);
  const epgUrls = splitEpgUrls(raw.epg).map((value) => resolveTemplatedResource(value, baseUrl));
  return {
    id: stableId(baseUrl.toString(), name, url ?? `embedded-${index}`),
    name,
    ...(url ? { url } : {}),
    ...(stringValue(raw.api) ? { api: resolveResource(raw.api, baseUrl) ?? stringValue(raw.api) } : {}),
    ...(stringValue(raw.ext) ? { ext: resolveResource(raw.ext, baseUrl) ?? stringValue(raw.ext) } : {}),
    ...(stringValue(raw.jar) ? { jar: resolveResource(raw.jar, baseUrl) ?? stringValue(raw.jar) } : {}),
    ...(stringValue(raw.click) ? { click: stringValue(raw.click) } : {}),
    ...(stringValue(raw.logo) ? { logo: resolveTemplatedResource(stringValue(raw.logo)!, baseUrl) } : {}),
    epgUrls,
    ...(ua ? { ua } : {}),
    ...(origin ? { origin } : {}),
    ...(referer ? { referer } : {}),
    ...(stringValue(raw.timeZone) ? { timeZone: stringValue(raw.timeZone) } : {}),
    ...(finitePositiveNumber(raw.timeout) ? { timeout: finitePositiveNumber(raw.timeout) } : {}),
    header,
    ...(normalizeCatchup(raw.catchup) ? { catchup: normalizeCatchup(raw.catchup) } : {}),
    ...(groups ? { groups } : {}),
    ...(typeof raw.boot === "boolean" ? { boot: raw.boot } : {}),
    ...(typeof raw.pass === "boolean" ? { revealProtectedGroups: raw.pass } : {}),
  };
}

function normalizeCatchup(value: unknown): LiveCatchup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: LiveCatchup = {};
  for (const key of ["type", "regex", "source", "replace"] as const) {
    const normalized = stringValue(raw[key]);
    if (normalized) result[key] = normalized;
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeHeaders(value: unknown): HeadersMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, raw]) => {
    const normalized = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
    if (!key.trim() || !normalized || /[\r\n]/.test(`${key}${normalized}`)) return [];
    return [[canonicalHeaderName(key.trim()), normalized]];
  }));
}

function splitEpgUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => splitEpgUrls(item));
  const text = stringValue(value);
  return text ? text.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function resolveTemplatedResource(value: string, baseUrl: URL): string {
  const placeholders: string[] = [];
  const protectedValue = value.replace(/\{[^}]+\}/g, (match) => {
    placeholders.push(match);
    return `__LIVE_PLACEHOLDER_${placeholders.length - 1}__`;
  });
  const resolved = resolveResource(protectedValue, baseUrl) ?? protectedValue;
  return resolved.replace(/__LIVE_PLACEHOLDER_(\d+)__/g, (_match, index) => placeholders[Number(index)] ?? "");
}

function resolveResource(value: unknown, baseUrl: URL): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  if (/^(?:csp_|data:)/i.test(text)) return text;
  try {
    return new URL(text, baseUrl).toString();
  } catch {
    return text;
  }
}

function inferName(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.(?:m3u8?|txt|json)$/i, "");
    return file || parsed.hostname || `直播源 ${index + 1}`;
  } catch {
    return `直播源 ${index + 1}`;
  }
}

function stableId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 20);
}

function finitePositiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function canonicalHeaderName(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "user-agent" || normalized === "ua") return "User-Agent";
  if (normalized === "referer" || normalized === "referrer") return "Referer";
  if (normalized === "origin") return "Origin";
  if (normalized === "authorization") return "Authorization";
  if (normalized === "cookie") return "Cookie";
  return value;
}
