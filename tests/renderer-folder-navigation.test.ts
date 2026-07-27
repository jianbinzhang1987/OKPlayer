import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const stylesPath = new URL("../src/desktop/renderer/styles.css", import.meta.url);

test("renderer provides folder breadcrumb navigation and account-aware recovery copy", async () => {
  const [app, styles] = await Promise.all([readFile(appPath, "utf8"), readFile(stylesPath, "utf8")]);
  for (const marker of [
    "folderTrail",
    "openFolder",
    "openFolderTrail",
    "backFolder",
    "folderAccessMessage",
    "folderNeedsPanLogin",
    "pendingPanFolder",
    "loadMoreFolder",
    "folderQuery",
    "folderSort",
    "folderHasMore",
    "folderItemTypeLabel",
    "isSubtitleFolderItem",
    "网盘登录状态可能已失效",
    "登录成功，正在重新打开目录",
    "搜索当前目录",
    "按类型",
    "返回上级",
    "folder-breadcrumb",
    "folder-toolbar",
    "文件夹会继续进入目录",
  ]) assert.ok(app.includes(marker), `missing folder navigation marker: ${marker}`);
  assert.ok(app.includes("window.tvApi.category(item.siteKey, item.vodId"));
  assert.ok(app.includes("folderTrail.value.slice(0, index + 1)"));
  assert.ok(app.includes("String(pageNumber)"));
  assert.ok(app.includes("dedupeLibraryItems([...results.value, ...incoming], { includeFolders: true })"));
  assert.ok(app.includes("folderPage.value + 1"));
  assert.ok(styles.includes(".folder-breadcrumb"));
  assert.ok(styles.includes(".folder-toolbar"));
});
