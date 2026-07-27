import test from "node:test";
import assert from "node:assert/strict";
import { loadDetail } from "../src/desktop/renderer/pages/detail-page.ts";
import { resolvePlayer } from "../src/desktop/renderer/pages/player-page.ts";

test("detail page loads detail data", async () => {
  const state = await loadDetail({ detail: async () => ({ name: "demo" }) }, "s", "1");
  assert.equal(state.error, "");
  assert.deepEqual(state.detail, { name: "demo" });
});

test("player page resolves media url", async () => {
  const state = await resolvePlayer({ resolve: async () => ({ url: "https://example.com/a.m3u8" }) }, "s", "f", "u");
  assert.equal(state.error, "");
  assert.deepEqual(state.media, { url: "https://example.com/a.m3u8" });
});
