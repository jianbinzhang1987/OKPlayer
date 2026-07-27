import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const preloadPath = new URL("../src/desktop/preload.ts", import.meta.url);
const ipcPath = new URL("../src/desktop/register-ipc.ts", import.meta.url);

test("renderer exposes replacement registry import clear and source attribution", async () => {
  const [app, preload, ipc] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(ipcPath, "utf8"),
  ]);

  assert.match(app, /替代 Provider 注册表/);
  assert.match(app, /@click="applyReplacementRegistry"/);
  assert.match(app, /@click="clearReplacementRegistry"/);
  assert.match(app, /替代 Provider：\{\{ site\.replacement\?\.sourceName \}\}/);
  assert.match(preload, /loadReplacementRegistry/);
  assert.match(preload, /clearReplacementRegistry/);
  assert.match(ipc, /replacement-registry:load/);
  assert.match(ipc, /replacement-registry:clear/);
});
