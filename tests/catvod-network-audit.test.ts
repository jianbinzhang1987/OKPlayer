import assert from "node:assert/strict";
import test from "node:test";
import {
  createCatVodNetworkAuditEvent,
  normalizeCatVodRemoteAccessPolicy,
  requestMethodFromNodeArgs,
  requestUrlFromNodeArgs,
} from "../src/desktop/catvod-network-audit.ts";

test("CatVod startup network audit keeps only origin and strips credentials query and path", () => {
  const access = createCatVodNetworkAuditEvent(
    "https://user:password@example.com:8443/remote/config.json?token=secret#part",
    "post",
    "allow",
    true,
    123,
  );

  assert.deepEqual(access, {
    origin: "https://example.com:8443",
    method: "POST",
    phase: "startup",
    blocked: false,
    at: 123,
  });
  assert.equal(JSON.stringify(access).includes("secret"), false);
  assert.equal(JSON.stringify(access).includes("password"), false);
  assert.equal(JSON.stringify(access).includes("config.json"), false);
});

test("CatVod startup audit ignores loopback and respects blocking policy", () => {
  assert.equal(createCatVodNetworkAuditEvent("http://127.0.0.1:1234/config", "GET", "allow", true), undefined);
  assert.equal(createCatVodNetworkAuditEvent("http://localhost:1234/config", "GET", "allow", true), undefined);
  assert.equal(createCatVodNetworkAuditEvent("https://example.com/config", "GET", "allow", false), undefined);
  assert.equal(createCatVodNetworkAuditEvent("https://example.com/config", "GET", "block-startup", true)?.blocked, true);
  assert.equal(normalizeCatVodRemoteAccessPolicy("block-startup"), "block-startup");
  assert.equal(normalizeCatVodRemoteAccessPolicy("anything"), "allow");
});

test("CatVod Node http request arguments are normalized for audit", () => {
  assert.equal(requestUrlFromNodeArgs("https:", [{ hostname: "api.example.com", port: 9443, path: "/config?token=x" }]), "https://api.example.com:9443/config?token=x");
  assert.equal(requestMethodFromNodeArgs([{ hostname: "api.example.com", method: "post" }]), "POST");
  const event = createCatVodNetworkAuditEvent(
    requestUrlFromNodeArgs("https:", [{ hostname: "api.example.com", port: 9443, path: "/config?token=x" }]),
    requestMethodFromNodeArgs([{ hostname: "api.example.com", method: "post" }]),
    "allow",
    true,
  );
  assert.equal(event?.origin, "https://api.example.com:9443");
});
