import test from "node:test";
import assert from "node:assert/strict";
import { SearchPageController } from "../src/desktop/renderer/pages/search-page.ts";

test("renderer search page validates keyword and calls preload api", async () => {
  (globalThis as any).tvApi = {
    search: async (keyword: string) => [{ vodName: keyword }],
  };

  const page = new SearchPageController();
  const empty = await page.search("   ");
  assert.deepEqual(empty, []);

  const result = await page.search("庆余年");
  assert.equal(result[0].vodName, "庆余年");
  assert.equal(page.state.loading, false);
});
