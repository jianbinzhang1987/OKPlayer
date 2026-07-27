import assert from "node:assert/strict";
import test from "node:test";
import {
  groupNormalizedSearchResults,
  mediaTitlesCompatible,
  normalizeSearchTitle,
  rankAlternativeSourceCandidates,
} from "../src/desktop/renderer/search-normalization.ts";

test("search title normalization removes quality source language and year noise", () => {
  assert.equal(normalizeSearchTitle("庆余年 第一季 [4K 高码率 国语中字 2019]"), "庆余年::s1");
  assert.equal(normalizeSearchTitle("庆余年 S01 2160P WEB-DL"), "庆余年::s1");
  assert.equal(normalizeSearchTitle("庆余年 Season 1 · 夸克原画"), "庆余年::s1");
});

test("Chinese season numbers and Arabic season labels normalize consistently", () => {
  assert.equal(normalizeSearchTitle("斗罗大陆 第十二季"), "斗罗大陆::s12");
  assert.equal(normalizeSearchTitle("斗罗大陆 S12"), "斗罗大陆::s12");
});

test("missing years can aggregate while conflicting known years stay separate", () => {
  const base = { vodName: "无间道", typeName: "电影" };
  assert.equal(mediaTitlesCompatible({ ...base, vodYear: "2002" }, base), true);
  assert.equal(mediaTitlesCompatible({ ...base, vodYear: "2002" }, { ...base, vodYear: "2016" }), false);
});

test("normalized groups combine version suffixes without merging different content types", () => {
  const groups = groupNormalizedSearchResults([
    { vodName: "庆余年 第一季 4K", vodYear: "2019", typeName: "电视剧", siteKey: "a" },
    { vodName: "庆余年 S01 国语中字", typeName: "剧集", siteKey: "b" },
    { vodName: "庆余年 第一季", vodYear: "2019", typeName: "电影", siteKey: "c" },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.items.map((item) => item.siteKey), ["a", "b"]);
});

test("alternative source candidates exclude attempted sources and rank exact metadata first", () => {
  const origin = { vodName: "庆余年 第一季 4K", vodYear: "2019", typeName: "电视剧", siteKey: "a" };
  const ranked = rankAlternativeSourceCandidates(origin, [
    { vodName: "庆余年 S01", typeName: "剧集", siteKey: "b", vodId: "2" },
    { vodName: "庆余年 第一季", vodYear: "2019", typeName: "电视剧", siteKey: "c", vodId: "3" },
    { vodName: "庆余年 第一季", vodYear: "2019", typeName: "电视剧", siteKey: "d", vodId: "4" },
    { vodName: "庆余年 第二季", vodYear: "2024", typeName: "电视剧", siteKey: "e", vodId: "5" },
  ], ["d"]);
  assert.deepEqual(ranked.map((item) => item.siteKey), ["c", "b"]);
});
