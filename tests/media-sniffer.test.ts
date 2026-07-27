import assert from "node:assert/strict";
import test from "node:test";
import { forwardMediaHeaders, rankMediaCandidate, rankMediaCandidates } from "../src/core/media-sniffer.ts";

test("media sniffer ranks manifests above files and transport segments", () => {
  const ranked = rankMediaCandidates([
    { url: "https://media.example.com/segment/0001.ts", statusCode: 200, resourceType: "media", mimeType: "video/mp2t" },
    { url: "https://media.example.com/movie.mp4", statusCode: 206, resourceType: "media", mimeType: "video/mp4" },
    { url: "https://media.example.com/master.m3u8?token=abc", statusCode: 200, resourceType: "xhr", mimeType: "application/vnd.apple.mpegurl" },
  ]);

  assert.equal(ranked[0]?.format, "hls");
  assert.match(ranked[0]?.url ?? "", /master\.m3u8/);
  assert.equal(ranked[1]?.format, "mp4");
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("media sniffer accepts signed extensionless media and excludes ads", () => {
  const signed = rankMediaCandidate({
    url: "https://cdn.example.com/playback?token=abc&expires=123",
    statusCode: 200,
    resourceType: "media",
    mimeType: "video/mp4",
  });
  const advertisement = rankMediaCandidate({
    url: "https://ads.example.com/pre-roll.mp4",
    statusCode: 200,
    resourceType: "media",
    mimeType: "video/mp4",
  });

  assert.ok(signed);
  assert.match(signed?.reasons.join(",") ?? "", /signed-url/);
  assert.equal(advertisement, undefined);
});

test("media sniffer deduplicates candidates and supports configured ad filters", () => {
  const ranked = rankMediaCandidates([
    { url: "https://cdn.example.com/main.m3u8", statusCode: 200, resourceType: "xhr" },
    { url: "https://cdn.example.com/main.m3u8", statusCode: 200, resourceType: "media", mimeType: "application/x-mpegurl" },
    { url: "https://cdn.example.com/sponsor/main.m3u8", statusCode: 200, resourceType: "media" },
  ], ["/sponsor/"]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.url, "https://cdn.example.com/main.m3u8");
  assert.match(ranked[0]?.reasons.join(",") ?? "", /mime:hls/);
});

test("media sniffer forwards only playback-relevant request headers", () => {
  assert.deepEqual(forwardMediaHeaders({
    "User-Agent": "Demo/1.0",
    Referer: "https://example.com/watch",
    Cookie: "session=abc",
    Authorization: "Bearer secret",
    "X-Debug": "true",
  }), {
    "User-Agent": "Demo/1.0",
    Referer: "https://example.com/watch",
    Cookie: "session=abc",
  });
});
