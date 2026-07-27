import assert from "node:assert/strict";
import test from "node:test";
import { SourceAdapterError } from "../src/core/source-adapter.ts";
import { SourceAdapterFactory } from "../src/core/source-adapter-factory.ts";

test("SourceAdapterFactory creates a unified adapter for every source runtime", async () => {
  const factory = new SourceAdapterFactory({
    request: async () => "function searchContent(){ return JSON.stringify({list:[]}) }",
  });

  const http = factory.create({ key: "http", name: "HTTP", type: 1, api: "https://example.com/api" });
  const javascript = factory.create({ key: "js", name: "JS", type: 3, api: "https://example.com/spider.js" });
  const drpy = factory.create({
    key: "drpy",
    name: "Drpy",
    type: 3,
    api: "https://example.com/drpy2.min.js",
    ext: "const rule = { host: 'https://example.com' }",
  });
  const t4 = factory.create({ key: "t4", name: "T4", type: 6, api: "http://127.0.0.1:9978/vod" });
  const appys = factory.create({
    key: "appys",
    name: "AppYsV2",
    type: 3,
    api: "csp_AppYsV2",
    ext: "https://example.com/api.php/app",
  });
  const xyq = factory.create({
    key: "xyq",
    name: "XYQ",
    type: 10,
    api: "csp_XYQHiker",
    ext: "{\"分类链接\":\"https://example.com/{cateId}/{catePg}\"}",
  });
  const xbpq = factory.create({
    key: "xbpq",
    name: "XBPQ",
    type: 9,
    api: "csp_XBPQ",
    ext: "{\"主页url\":\"https://example.com\",\"数组\":\"<a&&</a>\"}",
  });
  const catopen = factory.create({
    key: "catopen",
    name: "CatOpen",
    type: 14,
    api: "https://example.com/provider.js",
  });
  const alist = factory.create({
    key: "alist",
    name: "Alist",
    type: 13,
    api: "csp_Alist",
    ext: JSON.stringify({ server: "https://example.com" }),
  });
  const unsupported = factory.create({ key: "dex", name: "Dex", type: 3, api: "csp_Demo" });

  assert.equal(http.runtime, "http");
  assert.equal(javascript.runtime, "javascript");
  assert.equal(drpy.runtime, "drpy");
  assert.equal(t4.runtime, "t4");
  assert.equal(appys.runtime, "appysv2");
  assert.equal(appys.supported, true);
  assert.equal(xyq.runtime, "xyq");
  assert.equal(xyq.supported, true);
  assert.equal(xbpq.runtime, "xbpq");
  assert.equal(xbpq.supported, true);
  assert.equal(catopen.runtime, "catopen");
  assert.equal(catopen.supported, true);
  assert.equal(alist.runtime, "alist");
  assert.equal(alist.supported, true);
  assert.equal(unsupported.runtime, "android-dex");
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.capabilities.search, false);

  await assert.rejects(
    unsupported.search("demo"),
    (error: unknown) => error instanceof SourceAdapterError && error.code === "UNSUPPORTED",
  );

  await Promise.all([http.destroy(), javascript.destroy(), drpy.destroy(), t4.destroy(), appys.destroy(), xyq.destroy(), xbpq.destroy(), catopen.destroy(), alist.destroy(), unsupported.destroy()]);
});
