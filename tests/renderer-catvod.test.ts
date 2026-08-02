import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const preloadPath = new URL("../src/desktop/preload.ts", import.meta.url);
const mainPath = new URL("../src/desktop/main.ts", import.meta.url);
const playerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const prototypePath = new URL("../docs/prototypes/CatVod 播放源管理与来源选择器原型.html", import.meta.url);

test("renderer exposes CatVod source home category filters pagination and discovery routing", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    "loadSourceHome",
    "loadLibraryCategoryPage",
    "changeLibraryFilter",
    "loadMoreLibrary",
    "searchDiscovery",
    "resolveContentRoute",
    "openCatVodWebsite",
    "activateCatVodUpdate",
    "rollbackCatVod",
  ]) assert.ok(source.includes(marker), `missing renderer marker: ${marker}`);
  assert.match(source, /category\.id/);
  assert.match(source, /libraryFilters\[group\.key\]/);
  assert.ok(source.includes("sourceCategories.length === 1 ? { ...libraryFilters.value } : {}"), "library filters must cross IPC as a plain object, not a Vue proxy");
  assert.match(source, /action === "serviceUpdated"[\s\S]*await startSourceAudit\(false\)/);

});

test("preload and main keep CatVod service control behind isolated IPC", async () => {
  const [preload, main] = await Promise.all([readFile(preloadPath, "utf8"), readFile(mainPath, "utf8")]);
  for (const marker of [
    "getCatVodStatus",
    "startCatVod",
    "inspectCatVodUpdate",
    "checkCatVodUpdate",
    "activateCatVodUpdate",
    "openCatVodWebsite",
    "onCatVodHostEvent",
  ]) assert.ok(preload.includes(marker), `missing preload marker: ${marker}`);
  assert.ok(main.includes("catvod-bootstrap.cjs"));
  assert.ok(main.includes("setHostMessageHandler"));
  assert.ok(main.includes("contextIsolation: true"));
  assert.ok(main.includes("nodeIntegration: false"));
  assert.ok(main.includes("sandbox: true"));
  assert.ok(main.includes("countBySitePrefix(CATVOD_SITE_PREFIX)"));
  assert.ok(main.includes("请先关闭播放器后再操作服务"));
  assert.ok(main.includes("catVodRemoteAccessPolicy"));
  assert.ok(preload.includes("block-startup"));
  assert.ok(main.includes("FONGMI_E2E_DISABLE_CATVOD"));
});

test("embedded player exposes CatVod subtitle track without bypassing the media session", async () => {
  const player = await readFile(playerPath, "utf8");
  assert.ok(player.includes("session.subtitleUrl"));
  assert.ok(player.includes('kind="subtitles"'));
  assert.ok(player.includes(":src=\"session.subtitleUrl\""));
});

test("confirmed quick source prototype is implemented in the formal renderer", async () => {
  const [source, prototype] = await Promise.all([readFile(appPath, "utf8"), readFile(prototypePath, "utf8")]);
  for (const marker of [
    "source-picker-trigger",
    "source-picker-panel",
    "sourcePickerQuery",
    "sourcePickerFilter",
    "quick-source-page",
    "quick-source-search",
    "recentSourceKeys",
    "favoriteSourceKeys",
    "toggleSourceFavorite",
    "收藏来源",
    "selectSource(site.key)",
    "内容来源",
    "添加内容配置",
    "检查并修复",
    "inferConfigName",
    "loadMoreSearch",
    "searchHasMore",
    "searchAlternativeSources",
    "查找其他来源",
    "启动阶段远程访问策略",
    "catVodRemoteAccessPolicy",
    "catVodStatus.remoteAccesses",
    "catVodUpdateStrategy",
    "inspectCatVodUpdate",
    "仅提示，不下载候选或自动切换",
    "候选测试通过后自动激活",
  ]) assert.ok(source.includes(marker), `missing quick source marker: ${marker}`);
  const sourcePageIndex = source.indexOf("<section v-else-if=\"page === 'sources'\"");
  const configManagementIndex = source.indexOf("添加内容配置", sourcePageIndex);
  const settingsPageIndex = source.indexOf("<section v-else-if=\"page === 'settings'\"");
  assert.ok(sourcePageIndex >= 0 && configManagementIndex > sourcePageIndex && configManagementIndex < settingsPageIndex, "source configuration management must live on the content sources page");
  assert.equal(source.match(/添加内容配置/g)?.length, 1, "source configuration must have a single user-facing entry");
  assert.ok(source.includes('setSetting("recentSiteKeys", [...recentSourceKeys.value])'), "recent source persistence must pass a cloneable plain array over IPC");
  assert.ok(source.includes('setSetting("favoriteSourceKeys", [...favoriteSourceKeys.value])'), "favorite source persistence must pass a cloneable plain array over IPC");
  assert.ok(source.includes("restoringInitialSite"), "initial source restore must not overwrite the saved default site");
  assert.ok(source.includes("activeSourcePackageSites.value"), "source picker and source page must stay within the active source package");
  assert.ok(source.includes("pendingSourceImport.value = request"), "imports during playback must be queued instead of interrupting playback");
  assert.ok(source.includes("await applyPendingSourceImport()"), "queued source imports must activate after playback closes or ends");
  assert.ok(source.includes("stopPlaybackAndApplyPendingSource"), "the player must expose an explicit immediate-switch action");
  assert.ok(!source.includes("播放源状态</h2>"), "quick source page must not expose diagnostic details");
  assert.ok(prototype.includes("选择播放源"));
  assert.ok(prototype.includes("最近使用"));
  assert.ok(prototype.includes("仅展示可用影视来源"));
});
