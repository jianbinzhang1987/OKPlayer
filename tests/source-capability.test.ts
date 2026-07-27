import assert from "node:assert/strict";
import test from "node:test";
import { getSiteCapability } from "../src/core/source-capability.ts";

test("source capability distinguishes HTTP JS Drpy T4 portable CSP and Android Dex spiders", () => {
  const http = getSiteCapability({ key: "api", name: "API", type: 1, api: "https://example.com/api.php" });
  assert.equal(http.supported, true);
  assert.equal(http.runtime, "http");
  assert.equal(http.capabilities.search, true);
  assert.equal(http.capabilities.health, false);

  const js = getSiteCapability({ key: "js", name: "JS", type: 3, api: "https://example.com/spider.js" });
  assert.equal(js.supported, true);
  assert.equal(js.runtime, "javascript");
  assert.equal(js.capabilities.player, true);

  const drpy = getSiteCapability({
    key: "drpy",
    name: "Drpy",
    type: 3,
    api: "https://example.com/drpy2.min.js",
    ext: "https://example.com/rule.js",
  });
  assert.equal(drpy.supported, true);
  assert.equal(drpy.runtime, "drpy");
  assert.equal(drpy.capabilities.search, true);

  const genericDrpy = getSiteCapability({
    key: "generic-drpy",
    name: "Generic Drpy",
    type: 3,
    api: "https://engine.example.com/runtime.js",
    ext: "https://rules.example.com/anime.js",
  });
  assert.equal(genericDrpy.supported, true);
  assert.equal(genericDrpy.runtime, "drpy");

  const fongMiT4 = getSiteCapability({ key: "t4-fongmi", name: "T4 FongMi", type: 4, api: "https://example.com/vod" });
  assert.equal(fongMiT4.supported, true);
  assert.equal(fongMiT4.runtime, "t4");

  const t4 = getSiteCapability({ key: "t4", name: "T4", type: 6, api: "http://127.0.0.1:9978/api/v1/vod" });
  assert.equal(t4.supported, true);
  assert.equal(t4.runtime, "t4");
  assert.equal(t4.capabilities.health, true);
  assert.equal(t4.capabilities.proxy, true);

  const appys = getSiteCapability({
    key: "appys",
    name: "AppYsV2",
    type: 3,
    api: "csp_AppYsV2",
    ext: "https://example.com/api.php/app",
  });
  assert.equal(appys.supported, true);
  assert.equal(appys.runtime, "appysv2");

  const xbpq = getSiteCapability({ key: "xbpq", name: "XBPQ", type: 3, api: "csp_XBPQ", ext: "https://example.com/rule.json" });
  assert.equal(xbpq.supported, true);
  assert.equal(xbpq.runtime, "xbpq");
  assert.equal(xbpq.capabilities.search, true);

  const xyq = getSiteCapability({ key: "xyq", name: "XYQ", type: 10, api: "csp_XYQHiker", ext: "https://example.com/rule.json" });
  assert.equal(xyq.supported, true);
  assert.equal(xyq.runtime, "xyq");
  assert.equal(xyq.capabilities.detail, true);

  const alist = getSiteCapability({
    key: "alist",
    name: "Alist",
    type: 3,
    api: "csp_Alist",
    ext: JSON.stringify({ server: "https://example.com" }),
  });
  assert.equal(alist.supported, true);
  assert.equal(alist.runtime, "alist");
  assert.equal(alist.capabilities.category, true);

  const catopen = getSiteCapability({ key: "catopen", name: "CatOpen", type: 14, api: "https://example.com/provider.js" });
  assert.equal(catopen.supported, true);
  assert.equal(catopen.runtime, "catopen");
  assert.equal(catopen.capabilities.proxy, true);

  const dex = getSiteCapability({
    key: "玩偶",
    name: "玩偶",
    type: 3,
    api: "csp_NewWoggGuard",
    jar: "https://example.com/spider.png;md5;abc",
  });
  assert.equal(dex.supported, false);
  assert.equal(dex.runtime, "android-dex");
  assert.equal(dex.capabilities.search, false);
  assert.match(dex.reason ?? "", /csp_NewWoggGuard/);
  assert.match(dex.reason ?? "", /Android Dex\/JAR/);
});
