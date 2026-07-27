import { CatOpenAdapter } from "./catopen-adapter.ts";
import { JsSiteAdapter, JsSpiderRuntime } from "./js-spider-runtime.ts";
import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import { STANDARD_CAPABILITIES, type SourceAdapter, type SourceCapabilities, type SourceHealth } from "./source-adapter.ts";

/**
 * FongMi type=3 JavaScript sources exist in two incompatible shapes:
 *
 * 1. modern ES modules exporting __jsEvalReturn/default providers;
 * 2. legacy scripts exposing homeContent/searchContent/detailContent globals.
 *
 * Try the module-compatible isolated CatOpen host first and fall back to the
 * legacy vm runtime only when the script is not a module provider.
 */
export class HybridJavaScriptAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "javascript" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = { ...STANDARD_CAPABILITIES, proxy: true };

  private readonly moduleAdapter: CatOpenAdapter;
  private readonly legacyAdapter: JsSiteAdapter;
  private delegate?: SourceAdapter;
  private initializing?: Promise<void>;

  constructor(site: SiteConfig, request: (url: string, options?: RequestInit) => Promise<string>) {
    this.site = site;
    this.moduleAdapter = new CatOpenAdapter(site);
    this.legacyAdapter = new JsSiteAdapter(
      site,
      new JsSpiderRuntime({ request }, { timeoutMs: Math.max(1, site.timeout ?? 15) * 1_000 }),
    );
  }

  async init(): Promise<void> {
    if (this.delegate) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeDelegate();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  async home(signal?: AbortSignal): Promise<SourceResult> {
    return (await this.active()).home(signal);
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}, signal?: AbortSignal): Promise<SourceResult> {
    return (await this.active()).category(tid, page, extend, signal);
  }

  async search(keyword: string, page = "1", quick = false, signal?: AbortSignal): Promise<SourceResult> {
    return (await this.active()).search(keyword, page, quick, signal);
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    return (await this.active()).detail(id, signal);
  }

  async player(flag: string, episodeUrl: string, flags: string[] = [], signal?: AbortSignal): Promise<PlayerResult> {
    return (await this.active()).player(flag, episodeUrl, flags, signal);
  }

  async proxy(params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const active = await this.active();
    if (!active.proxy) return [];
    return active.proxy(params, signal);
  }

  async healthCheck(signal?: AbortSignal): Promise<SourceHealth> {
    const active = await this.active();
    if (active.healthCheck) return active.healthCheck(signal);
    return { ok: true, latencyMs: 0, message: `${active.runtime} JavaScript Provider 已初始化` };
  }

  async destroy(): Promise<void> {
    this.delegate = undefined;
    await Promise.allSettled([
      this.moduleAdapter.destroy(),
      this.legacyAdapter.destroy(),
    ]);
  }

  private async active(): Promise<SourceAdapter> {
    await this.init();
    if (!this.delegate) throw new Error(`JavaScript Provider ${this.site.name} 初始化失败`);
    return this.delegate;
  }

  private async initializeDelegate(): Promise<void> {
    let moduleError: unknown;
    try {
      await this.moduleAdapter.init();
      this.delegate = this.moduleAdapter;
      return;
    } catch (error) {
      moduleError = error;
      await this.moduleAdapter.destroy().catch(() => undefined);
    }

    try {
      await this.legacyAdapter.init();
      this.delegate = this.legacyAdapter;
    } catch (legacyError) {
      const moduleMessage = moduleError instanceof Error ? moduleError.message : String(moduleError);
      const legacyMessage = legacyError instanceof Error ? legacyError.message : String(legacyError);
      throw new Error(`模块运行时失败：${moduleMessage}；传统运行时失败：${legacyMessage}`);
    }
  }
}
