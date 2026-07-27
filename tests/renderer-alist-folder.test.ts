import assert from "node:assert/strict";
import test from "node:test";
import { isFolderItem } from "../src/desktop/renderer/app-model.ts";

test("renderer distinguishes Alist folders from playable files", () => {
  assert.equal(isFolderItem({ vodId: "/影视/", vodTag: "folder" }), true);
  assert.equal(isFolderItem({ vodId: "/影视/a.mp4", vodTag: "file" }), false);
  assert.equal(isFolderItem({ vodId: "/影视/a.mp4" }), false);
  assert.equal(isFolderItem(null), false);
});
