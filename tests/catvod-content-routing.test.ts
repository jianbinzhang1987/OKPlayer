import assert from "node:assert/strict";
import test from "node:test";
import { resolveContentRoute } from "../src/desktop/renderer/app-model.ts";

test("CatVod content kinds route to the correct desktop behavior", () => {
  assert.equal(resolveContentRoute({ contentKind: "playable" }), "detail");
  assert.equal(resolveContentRoute({ contentKind: "discovery" }), "search");
  assert.equal(resolveContentRoute({ contentKind: "action" }), "settings");
  assert.equal(resolveContentRoute({ contentKind: "live" }), "live-unsupported");
  assert.equal(resolveContentRoute({ contentKind: "folder" }), "folder");
});

test("legacy vod tags remain compatible with folder and action routing", () => {
  assert.equal(resolveContentRoute({ vodTag: "folder" }), "folder");
  assert.equal(resolveContentRoute({ vodTag: "action" }), "settings");
  assert.equal(resolveContentRoute({ vodTag: "file" }), "detail");
  assert.equal(resolveContentRoute(undefined), "detail");
});
