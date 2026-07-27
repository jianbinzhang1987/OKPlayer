import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);

test("renderer presents a current-source library with unified categories", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    "当前来源片库",
    "切换内容来源",
    "buildLibraryCategoryGroups",
    "selectedLibraryCategory",
    "来源原始分类",
    "dedupeLibraryItems",
  ]) assert.ok(source.includes(marker), `missing library marker: ${marker}`);

  assert.ok(source.includes("['来源默认', '名称'] as const"));
  assert.ok(!source.includes("['最近更新', '热门', '名称'] as const"));
  assert.ok(source.includes("libraryAreas.length > 1"));
  assert.ok(source.includes("libraryYears.length > 1"));
});

test("home quick entries use standardized categories rather than raw first-five categories", async () => {
  const source = await readFile(appPath, "utf8");
  assert.ok(source.includes("libraryCategories.value.filter"));
  assert.ok(source.includes("![\"all\", \"more\"].includes(category.id)"));
  assert.ok(!source.includes("categories.value.slice(0, 5)"));
});
