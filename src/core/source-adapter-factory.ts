import { AlistAdapter } from "./alist-adapter.ts";
import { AppYsV2Adapter } from "./appysv2-adapter.ts";
import { CatOpenAdapter } from "./catopen-adapter.ts";
import { CatVodNodeAdapter } from "./catvod/catvod-node-adapter.ts";
import type { CatVodNodeClient } from "./catvod/catvod-node-client.ts";
import { DrpyAdapter } from "./drpy-adapter.ts";
import { HttpSource } from "./http-source.ts";
import { HybridJavaScriptAdapter } from "./hybrid-js-adapter.ts";
import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import {
  ProviderReplacementRegistry,
  type ProviderReplacement,
  type ProviderReplacementResolution,
} from "./provider-replacement-registry.ts";
import {
  SourceAdapterError,
  UNSUPPORTED_CAPABILITIES,
  type SourceAdapter,
  type SourceCapabilities,
  type SourceHealth,
  type SourceOperation,
} from "./source-adapter.ts";
import { getSiteCapability, type SourceRuntime } from "./source-capability.ts";
import { T4Adapter } from "./t4-adapter.ts";
import { XbpqAdapter } from "./xbpq-adapter.ts";
import { XyqAdapter } from "./xyq-adapter.ts";

export interface SourceAdapterFactoryOptions {
  request?: (url: string, options?: RequestInit) => Promise<string>;
  replacements?: ProviderReplacement[] | ProviderReplacementRegistry;
  catVodClient?: CatVodNodeClient;
}

class UnsupportedSourceAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime: SourceRuntime;
  readonly supported = false;
  readonly capabilities: SourceCapabilities = { ...UNSUPPORTED_CAPABILITIES };
  readonly reason: string;

  constructor(site: SiteConfig, runtime: SourceRuntime, reason: string) {
    this.site = site;
    this.runtime = runtime;
    this.reason = reason;
  }

  async init(): Promise<void> {}
  async home(): Promise<SourceResult> { return this.fail("home"); }
  async category(): Promise<SourceResult> { return this.fail("category"); }
  async search(): Promise<SourceResult> { return this.fail("search"); }
  async detail(): Promise<Vod> { return this.fail("detail"); }
  async player(): Promise<PlayerResult> { return this.fail("player"); }
  async destroy(): Promise<void> {}

  private fail<T>(operation: SourceOperation): T {
    throw new SourceAdapterError({
      code: "UNSUPPORTED",
      site: this.site,
      operation,
      message: `站点 ${this.site.name} 无法执行：${this.reason}`,
    });
  }
}

class ReplacementSourceAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime: SourceRuntime;
  readonly supported = true;
  readonly capabilities: SourceCapabilities;
  readonly reason: string;
  readonly replacement;

  private readonly delegate: SourceAdapter;

  constructor(delegate: SourceAdapter, resolution: ProviderReplacementResolution) {
    this.delegate = delegate;
    this.site = resolution.originalSite;
    this.runtime = resolution.capability.runtime;
    this.capabilities = { ...resolution.capability.capabilities };
    this.replacement = resolution.info;
    this.reason = `已使用替代 Provider：${resolution.info.sourceName}`;
  }

  async init(): Promise<void> {
    await this.delegate.init();
  }

  async home(signal?: AbortSignal): Promise<SourceResult> {
    this.assertCapability("home");
    return this.delegate.home(signal);
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}, signal?: AbortSignal): Promise<SourceResult> {
    this.assertCapability("category");
    return this.delegate.category(tid, page, extend, signal);
  }

  async search(keyword: string, page = "1", quick = false, signal?: AbortSignal): Promise<SourceResult> {
    this.assertCapability("search");
    return this.delegate.search(keyword, page, quick, signal);
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    this.assertCapability("detail");
    return this.delegate.detail(id, signal);
  }

  async player(flag: string, episodeUrl: string, flags: string[] = [], signal?: AbortSignal): Promise<PlayerResult> {
    this.assertCapability("player");
    return this.delegate.player(flag, episodeUrl, flags, signal);
  }

  async proxy(params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    this.assertCapability("proxy");
    if (!this.delegate.proxy) throw new Error("替代 Provider 未实现 proxy");
    return this.delegate.proxy(params, signal);
  }

  async healthCheck(signal?: AbortSignal): Promise<SourceHealth> {
    this.assertCapability("health");
    if (!this.delegate.healthCheck) return { ok: true, latencyMs: 0, message: `${this.runtime} 替代 Provider 可用` };
    return this.delegate.healthCheck(signal);
  }

  async destroy(): Promise<void> {
    await this.delegate.destroy();
  }

  private assertCapability(operation: keyof SourceCapabilities): void {
    if (this.capabilities[operation]) return;
    throw new SourceAdapterError({
      code: "UNSUPPORTED",
      site: this.site,
      operation,
      message: `替代 Provider ${this.replacement.sourceName} 不提供${operation}能力`,
    });
  }
}

export class SourceAdapterFactory {
  private readonly request: (url: string, options?: RequestInit) => Promise<string>;
  private readonly catVodClient?: CatVodNodeClient;
  private replacementRegistry: ProviderReplacementRegistry;

  constructor(options: SourceAdapterFactoryOptions = {}) {
    this.request = options.request ?? (async (url, requestOptions) => {
      const response = await fetch(url, { ...requestOptions, redirect: "follow" });
      if (!response.ok) throw new Error(`JS Spider 请求失败：HTTP ${response.status}`);
      return response.text();
    });
    this.catVodClient = options.catVodClient;
    this.replacementRegistry = options.replacements instanceof ProviderReplacementRegistry
      ? options.replacements
      : new ProviderReplacementRegistry(options.replacements);
  }

  setReplacements(replacements: ProviderReplacement[] | ProviderReplacementRegistry = []): void {
    this.replacementRegistry = replacements instanceof ProviderReplacementRegistry
      ? replacements
      : new ProviderReplacementRegistry(replacements);
  }

  replacementCount(): number {
    return this.replacementRegistry.list().length;
  }

  replacementEntries(): ProviderReplacement[] {
    return this.replacementRegistry.list();
  }

  create(site: SiteConfig): SourceAdapter {
    const replacement = this.replacementRegistry.resolve(site);
    if (replacement) {
      return new ReplacementSourceAdapter(this.createDirect(replacement.effectiveSite), replacement);
    }
    return this.createDirect(site);
  }

  private createDirect(site: SiteConfig): SourceAdapter {
    const capability = getSiteCapability(site);
    if (!capability.supported) {
      return new UnsupportedSourceAdapter(site, capability.runtime, capability.reason ?? "缺少可用运行时");
    }

    switch (capability.runtime) {
      case "http":
        return new HttpSource(site);
      case "javascript":
        return new HybridJavaScriptAdapter(site, this.request);
      case "drpy":
        return new DrpyAdapter(site);
      case "appysv2":
        return new AppYsV2Adapter(site);
      case "xyq":
        return new XyqAdapter(site);
      case "xbpq":
        return new XbpqAdapter(site);
      case "catopen":
        return new CatOpenAdapter(site);
      case "alist":
        return new AlistAdapter(site);
      case "t4":
        return new T4Adapter(site);
      case "catvod-node":
        return this.catVodClient
          ? new CatVodNodeAdapter(site, this.catVodClient)
          : new UnsupportedSourceAdapter(site, capability.runtime, "CatVod 本地服务尚未配置");
      default:
        return new UnsupportedSourceAdapter(site, capability.runtime, capability.reason ?? "缺少可用运行时");
    }
  }
}
