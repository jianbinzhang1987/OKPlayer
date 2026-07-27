import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const preloadPath = new URL("../src/desktop/preload.ts", import.meta.url);
const ipcPath = new URL("../src/desktop/register-ipc.ts", import.meta.url);

test("renderer and isolated IPC expose incremental search with request generation isolation", async () => {
  const [app, preload, ipc] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(ipcPath, "utf8"),
  ]);

  for (const marker of [
    "startIncrementalSearchPage",
    "handleIncrementalSearchEvent",
    "activeIncrementalSearchRequestId",
    "searchProgress",
    "正在搜索更多来源",
    "正在搜索首批来源",
    "smartInitialSearchSiteKeys",
    "maxSources: 6",
    "excludeSiteKeys",
  ]) assert.ok(app.includes(marker), `missing incremental renderer marker: ${marker}`);

  assert.ok(app.includes("event.requestId !== activeIncrementalSearchRequestId"));
  assert.ok(app.includes("cancelActiveIncrementalSearch()"));
  assert.ok(preload.includes("startIncrementalSearch"));
  assert.ok(preload.includes("cancelIncrementalSearch"));
  assert.ok(preload.includes("onIncrementalSearchEvent"));
  assert.ok(preload.includes("includeSiteKeys"));
  assert.ok(preload.includes("excludeSiteKeys"));
  assert.ok(preload.includes("maxSources"));
  assert.ok(ipc.includes("SEARCH_INCREMENTAL_START"));
  assert.ok(ipc.includes("SEARCH_INCREMENTAL_CANCEL"));
  assert.ok(ipc.includes("SEARCH_INCREMENTAL_EVENT"));
  assert.ok(ipc.includes("activeIncrementalSearchRequestId !== normalizedRequestId"));
  assert.ok(ipc.includes("validateSearchSelection"));
});
