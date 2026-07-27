import type { CatVodRemoteAccessPolicy } from "../core/catvod/catvod-types.ts";

export interface CatVodNetworkAuditEvent {
  origin: string;
  method: string;
  phase: "startup";
  blocked: boolean;
  at: number;
}

export function normalizeCatVodRemoteAccessPolicy(value: unknown): CatVodRemoteAccessPolicy {
  return value === "block-startup" ? "block-startup" : "allow";
}

export function createCatVodNetworkAuditEvent(
  value: unknown,
  method: unknown,
  policy: CatVodRemoteAccessPolicy,
  active: boolean,
  at = Date.now(),
): CatVodNetworkAuditEvent | undefined {
  if (!active) return undefined;
  const url = parseRequestUrl(value);
  if (!url || !["http:", "https:"].includes(url.protocol) || isLoopbackHostname(url.hostname)) return undefined;
  return {
    origin: url.origin,
    method: normalizeMethod(method),
    phase: "startup",
    blocked: policy === "block-startup",
    at,
  };
}

export function requestUrlFromNodeArgs(protocol: "http:" | "https:", args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return String(first);
  if (!isRecord(first)) return undefined;
  if (typeof first.href === "string") return first.href;
  const requestProtocol = typeof first.protocol === "string" ? first.protocol : protocol;
  const hostname = text(first.hostname) || text(first.host);
  if (!hostname) return undefined;
  const port = text(first.port);
  const pathname = text(first.path) || text(first.pathname) || "/";
  const normalizedHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `${requestProtocol}//${normalizedHost}${port ? `:${port}` : ""}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

export function requestMethodFromNodeArgs(args: unknown[], fallback = "GET"): string {
  const first = args[0];
  const second = args[1];
  if (isRecord(first) && typeof first.method === "string") return normalizeMethod(first.method);
  if (isRecord(second) && typeof second.method === "string") return normalizeMethod(second.method);
  return normalizeMethod(fallback);
}

function parseRequestUrl(value: unknown): URL | undefined {
  try {
    if (value instanceof URL) return value;
    if (typeof value === "string") return new URL(value);
    if (isRecord(value) && typeof value.url === "string") return new URL(value.url);
    return undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "0.0.0.0";
}

function normalizeMethod(value: unknown): string {
  const method = typeof value === "string" ? value.trim().toUpperCase() : "";
  return method || "GET";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}
