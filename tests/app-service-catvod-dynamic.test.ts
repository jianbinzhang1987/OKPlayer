import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";
import { parseCatVodConfig } from "../src/core/catvod/catvod-config-parser.ts";
import { CatVodNodeClient } from "../src/core/catvod/catvod-node-client.ts";
import { SourceAdapterFactory } from "../src/core/source-adapter-factory.ts";

function mockClient() {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/init")) return Response.json({});
    if (url.endsWith("/home")) return Response.json({
      class: [{ type_id: "movie", type_name: "电影" }],
      list: [{ vod_id: "discover-1", vod_name: "庆余年", content_kind: "discovery" }],
    });
    if (url.endsWith("/search")) return Response.json({
      list: [{ vod_id: "playable-1", vod_name: "庆余年", vod_remarks: "全集" }],
    });
    if (url.endsWith("/detail")) return Response.json({
      list: [{
        vod_id: "playable-1",
        vod_name: "庆余年",
        vod_play_from: "线路",
        vod_play_url: "第1集$episode-1",
      }],
    });
    if (url.endsWith("/play")) return Response.json({ parse: 0, url: "https://media.example.com/video.m3u8" });
    if (url.endsWith("/health")) return Response.json({ ok: true });
    return new Response(`unhandled ${url} ${init?.method ?? "GET"}`, { status: 404 });
  };
  return new CatVodNodeClient({ baseUrl: () => "http://127.0.0.1:9988", fetchImpl });
}

test("clearing an empty CatVod config preserves ordinary user playback sources", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "catvod-empty-preserve-"));
  const configPath = path.join(temp, "config.json");
  await writeFile(configPath, JSON.stringify({
    sites: [{ key: "ordinary", name: "普通播放源", type: 1, api: "https://example.com/api", searchable: 1 }],
  }));
  const service = new AppService(path.join(temp, "test.sqlite"), new SourceAdapterFactory({ catVodClient: mockClient() }));
  try {
    await service.loadConfig(configPath, "普通配置");
    await service.setDynamicSites(parseCatVodConfig({ video: { sites: [{ key: "node", name: "CatVod 源", api: "/spider/node/3" }] } }).sites);
    assert.deepEqual(service.listSites().map((site) => site.key).sort(), ["catvod:node", "ordinary"]);

    await service.setDynamicSites(parseCatVodConfig({ video: { sites: [] } }).sites);
    assert.deepEqual(service.listSites().map((site) => site.key), ["ordinary"]);
  } finally {
    service.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("AppService registers CatVod dynamic sites without a user config and uses discovery home", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "catvod-app-service-"));
  const service = new AppService(path.join(temp, "test.sqlite"), new SourceAdapterFactory({ catVodClient: mockClient() }));
  try {
    const parsed = parseCatVodConfig({
      video: {
        sites: [
          { key: "nodejs_douban", name: "豆瓣|首页", api: "/spider/douban/3", searchable: 1 },
          { key: "nodejs_demo", name: "示例|秒播", api: "/spider/demo/3", searchable: 1 },
          { key: "nodejs_baseset", name: "配置|中心", api: "/spider/baseset/3" },
        ],
      },
    });
    await service.setDynamicSites(parsed.sites);
    const listed = service.listSites();
    assert.equal(listed.length, 3);
    assert.equal(listed.find((site) => site.key === "catvod:nodejs_baseset")?.hide, 1);

    const home = await service.bestHome();
    assert.equal(home.siteKey, "catvod:nodejs_douban");
    assert.equal(home.list[0]?.contentKind, "discovery");

    const search = await service.searchDetailed("庆余年", undefined, "all-configs");
    assert.equal(search.list.length, 1);
    assert.equal(search.list[0]?.siteKey, "catvod:nodejs_demo");
    const detail = await service.detail("catvod:nodejs_demo", "playable-1");
    assert.equal(detail.flags[0]?.episodes[0]?.url, "episode-1");
    const resolved = await service.resolve("catvod:nodejs_demo", "线路", "episode-1");
    assert.equal(resolved.url, "https://media.example.com/video.m3u8");
  } finally {
    service.close();
    await rm(temp, { recursive: true, force: true });
  }
});
