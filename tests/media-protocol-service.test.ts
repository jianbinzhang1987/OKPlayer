import test from "node:test";
import assert from "node:assert/strict";
import { resolveCatVodRuntimeUrl } from "../src/core/catvod/catvod-url-rewriter.ts";
import { MediaProtocolService, parseMediaProtocolUrl, type MediaFetch } from "../src/desktop/media-protocol/media-protocol-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";

test("media protocol forwards protected headers and byte ranges", async () => {
  const calls: Array<{ input: string; headers: Headers; method?: string }> = [];
  const fetchMedia: MediaFetch = async (input, init) => {
    calls.push({ input, headers: new Headers(init?.headers), method: init?.method });
    return new Response(new Uint8Array(128), {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-127/1024",
        "accept-ranges": "bytes",
      },
    });
  };
  const sessions = new PlaybackSessionStore();
  const session = sessions.create({
    url: "https://cdn.example.com/video.mp4",
    headers: { Referer: "https://player.example.com/", Cookie: "sid=secret", "X-Token": "abc" },
    format: "mp4",
    resolvedBy: "direct",
  });
  const service = new MediaProtocolService(sessions, fetchMedia);
  const response = await service.handle(new Request(sessions.playbackUrl(session.id), {
    headers: {
      Range: "bytes=0-127",
      "If-Range": "etag-1",
      "If-None-Match": "stale-etag",
      "If-Modified-Since": "Sat, 01 Aug 2026 00:00:00 GMT",
      Host: "malicious.invalid",
    },
  }));

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-127/1024");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "https://cdn.example.com/video.mp4");
  assert.equal(calls[0]?.headers.get("range"), "bytes=0-127");
  assert.equal(calls[0]?.headers.get("if-range"), "etag-1");
  assert.equal(calls[0]?.headers.get("if-none-match"), null);
  assert.equal(calls[0]?.headers.get("if-modified-since"), null);
  assert.equal(calls[0]?.headers.get("referer"), "https://player.example.com/");
  assert.equal(calls[0]?.headers.get("cookie"), "sid=secret");
  assert.equal(calls[0]?.headers.get("x-token"), "abc");
  assert.equal(calls[0]?.headers.get("host"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
});

test("media protocol strips source cache validators from protected range requests", async () => {
  const sessions = new PlaybackSessionStore();
  const session = sessions.create({
    url: "https://cdn.example.com/video.mkv",
    headers: {
      Cookie: "sid=secret",
      "If-None-Match": "source-etag",
      "If-Modified-Since": "Sat, 01 Aug 2026 00:00:00 GMT",
    },
    format: "mkv",
    resolvedBy: "direct",
  });
  let forwarded = new Headers();
  const service = new MediaProtocolService(sessions, async (_url, init) => {
    forwarded = new Headers(init?.headers);
    return new Response(new Uint8Array([1]), {
      status: 206,
      headers: {
        etag: "upstream-etag",
        "last-modified": "Sat, 01 Aug 2026 00:00:00 GMT",
        "content-range": "bytes 0-0/1",
      },
    });
  });

  const response = await service.handle(new Request(sessions.playbackUrl(session.id), {
    headers: { Range: "bytes=0-0", "If-None-Match": "player-etag" },
  }));

  assert.equal(forwarded.get("range"), "bytes=0-0");
  assert.equal(forwarded.get("cookie"), "sid=secret");
  assert.equal(forwarded.get("if-none-match"), null);
  assert.equal(forwarded.get("if-modified-since"), null);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("media protocol forwards independent seek ranges and HEAD without mixing session credentials", async () => {
  const calls: Array<{ url: string; method: string; range: string | null; cookie: string | null }> = [];
  const sessions = new PlaybackSessionStore();
  const first = sessions.create({
    url: "https://cdn.example.com/first.mp4",
    headers: { Cookie: "sid=first" },
    format: "mp4",
    resolvedBy: "direct",
  });
  const second = sessions.create({
    url: "https://cdn.example.com/second.mp4",
    headers: { Cookie: "sid=second" },
    format: "mp4",
    resolvedBy: "direct",
  });
  const service = new MediaProtocolService(sessions, async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, method: String(init?.method), range: headers.get("range"), cookie: headers.get("cookie") });
    const range = headers.get("range") ?? "bytes=0-0";
    return new Response(init?.method === "HEAD" ? null : new Uint8Array([1]), {
      status: range === "bytes=0-0" ? 200 : 206,
      headers: range === "bytes=0-0" ? { "content-length": "1024" } : { "content-range": `${range.replace("=", " ")}/1024` },
    });
  });

  await service.handle(new Request(sessions.playbackUrl(first.id), { headers: { Range: "bytes=100-199" } }));
  await service.handle(new Request(sessions.playbackUrl(first.id), { headers: { Range: "bytes=700-799" } }));
  await service.handle(new Request(sessions.playbackUrl(second.id), { method: "HEAD" }));

  assert.deepEqual(calls, [
    { url: "https://cdn.example.com/first.mp4", method: "GET", range: "bytes=100-199", cookie: "sid=first" },
    { url: "https://cdn.example.com/first.mp4", method: "GET", range: "bytes=700-799", cookie: "sid=first" },
    { url: "https://cdn.example.com/second.mp4", method: "HEAD", range: null, cookie: "sid=second" },
  ]);
});

