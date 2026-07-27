import { redactSensitiveText } from "./log-redaction.ts";
import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import type { SourceRuntime } from "./source-capability.ts";
import type { ProviderReplacementInfo } from "./provider-replacement-registry.ts";

export type SourceOperation = "init" | "home" | "category" | "search" | "detail" | "player" | "proxy" | "health" | "destroy";

export interface SourceCapabilities {
  home: boolean;
  category: boolean;
  search: boolean;
  detail: boolean;
  player: boolean;
  proxy: boolean;
  health: boolean;
}

export interface SourceHealth {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export interface SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime: SourceRuntime;
  readonly supported: boolean;
  readonly capabilities: SourceCapabilities;
  readonly reason?: string;
  readonly replacement?: ProviderReplacementInfo;

  init(): Promise<void>;
  home(signal?: AbortSignal): Promise<SourceResult>;
  category(tid: string, page?: string, extend?: Record<string, string>, signal?: AbortSignal): Promise<SourceResult>;
  search(keyword: string, page?: string, quick?: boolean, signal?: AbortSignal): Promise<SourceResult>;
  detail(id: string, signal?: AbortSignal): Promise<Vod>;
  player(flag: string, episodeUrl: string, flags?: string[], signal?: AbortSignal): PlayerResult | Promise<PlayerResult>;
  proxy?(params: Record<string, string>, signal?: AbortSignal): Promise<unknown>;
  healthCheck?(signal?: AbortSignal): Promise<SourceHealth>;
  destroy(): Promise<void>;
}

export type SourceErrorCode = "UNSUPPORTED" | "TIMEOUT" | "CANCELLED" | "NETWORK" | "INVALID_RESPONSE" | "RUNTIME";

export class SourceAdapterError extends Error {
  readonly code: SourceErrorCode;
  readonly siteKey: string;
  readonly siteName: string;
  readonly operation: SourceOperation;
  readonly cause?: unknown;

  constructor(options: {
    code: SourceErrorCode;
    site: SiteConfig;
    operation: SourceOperation;
    message: string;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "SourceAdapterError";
    this.code = options.code;
    this.siteKey = options.site.key;
    this.siteName = options.site.name;
    this.operation = options.operation;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export const STANDARD_CAPABILITIES: SourceCapabilities = {
  home: true,
  category: true,
  search: true,
  detail: true,
  player: true,
  proxy: false,
  health: false,
};

export const UNSUPPORTED_CAPABILITIES: SourceCapabilities = {
  home: false,
  category: false,
  search: false,
  detail: false,
  player: false,
  proxy: false,
  health: false,
};

export function combineSourceSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
}

export async function runSourceOperation<T>(
  site: SiteConfig,
  operation: SourceOperation,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await task();
  } catch (error) {
    if (error instanceof SourceAdapterError) throw error;
    const rawMessage = redactSensitiveText(error instanceof Error ? error.message : String(error));
    const aborted = error instanceof Error && error.name === "AbortError";
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || /timeout|超时/i.test(rawMessage));
    const code: SourceErrorCode = timedOut ? "TIMEOUT" : aborted ? "CANCELLED" : /JSON|响应|response/i.test(rawMessage) ? "INVALID_RESPONSE" : /fetch|network|HTTP|请求/i.test(rawMessage) ? "NETWORK" : "RUNTIME";
    const message = `站点 ${site.name} ${operation} 失败：${rawMessage}`;
    console.warn("[source]", {
      siteKey: site.key,
      runtime: site.type,
      operation,
      elapsedMs: Date.now() - startedAt,
      code,
      message: rawMessage,
    });
    throw new SourceAdapterError({ code, site, operation, message, cause: error });
  }
}
