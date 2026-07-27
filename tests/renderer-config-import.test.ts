import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);

test("config import handlers explicitly call loadConfig without forwarding DOM events", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /@keyup\.enter="loadConfig\(\)"/);
  assert.match(source, /@click="loadConfig\(\)"/);
  assert.doesNotMatch(source, /@keyup\.enter="loadConfig"\s/);
  assert.doesNotMatch(source, /@click="loadConfig"\s/);
});