test("media protocol resolves stale CatVod proxy URLs against the current dynamic port", async () => {
  let activeBaseUrl = "http://127.0.0.1:52010";
  const calls: string[] = [];
  const sessions = new PlaybackSessionStore();
  const session = sessions.create({
    url: "http://127.0.0.1:51999/proxy/session/video.mp4",
    headers: { Referer: "https://pan.example.com" },
    format: "mp4",
    resolvedBy: "direct",
  });
  const service = new MediaProtocolService(
    sessions,
    async (url) => {
      calls.push(url);
      return new Response(new Uint8Array([1]), { status: 206, headers: { "content-range": "bytes 0-0/1" } });
    },
    (url) => resolveCatVodRuntimeUrl(url, activeBaseUrl),
  );

  await service.handle(new Request(sessions.playbackUrl(session.id), { headers: { Range: "bytes=0-0" } }));
  activeBaseUrl = "http://127.0.0.1:52012";
  await service.handle(new Request(sessions.playbackUrl(session.id), { headers: { Range: "bytes=0-0" } }));
  assert.deepEqual(calls, [
    "http://127.0.0.1:52010/proxy/session/video.mp4",
    "http://127.0.0.1:52012/proxy/session/video.mp4",
  ]);
});

test("media protocol rewrites HLS children and resolves them only through the session map", async () => {
  const calls: string[] = [];
  const fetchMedia: MediaFetch = async (input, init) => {
    calls.push(input);
    if (input.endsWith("master.m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.bin\"\nsegments/1.ts\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    assert.equal(new Headers(init?.headers).get("referer"), "https://player.example.com/");
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": input.endsWith("key.bin") ? "application/octet-stream" : "video/mp2t" },
    });
  };

  const sessions = new PlaybackSessionStore();
  const session = sessions.create({
    url: "https://cdn.example.com/path/master.m3u8",
    headers: { Referer: "https://player.example.com/" },
    format: "hls",
    resolvedBy: "direct",
  });
  const service = new MediaProtocolService(sessions, fetchMedia);
  const manifestResponse = await service.handle(new Request(sessions.playbackUrl(session.id)));
  const manifest = await manifestResponse.text();
  const internalUrls = manifest.match(/fongmi-media:\/\/session\/[^"\n,]+/g) ?? [];

  assert.equal(internalUrls.length, 2);
  assert.doesNotMatch(manifest, /cdn\.example\.com/);
  const keyRoute = parseMediaProtocolUrl(internalUrls[0]!);
  const segmentRoute = parseMediaProtocolUrl(internalUrls[1]!);
  assert.equal(keyRoute.sessionId, session.id);
  assert.equal(segmentRoute.sessionId, session.id);

  const keyResponse = await service.handle(new Request(internalUrls[0]!));
  const segmentResponse = await service.handle(new Request(internalUrls[1]!));
  assert.deepEqual([...new Uint8Array(await keyResponse.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await segmentResponse.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(calls, [
    "https://cdn.example.com/path/master.m3u8",
    "https://cdn.example.com/path/keys/key.bin",
    "https://cdn.example.com/path/segments/1.ts",
  ]);
});

test("media protocol rejects unknown resources and non-read methods", async () => {
  const sessions = new PlaybackSessionStore();
  const service = new MediaProtocolService(sessions, async () => {
    throw new Error("network should not be called");
  });
  const post = await service.handle(new Request("fongmi-media://session/a/resource/root", { method: "POST" }));
  assert.equal(post.status, 405);
  const missing = await service.handle(new Request("fongmi-media://session/a/resource/root"));
  assert.equal(missing.status, 404);
});
