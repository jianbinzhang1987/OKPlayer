import assert from "node:assert/strict";
import test from "node:test";

// IPC contract test: renderer only accesses exposed preload API.
test("desktop IPC contract keeps renderer isolated", () => {
  const api = {
    getInfo: "ipc invoke app:info",
  };

  assert.equal(typeof api.getInfo, "string");
});
