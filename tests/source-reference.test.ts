import assert from "node:assert/strict";
import test from "node:test";
import { decodeSourceReference, encodeSourceReference, isSourceReference } from "../src/core/source-reference.ts";

test("source references preserve config source and duplicate site keys", () => {
  const source = "https://example.com/配置一.json?token=a:b";
  const siteKey = "同名源:影视";
  const encoded = encodeSourceReference(source, siteKey);

  assert.equal(isSourceReference(encoded), true);
  assert.deepEqual(decodeSourceReference(encoded), { configSource: source, siteKey });
  assert.equal(decodeSourceReference("ordinary-site"), undefined);
});

test("source references reject malformed payloads", () => {
  assert.throws(() => decodeSourceReference("cfg:broken"), /来源引用格式无效/);
  assert.throws(() => encodeSourceReference("", "site"), /缺少配置地址/);
});
