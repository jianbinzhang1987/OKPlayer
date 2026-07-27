import assert from "node:assert/strict";
import test from "node:test";
import { CatVodNodeAdapter } from "../src/core/catvod/catvod-node-adapter.ts";
import { CatVodNodeClient } from "../src/core/catvod/catvod-node-client.ts";
import type { SiteConfig } from "../src/core/models.ts";

function createHarness() {
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/init")) return Response.json({});
    if (url.endsWith("/home")) return Response.json({
      class: [{ type_id: "movie", type_name: "电影" }],
      filters: {
        movie: [{ key: "area", name: "地区", value: [{ n: "全部", v: "" }, { n: "中国", v: "中国" }] }],
      },
      list: [{
        vod_id: "home-1",
        vod_name: "首页影片",
        vod_pic: "http://127.0.0.1:11989/imageProxy?url=x",
      }],
      page: 1,
      pagecount: 3,
    });
    if (url.endsWith("/category")) return Response.json({
      list: [{ vod_id: "cat-1", vod_name: "分类影片" }],
      page: body.page,
      pagecount: 5,
    });
    if (url.endsWith("/search")) return Response.json({ list: [{ vod_id: "s-1", vod_name: "搜索影片" }] });
    if (url.endsWith("/detail")) return Response.json({
      list: [{
        vod_id: "s-1",
        vod_name: "搜索影片",
        vod_play_from: "线路一",
        vod_play_url: "第1集$episode-1",
      }],
    });
    if (url.endsWith("/play")) return Response.json({
      parse: 0,
      url: "http://127.0.0.1:11989/proxy/session/index.m3u8",
      header: { Referer: "https://example.com/" },
      format: "application/vnd.apple.mpegurl",
      subt: "/lrcproxy/subtitle.vtt",
    });
    return new Response("not found", { status: 404 });
  };
  const client = new CatVodNodeClient({ baseUrl: () => "http://127.0.0.1:9988", fetchImpl });
  const site: SiteConfig = {
    key: "catvod:nodejs_demo",
    name: "示例源",
    type: 15,
    api: "catvod://service/spider/demo/3",
    contentType: "vod",
    searchable: 1,
  };
  return { requests, adapter: new CatVodNodeAdapter(site, client) };
}

test("CatVodNodeAdapter maps home categories, filters and stable image URLs", async () => {
  const { adapter, requests } = createHarness();
  const result = await adapter.home();
  assert.equal(requests[0]?.url, "http://127.0.0.1:9988/spider/demo/3/init");
  assert.equal(requests[1]?.url, "http://127.0.0.1:9988/spider/demo/3/home");
  assert.deepEqual(result.categories, [{ id: "movie", name: "电影" }]);
  assert.equal(result.filters?.movie?.[0]?.key, "area");
  assert.equal(result.list[0]?.vodPic, "fongmi-catvod://service/imageProxy?url=x");
  assert.equal(result.list[0]?.contentKind, "playable");
  assert.equal(result.pageCount, 3);
});

test("CatVodNodeAdapter sends category aliases and service filters", async () => {
  const { adapter, requests } = createHarness();
  const result = await adapter.category("movie", "2", { area: "中国" });
  const request = requests.find((entry) => entry.url.endsWith("/category"));
  assert.deepEqual(request?.body, {
    id: "movie",
    tid: "movie",
    page: 2,
    pg: 2,
    filter: true,
    filters: { area: "中国" },
    extend: { area: "中国" },
  });
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 5);
});

test("CatVodNodeAdapter completes search, detail and play mapping", async () => {
  const { adapter, requests } = createHarness();
  const search = await adapter.search("测试", "1", true);
  assert.equal(search.list[0]?.siteKey, "catvod:nodejs_demo");
  const detail = await adapter.detail("s-1");
  assert.equal(detail.flags[0]?.episodes[0]?.url, "episode-1");
  const player = await adapter.player("线路一", "episode-1");
  assert.equal(player.url, "http://127.0.0.1:9988/proxy/session/index.m3u8");
  assert.equal(player.subtitleUrl, "http://127.0.0.1:9988/lrcproxy/subtitle.vtt");
  assert.equal(player.header.Referer, "https://example.com/");
  assert.deepEqual(requests.find((entry) => entry.url.endsWith("/play"))?.body, {
    flag: "线路一",
    id: "episode-1",
    flags: [],
  });
});

test("discovery CatVod site exposes home but disables detail, search and player capabilities", () => {
  const client = new CatVodNodeClient({
    baseUrl: () => "http://127.0.0.1:9988",
    fetchImpl: async () => Response.json({}),
  });
  const adapter = new CatVodNodeAdapter({
    key: "catvod:nodejs_douban",
    name: "豆瓣首页",
    type: 15,
    api: "catvod://service/spider/douban/3",
    contentType: "discovery",
  }, client);
  assert.equal(adapter.capabilities.home, true);
  assert.equal(adapter.capabilities.search, false);
  assert.equal(adapter.capabilities.detail, false);
  assert.equal(adapter.capabilities.player, false);
});
