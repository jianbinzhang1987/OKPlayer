import assert from "node:assert/strict";
import test from "node:test";
import { inferConfigName } from "../src/desktop/renderer/source-config-strategy.ts";

test("configuration names are inferred from a URL or local path", () => {
  assert.equal(inferConfigName("https://example.com/config/family.json"), "family");
  assert.equal(inferConfigName("https://tv.example.com/"), "tv.example.com");
  assert.equal(inferConfigName("/Users/name/TV/家庭配置.json"), "家庭配置");
  assert.equal(inferConfigName("C:\\TV\\movie.txt"), "movie");
  assert.equal(inferConfigName("   "), "新配置");
});
