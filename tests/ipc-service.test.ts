import assert from "node:assert/strict";
import test from "node:test";
import { IPC_CHANNELS, validateKeyword } from "../src/desktop/ipc-service.ts";

test("desktop ipc channels are stable", () => {
  assert.equal(IPC_CHANNELS.SEARCH, "vod:search");
  assert.equal(IPC_CHANNELS.RESOLVE, "player:resolve");
});

test("search keyword validation", () => {
  assert.equal(validateKeyword("  test  "), "test");
  assert.throws(() => validateKeyword("   "));
});
