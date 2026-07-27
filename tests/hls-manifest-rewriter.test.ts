import test from "node:test";
import assert from "node:assert/strict";
import { rewriteHlsManifest, type RegisteredManifestResource } from "../src/desktop/media-protocol/hls-manifest-rewriter.ts";

test("HLS manifest rewrites variants segments keys maps and subtitle resources", () => {
  const resources: RegisteredManifestResource[] = [];
  const manifest = [
    "#EXTM3U",
    "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"中文\",URI=\"subs/zh.m3u8\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=1800000,SUBTITLES=\"subs\"",
    "video/720/index.m3u8?quality=720",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"../keys/key.bin\"",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "segment-0001.ts",
    "https://backup.example.net/segment-0002.ts?token=x",
    "",
  ].join("\n");

  const rewritten = rewriteHlsManifest(
    manifest,
    "https://cdn.example.com/path/master.m3u8?auth=1",
    (resource) => {
      resources.push(resource);
      return `fongmi-media://session/test/resource/r${resources.length}`;
    },
  );

  assert.match(rewritten, /URI="fongmi-media:\/\/session\/test\/resource\/r1"/);
  assert.match(rewritten, /fongmi-media:\/\/session\/test\/resource\/r2/);
  assert.match(rewritten, /URI="fongmi-media:\/\/session\/test\/resource\/r3"/);
  assert.match(rewritten, /URI="fongmi-media:\/\/session\/test\/resource\/r4"/);
  assert.match(rewritten, /fongmi-media:\/\/session\/test\/resource\/r5/);
  assert.match(rewritten, /fongmi-media:\/\/session\/test\/resource\/r6/);
  assert.equal(rewritten.endsWith("\n"), true);

  assert.deepEqual(resources.map((item) => [item.url, item.kind]), [
    ["https://cdn.example.com/path/subs/zh.m3u8", "subtitle"],
    ["https://cdn.example.com/path/video/720/index.m3u8?quality=720", "manifest"],
    ["https://cdn.example.com/keys/key.bin", "key"],
    ["https://cdn.example.com/path/init.mp4", "initialization"],
    ["https://cdn.example.com/path/segment-0001.ts", "segment"],
    ["https://backup.example.net/segment-0002.ts?token=x", "segment"],
  ]);
});

test("HLS manifest preserves non-http resources and comments", () => {
  const manifest = "#EXTM3U\n# comment\ndata:text/plain;base64,AAAA\n";
  const rewritten = rewriteHlsManifest(manifest, "https://cdn.example.com/master.m3u8", () => {
    throw new Error("data URI should not be registered");
  });
  assert.equal(rewritten, manifest);
});
