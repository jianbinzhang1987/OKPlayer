import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);

test("content source lists share the quality ranking strategy", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    "sortSourcesByQuality",
    "sourceStatusText",
    "activeSiteKey: activeSite.value",
    "recentSiteKeys: recentSourceKeys.value",
    "最近播放成功",
    "推荐来源",
    "搜索表现",
    "响应速度",
  ]) assert.ok(source.includes(marker), `missing source ranking marker: ${marker}`);
});

test("expanded search explains quality-first source scheduling", async () => {
  const source = await readFile(appPath, "utf8");
  assert.ok(source.includes("已按质量优先搜索更多来源"));
  assert.ok(source.includes("全部内容来源"));
});
