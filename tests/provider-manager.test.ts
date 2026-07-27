import assert from "node:assert/strict";
import test from "node:test";
import type { PlayerResult, SiteConfig, SourceResult, Vod } from "../src/core/models.ts";
import { ProviderManager, providerCacheKey } from "../src/core/provider-manager.ts";
import { STANDARD_CAPABILITIES, type SourceAdapter } from "../src/core/source-adapter.ts";

class FakeAdapter implements SourceAdapter {
  readonly runtime = "http" as const;
  readonly supported = true;
  readonly capabilities = { ...STANDARD_CAPABILITIES };
  readonly site: SiteConfig;
  destroyed = 0;

  constructor(site: SiteConfig) {
    this.site = site;
  }
  async init() {}
  async home(): Promise<SourceResult> { return { list: [], pageCount: 0, message: "" }; }
  async category(): Promise<SourceResult> { return { list: [], pageCount: 0, message: "" }; }
  async search(): Promise<SourceResult> { return { list: [], pageCount: 0, message: "" }; }
  async detail(): Promise<Vod> { throw new Error("unused"); }
  async player(): Promise<PlayerResult> { throw new Error("unused"); }
  async destroy() { this.destroyed += 1; }
}

test("ProviderManager reuses adapters by config hash and evicts least recently used entries", async () => {
  const created: FakeAdapter[] = [];
  const manager = new ProviderManager({
    create(site) {
      const adapter = new FakeAdapter(site);
      created.push(adapter);
      return adapter;
    },
  }, 2);

  const firstSite = { key: "a", name: "A", type: 1, api: "https://a.example/api" };
  const secondSite = { key: "b", name: "B", type: 1, api: "https://b.example/api" };
  const thirdSite = { key: "c", name: "C", type: 1, api: "https://c.example/api" };

  const first = await manager.acquire(firstSite);
  const firstAgain = await manager.acquire({ ...firstSite });
  assert.equal(firstAgain, first);
  assert.equal(created.length, 1);
  assert.equal(providerCacheKey(firstSite), providerCacheKey({ ...firstSite }));

  const second = await manager.acquire(secondSite);
  await manager.acquire(firstSite); // refresh first, making second the LRU entry
  await manager.acquire(thirdSite);

  assert.equal(manager.size(), 2);
  assert.equal((second as FakeAdapter).destroyed, 1);
  assert.equal((first as FakeAdapter).destroyed, 0);

  await manager.clear();
  assert.equal((first as FakeAdapter).destroyed, 1);
  assert.equal(manager.size(), 0);
});
