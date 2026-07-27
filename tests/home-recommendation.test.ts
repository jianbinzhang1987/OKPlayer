import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHomeContent,
  homeItemIdentity,
  selectHomeRecommendations,
  selectHomeSection,
} from "../src/desktop/renderer/home-recommendation.ts";

test("home recommendations prioritize movies and series and exclude non-content entries", () => {
  const items = [
    { siteKey: "s", vodId: "tool", vodName: "配置中心", contentKind: "action", vodPic: "tool.jpg" },
    { siteKey: "s", vodId: "live", vodName: "电视直播", contentKind: "live", vodPic: "live.jpg" },
    { siteKey: "s", vodId: "folder", vodName: "网盘目录", vodTag: "folder", vodPic: "folder.jpg" },
    { siteKey: "s", vodId: "other", vodName: "体育赛事", typeName: "体育", vodPic: "sport.jpg" },
    { siteKey: "s", vodId: "tv", vodName: "庆余年", typeName: "国产剧", vodPic: "tv.jpg" },
    { siteKey: "s", vodId: "movie", vodName: "流浪地球", typeName: "科幻电影", vodPic: "movie.jpg" },
  ];

  const selected = selectHomeRecommendations(items);
  assert.deepEqual(selected.map((item) => item.vodId), ["tv", "movie", "other"]);
});

test("discovery recommendations remain eligible while continuing items are excluded", () => {
  const discovery = { siteKey: "douban", vodId: "1", vodName: "热播电影", typeName: "电影", contentKind: "discovery", vodPic: "cover.jpg" };
  const continueItem = { siteKey: "s", vodId: "2", vodName: "继续观看剧集", typeName: "电视剧", vodPic: "tv.jpg" };
  const selected = selectHomeRecommendations([discovery, continueItem], {
    excluded: [homeItemIdentity(continueItem)],
  });
  assert.deepEqual(selected.map((item) => item.vodId), ["1"]);
});

test("cached recommendation identity keeps a stable order before new items", () => {
  const items = [
    { siteKey: "s", vodId: "1", vodName: "电影一", typeName: "电影", vodPic: "1.jpg" },
    { siteKey: "s", vodId: "2", vodName: "电视剧二", typeName: "电视剧", vodPic: "2.jpg" },
    { siteKey: "s", vodId: "3", vodName: "电影三", typeName: "电影", vodPic: "3.jpg" },
  ];
  const selected = selectHomeRecommendations(items, {
    cachedOrder: [homeItemIdentity(items[2]!), homeItemIdentity(items[0]!)],
  });
  assert.deepEqual(selected.map((item) => item.vodId), ["3", "1", "2"]);
});

test("home sections split movies and series without duplicating carousel items", () => {
  const items = [
    { siteKey: "s", vodId: "1", vodName: "电影一", typeName: "电影", vodPic: "1.jpg" },
    { siteKey: "s", vodId: "2", vodName: "电视剧二", typeName: "电视剧", vodPic: "2.jpg" },
    { siteKey: "s", vodId: "3", vodName: "短剧三", typeName: "短剧", vodPic: "3.jpg" },
  ];
  assert.equal(classifyHomeContent(items[0]!), "movie");
  assert.equal(classifyHomeContent(items[1]!), "tv");
  assert.deepEqual(selectHomeSection(items, "movie").map((item) => item.vodId), ["1"]);
  assert.deepEqual(selectHomeSection(items, "tv", [homeItemIdentity(items[1]!)]).map((item) => item.vodId), ["3"]);
});
