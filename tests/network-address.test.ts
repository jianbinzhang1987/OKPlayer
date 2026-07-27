import assert from "node:assert/strict";
import test from "node:test";
import { isNonPublicAddress, isProxyFakeAddress, isUnsafeResolvedAddress } from "../src/core/network-address.ts";

test("network policy distinguishes proxy fake IPs from real private addresses", () => {
  assert.equal(isProxyFakeAddress("198.18.0.48"), true);
  assert.equal(isProxyFakeAddress("198.19.255.254"), true);
  assert.equal(isProxyFakeAddress("fdfe:dcba:9876::3a"), true);
  assert.equal(isNonPublicAddress("198.18.0.48"), true);
  assert.equal(isNonPublicAddress("fdfe:dcba:9876::3a"), true);
  assert.equal(isUnsafeResolvedAddress("198.18.0.48"), false);
  assert.equal(isUnsafeResolvedAddress("fdfe:dcba:9876::3a"), false);

  assert.equal(isUnsafeResolvedAddress("192.168.1.10"), true);
  assert.equal(isUnsafeResolvedAddress("10.0.0.1"), true);
  assert.equal(isUnsafeResolvedAddress("fd00::1"), true);
  assert.equal(isNonPublicAddress("8.8.8.8"), false);
});
