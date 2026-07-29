import assert from "node:assert/strict";
import test from "node:test";
import {
  inferCatVodSourceLabel,
  inferConfigName,
  isCatVodBundleSource,
  selectCatVodSiteAfterImport,
  selectConfigSiteAfterImport,
} from "../src/desktop/renderer/source-config-strategy.ts";

test("configuration names are inferred from a URL or local path", () => {
  assert.equal(inferConfigName("https://example.com/config/family.json"), "family");
  assert.equal(inferConfigName("https://tv.example.com/"), "tv.example.com");
  assert.equal(inferConfigName("/Users/name/TV/家庭配置.json"), "家庭配置");
  assert.equal(inferConfigName("C:\\TV\\movie.txt"), "movie");
  assert.equal(inferConfigName("   "), "新配置");
});

test("CatVod bundle MD5 URLs are distinguished from ordinary configurations", () => {
  assert.equal(isCatVodBundleSource("http://user:pass@example.com/cat/index.js.md5"), true);
  assert.equal(isCatVodBundleSource("https://example.com/config.json"), false);
  assert.equal(isCatVodBundleSource("https://example.com/cat/index.js"), false);
});

test("CatVod source labels expose the host without credentials", () => {
  assert.equal(
    inferCatVodSourceLabel("http://user:pass@cat.999888987.xyz/index.js.md5"),
    "CatVod · cat.999888987.xyz",
  );
  assert.equal(inferCatVodSourceLabel(""), "CatVod 服务源");
});

test("source imports select their own package while preserving a still-valid site", () => {
  const siteKeys = ["ordinary:first", "ordinary:second", "catvod:first", "catvod:second"];
  assert.equal(selectCatVodSiteAfterImport(siteKeys, "ordinary:first"), "catvod:first");
  assert.equal(selectCatVodSiteAfterImport(siteKeys, "catvod:second"), "catvod:second");
  assert.equal(selectCatVodSiteAfterImport(siteKeys, "catvod:missing"), "catvod:first");
  assert.equal(selectCatVodSiteAfterImport(["ordinary:first"], "ordinary:first"), "");

  assert.equal(selectConfigSiteAfterImport(siteKeys, "catvod:first"), "ordinary:first");
  assert.equal(selectConfigSiteAfterImport(siteKeys, "ordinary:second"), "ordinary:second");
  assert.equal(selectConfigSiteAfterImport(["catvod:first"], "catvod:first"), "");
});
