import { createHash } from "node:crypto";
import type { SiteConfig } from "./models.ts";
import type { SourceAdapter } from "./source-adapter.ts";
import { SourceAdapterFactory } from "./source-adapter-factory.ts";

export interface SourceAdapterCreator {
  create(site: SiteConfig): SourceAdapter;
}

interface ProviderEntry {
  adapter: SourceAdapter;
  siteKey: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function providerCacheKey(site: SiteConfig): string {
  const payload = JSON.stringify(stableValue(site));
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 20);
  return `${site.key}:${hash}`;
}

export class ProviderManager {
  private readonly entries = new Map<string, ProviderEntry>();
  private readonly factory: SourceAdapterCreator;
  private readonly capacity: number;

  constructor(factory: SourceAdapterCreator = new SourceAdapterFactory(), capacity = 10) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("ProviderManager capacity 必须为正整数");
    this.factory = factory;
    this.capacity = capacity;
  }

  async acquire(site: SiteConfig): Promise<SourceAdapter> {
    const key = providerCacheKey(site);
    const current = this.entries.get(key);
    if (current) {
      this.entries.delete(key);
      this.entries.set(key, current);
      return current.adapter;
    }

    const adapter = this.factory.create(site);
    this.entries.set(key, { adapter, siteKey: site.key });
    await this.evictOverflow();
    return adapter;
  }

  async invalidateSite(siteKey: string): Promise<void> {
    const targets = [...this.entries.entries()].filter(([, entry]) => entry.siteKey === siteKey);
    for (const [key, entry] of targets) {
      this.entries.delete(key);
      await entry.adapter.destroy();
    }
  }

  async clear(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.adapter.destroy()));
  }

  size(): number {
    return this.entries.size;
  }

  private async evictOverflow(): Promise<void> {
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) await oldest.adapter.destroy();
    }
  }
}
