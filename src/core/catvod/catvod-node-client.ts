import { redactSensitiveText } from "../log-redaction.ts";
import { combineSourceSignal } from "../source-adapter.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

export type CatVodBaseUrlProvider = () => string | undefined;

export interface CatVodNodeClientOptions {
  baseUrl: CatVodBaseUrlProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CatVodNodeClient {
  private readonly baseUrlProvider: CatVodBaseUrlProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CatVodNodeClientOptions) {
    this.baseUrlProvider = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  baseUrl(): string {
    const value = this.baseUrlProvider()?.trim().replace(/\/+$/, "");
    if (!value) throw new Error("CatVod 服务尚未启动");
    return value;
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; name?: string }> {
    return this.getObject("/health", signal) as Promise<{ ok: boolean; name?: string }>;
  }

  async config(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.getObject("/config", signal);
  }

  async spider(
    apiPath: string,
    operation: "init" | "support" | "home" | "homeVod" | "category" | "detail" | "search" | "play",
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const normalized = normalizeApiPath(apiPath);
    return this.request(`${normalized}/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal,
    });
  }

  async getObject(pathname: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = await this.request(pathname, { method: "GET", signal });
    if (!isRecord(value)) throw new Error(`CatVod ${pathname} 响应不是 JSON 对象`);
    return value;
  }

  async request(
    pathname: string,
    options: RequestInit & { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const url = this.resolve(pathname);
    const response = await this.fetchImpl(url, {
      ...options,
      redirect: "follow",
      signal: combineSourceSignal(this.timeoutMs, options.signal),
    });
    const payload = await response.text();
    if (!response.ok) {
      throw new Error(`CatVod 请求失败：HTTP ${response.status}${payload.trim() ? ` · ${safeExcerpt(payload)}` : ""}`);
    }
    if (!payload.trim()) return {};
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }

  resolve(pathname: string): string {
    if (/^https?:\/\//i.test(pathname)) return pathname;
    const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return `${this.baseUrl()}${suffix}`;
  }
}

export function normalizeApiPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("CatVod 站点 API 路径为空");
  if (/^catvod:\/\/service/i.test(trimmed)) {
    const url = new URL(trimmed);
    return `/${url.pathname.replace(/^\/+/, "")}`.replace(/\/$/, "");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return `${url.pathname}${url.search}`.replace(/\/$/, "");
  }
  return `/${trimmed.replace(/^\/+/, "")}`.replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeExcerpt(value: string): string {
  return redactSensitiveText(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
