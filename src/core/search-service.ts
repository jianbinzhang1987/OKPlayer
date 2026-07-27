import type { SiteConfig, SourceResult } from "./models.ts";
import { SourceAdapterFactory } from "./source-adapter-factory.ts";
import { getSiteCapability } from "./source-capability.ts";

export interface SearchEvent {
  searchId: number;
  site: SiteConfig;
  result?: SourceResult;
  error?: string;
}

export class SearchService {
  private currentSearchId = 0;
  private currentController: AbortController | null = null;
  private readonly adapterFactory: SourceAdapterFactory;

  constructor(adapterFactory = new SourceAdapterFactory()) {
    this.adapterFactory = adapterFactory;
  }

  start(
    sites: SiteConfig[],
    keyword: string,
    onEvent: (event: SearchEvent) => void,
  ): { searchId: number; done: Promise<void> } {
    this.stop();
    const searchId = ++this.currentSearchId;
    const controller = new AbortController();
    this.currentController = controller;

    const supportedSites = sites.filter((site) => {
      const capability = getSiteCapability(site);
      return site.searchable !== 0 && capability.supported && capability.capabilities.search;
    });

    const tasks = supportedSites.map(async (site) => {
      const adapter = this.adapterFactory.create(site);
      try {
        const result = await adapter.search(keyword, "1", false, controller.signal);
        if (this.currentSearchId === searchId && !controller.signal.aborted) {
          onEvent({ searchId, site, result });
        }
      } catch (error) {
        if (controller.signal.aborted || this.currentSearchId !== searchId) return;
        onEvent({
          searchId,
          site,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await adapter.destroy();
      }
    });

    const done = Promise.allSettled(tasks).then(() => undefined);
    return { searchId, done };
  }

  stop(): void {
    this.currentSearchId += 1;
    this.currentController?.abort(new Error("搜索已取消"));
    this.currentController = null;
  }
}
