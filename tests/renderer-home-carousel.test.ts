import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const stylesPath = new URL("../src/desktop/renderer/styles.css", import.meta.url);

test("home hero is a filtered multi-item carousel rather than a single first item", async () => {
  const [source, styles] = await Promise.all([readFile(appPath, "utf8"), readFile(stylesPath, "utf8")]);
  for (const marker of [
    "homeRecommendations",
    "selectHomeRecommendations",
    "最近热播",
    "hero-carousel-controls",
    "hero-dots",
    "moveHero(-1)",
    "moveHero(1)",
    "setHeroHovered(true)",
    "handleHeroWindowBlur",
    "6_000",
    "12_000",
  ]) assert.ok(source.includes(marker) || styles.includes(marker), `missing carousel marker: ${marker}`);
  assert.ok(!source.includes("const hero = computed(() => homeItems.value[0]"));
});

test("home separates continuing playback from movie and series recommendations", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    "继续观看",
    "电影推荐",
    "电视剧推荐",
    "homeMovieItems",
    "homeTvItems",
    "continueIdentitySet",
    "分类与收藏",
  ]) assert.ok(source.includes(marker), `missing home section marker: ${marker}`);
  assert.ok(source.indexOf("继续观看") < source.indexOf("电影推荐"));
  assert.ok(source.indexOf("电影推荐") < source.indexOf("分类与收藏"));
});

test("carousel preference is persisted in ordinary appearance settings", async () => {
  const source = await readFile(appPath, "utf8");
  assert.ok(source.includes("首页推荐自动轮播"));
  assert.ok(source.includes('setSetting("homeCarouselEnabled"'));
  assert.ok(source.includes('getSetting("homeCarouselEnabled", true)'));
});
