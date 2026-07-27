import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCatVodRuntimeUrl,
  restoreCatVodTarget,
  rewriteCatVodPayload,
  rewriteCatVodUrl,
} from "../src/core/catvod/catvod-url-rewriter.ts";

test("rewriteCatVodUrl converts local proxy paths to a stable protocol", () => {
  assert.equal(
    rewriteCatVodUrl("http://127.0.0.1:11989/imageProxy?url=https%3A%2F%2Fexample.com%2Fa.jpg"),
    "fongmi-catvod://service/imageProxy?url=https%3A%2F%2Fexample.com%2Fa.jpg",
  );
  assert.equal(rewriteCatVodUrl("/proxy/session/file.ts"), "fongmi-catvod://service/proxy/session/file.ts");
  assert.equal(rewriteCatVodUrl("https://cdn.example.com/video.mp4"), "https://cdn.example.com/video.mp4");
});

test("resolveCatVodRuntimeUrl replaces stale loopback ports for playback", () => {
  assert.equal(
    resolveCatVodRuntimeUrl("http://127.0.0.1:11989/proxy/session/index.m3u8", "http://127.0.0.1:9988"),
    "http://127.0.0.1:9988/proxy/session/index.m3u8",
  );
  assert.equal(resolveCatVodRuntimeUrl("/lrcproxy/sub.vtt", "http://127.0.0.1:9988"), "http://127.0.0.1:9988/lrcproxy/sub.vtt");
  assert.equal(resolveCatVodRuntimeUrl("js2p://_WEB_", "http://127.0.0.1:9988"), "http://127.0.0.1:9988");
});

test("restoreCatVodTarget maps the stable protocol to the active service port", () => {
  assert.equal(
    restoreCatVodTarget("fongmi-catvod://service/proxy/session/index.m3u8?token=x", "http://127.0.0.1:9988"),
    "http://127.0.0.1:9988/proxy/session/index.m3u8?token=x",
  );
});

test("rewriteCatVodPayload rewrites nested media fields without changing unrelated text", () => {
  const result = rewriteCatVodPayload({
    list: [{ vod_pic: "http://localhost:11989/imageProxy?url=x", vod_name: "127.0.0.1 title" }],
    message: "http://127.0.0.1:11989/proxy/not-a-field",
  });
  assert.equal(result.list[0]?.vod_pic, "fongmi-catvod://service/imageProxy?url=x");
  assert.equal(result.list[0]?.vod_name, "127.0.0.1 title");
  assert.equal(result.message, "http://127.0.0.1:11989/proxy/not-a-field");
});
