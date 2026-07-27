import assert from "node:assert/strict";
import test from "node:test";
import { classifyCatVodSite, parseCatVodConfig } from "../src/core/catvod/catvod-config-parser.ts";

test("parseCatVodConfig converts local API paths into dynamic CatVod sites", () => {
  const parsed = parseCatVodConfig({
    video: {
      sites: [
        { key: "nodejs_douban", name: "豆瓣|首页", type: 3, api: "/spider/douban/3", searchable: 1, filterable: 1 },
        { key: "nodejs_wogg", name: "玩偶|4K", type: 3, api: "/spider/wogg/3", searchable: 1, filterable: 1 },
        { key: "nodejs_huya", name: "虎牙|直播", type: 3, api: "/spider/huya/3" },
        { key: "nodejs_music", name: "小酷|音乐", type: 3, api: "/spider/music/3" },
        { key: "nodejs_baseset", name: "配置|中心", type: 3, api: "/spider/baseset/3" },
      ],
    },
  });

  assert.equal(parsed.summary.siteCount, 5);
  assert.equal(parsed.summary.discoveryCount, 1);
  assert.equal(parsed.summary.vodCount, 1);
  assert.equal(parsed.summary.hiddenCount, 3);
  assert.deepEqual(parsed.sites.map((site) => [site.key, site.type, site.api, site.contentType, site.hide]), [
    ["catvod:nodejs_douban", 15, "catvod://service/spider/douban/3", "discovery", 0],
    ["catvod:nodejs_wogg", 15, "catvod://service/spider/wogg/3", "vod", 0],
    ["catvod:nodejs_huya", 15, "catvod://service/spider/huya/3", "live", 1],
    ["catvod:nodejs_music", 15, "catvod://service/spider/music/3", "audio", 1],
    ["catvod:nodejs_baseset", 15, "catvod://service/spider/baseset/3", "tool", 1],
  ]);
});

test("parseCatVodConfig tolerates invalid entries and de-duplicates keys", () => {
  const parsed = parseCatVodConfig({
    video: {
      sites: [
        null,
        { key: "", name: "missing", api: "/spider/a" },
        { key: "same", name: "A", api: "/spider/a" },
        { key: "same", name: "B", api: "/spider/b" },
      ],
    },
  });
  assert.deepEqual(parsed.sites.map((site) => site.key), ["catvod:same", "catvod:same:2"]);
});

test("parseCatVodConfig returns a stable empty result for missing or empty site lists", () => {
  for (const input of [{}, { video: {} }, { video: { sites: [] } }, { sites: [] }]) {
    const parsed = parseCatVodConfig(input);
    assert.deepEqual(parsed.sites, []);
    assert.deepEqual(parsed.summary, { siteCount: 0, discoveryCount: 0, vodCount: 0, hiddenCount: 0 });
  }
});

test("classifyCatVodSite identifies major content categories", () => {
  assert.equal(classifyCatVodSite("douban", "豆瓣首页"), "discovery");
  assert.equal(classifyCatVodSite("baseset", "配置中心"), "tool");
  assert.equal(classifyCatVodSite("douyu", "斗鱼直播"), "live");
  assert.equal(classifyCatVodSite("duanjuxingya", "短剧星芽"), "short-drama");
  assert.equal(classifyCatVodSite("manjuqimao", "漫剧小猫"), "comic");
  assert.equal(classifyCatVodSite("musicaikuwoa", "小酷音乐"), "audio");
  assert.equal(classifyCatVodSite("biliych", "哔哩歌曲"), "audio");
  assert.equal(classifyCatVodSite("wogg", "玩偶4K"), "vod");
});
