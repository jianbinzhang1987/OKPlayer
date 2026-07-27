import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLibraryCategoryGroups,
  classifyLibraryCategory,
  dedupeLibraryItems,
  isLibraryMediaItem,
  sortLibraryItems,
} from "../src/desktop/renderer/library-category.ts";

test("source categories map into stable user-facing library categories", () => {
  assert.equal(classifyLibraryCategory({ id: "13", name: "国产剧" }), "tv");
  assert.equal(classifyLibraryCategory({ id: "14", name: "连续剧" }), "tv");
  assert.equal(classifyLibraryCategory({ id: "1", name: "最新电影" }), "movie");
  assert.equal(classifyLibraryCategory({ id: "4", name: "国漫番剧" }), "anime");
  assert.equal(classifyLibraryCategory({ id: "5", name: "真人秀综艺" }), "variety");
  assert.equal(classifyLibraryCategory({ id: "6", name: "人文纪录片" }), "documentary");
  assert.equal(classifyLibraryCategory({ id: "7", name: "少儿启蒙" }), "kids");
  assert.equal(classifyLibraryCategory({ id: "8", name: "体育赛事" }), "more");
});

test("login configuration tools and live channels are excluded from the library", () => {
  for (const name of ["夸克扫码登录", "配置中心", "实用工具", "电视直播", "网盘目录"]) {
    assert.equal(classifyLibraryCategory({ id: name, name }), "hidden");
  }
});

test("library category groups keep uncertain original names under more", () => {
  const groups = buildLibraryCategoryGroups([
    { id: "movie", name: "高清电影" },
    { id: "tv-cn", name: "国产剧" },
    { id: "tv-kr", name: "韩剧" },
    { id: "sports", name: "体育赛事" },
    { id: "login", name: "扫码登录" },
  ]);

  assert.deepEqual(groups.map((group) => group.name), ["全部", "电影", "电视剧", "更多分类"]);
  assert.deepEqual(groups.find((group) => group.id === "tv")?.sourceCategories.map((item) => item.name), ["国产剧", "韩剧"]);
  assert.deepEqual(groups.find((group) => group.id === "more")?.sourceCategories.map((item) => item.name), ["体育赛事"]);
});

test("library media filtering removes folders actions discovery and live entries", () => {
  assert.equal(isLibraryMediaItem({ vodId: "1", vodName: "正常影片" }), true);
  assert.equal(isLibraryMediaItem({ vodId: "2", vodName: "目录", vodTag: "folder" }), false);
  assert.equal(isLibraryMediaItem({ vodId: "3", vodName: "登录夸克", contentKind: "action" }), false);
  assert.equal(isLibraryMediaItem({ vodId: "4", vodName: "电视台", contentKind: "live" }), false);
  assert.equal(isLibraryMediaItem({ vodId: "5", vodName: "查找资源", contentKind: "discovery" }), false);
});

test("pan library mode preserves folders and files while still excluding actions", () => {
  const items = dedupeLibraryItems([
    { siteKey: "pan", vodId: "folder-1", vodName: "家庭影音", vodTag: "folder", contentKind: "folder" },
    { siteKey: "pan", vodId: "video-1", vodName: "旅行.mp4", vodTag: "file", contentKind: "playable" },
    { siteKey: "pan", vodId: "action-1", vodName: "登录网盘", vodTag: "action", contentKind: "action" },
  ], { includeFolders: true });
  assert.deepEqual(items.map((item) => item.vodName), ["家庭影音", "旅行.mp4"]);
});

test("library results deduplicate media and expose only truthful sorting", () => {
  const items = dedupeLibraryItems([
    { siteKey: "s", vodId: "1", vodName: "乙影片", vodRemarks: "热播" },
    { siteKey: "s", vodId: "1", vodName: "乙影片", vodRemarks: "热播" },
    { siteKey: "s", vodId: "2", vodName: "甲影片" },
    { siteKey: "s", vodId: "3", vodName: "配置中心", contentKind: "action" },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(sortLibraryItems(items, "来源默认").map((item) => item.vodName), ["乙影片", "甲影片"]);
  assert.deepEqual(sortLibraryItems(items, "名称").map((item) => item.vodName), ["甲影片", "乙影片"]);
});
