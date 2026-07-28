import assert from "node:assert/strict";
import test from "node:test";
import { makeSerializableSetting, settingValuesEqual } from "../src/desktop/renderer/settings-persistence.ts";

test("settings payload converts Vue-like proxies into cloneable plain data", () => {
  const raw = {
    opacity: 0.8,
    blockedWords: ["广告", "剧透"],
    nested: { enabled: true },
  };
  const proxied = new Proxy(raw, {});
  const result = makeSerializableSetting(proxied);

  assert.deepEqual(result, raw);
  assert.notEqual(result, proxied);
  assert.equal(settingValuesEqual(result, raw), true);
});

test("settings read-back comparison detects changed persisted values", () => {
  assert.equal(settingValuesEqual({ theme: "light" }, { theme: "light" }), true);
  assert.equal(settingValuesEqual({ theme: "light" }, { theme: "dark" }), false);
});
