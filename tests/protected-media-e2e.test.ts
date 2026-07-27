import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { resolveCatVodRuntimeUrl } from "../src/core/catvod/catvod-url-rewriter.ts";
import { MediaProtocolService } from "../src/desktop/media-protocol/media-protocol-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";

const MEDIA_BYTES = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 251));

type ObservedRequest = { url: string; method: string; range: string; cookie: string; referer: string };

async function startMediaFixture() {
  const observed: ObservedRequest[] = [];
  const server = http.createServer((request, response) => {
    const url = request.url ?? "/";
    observed.push({
      url,
      method: request.method ?? "GET",
      range: String(request.headers.range ?? ""),
      cookie: String(request.headers.cookie ?? ""),
      referer: String(request.headers.referer ?? ""),
    });

    if (url === "/proxy/master.m3u8") {
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvariant.m3u8\n");
      return;
    }
    if (url === "/proxy/variant.m3u8") {
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      response.end("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nsegment.ts\n");
      return;
    }
    if (url === "/proxy/key.bin") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(16, 7));
      return;
    }
    if (url === "/proxy/segment.ts") {
      response.writeHead(200, { "content-type": "video/mp2t" });
      response.end(Buffer.from([0x47, 0x40, 0x00, 0x10]));
      return;
    }
    if (url === "/proxy/protected.mp4") {
      if (request.headers.cookie !== "sid=secret" || request.headers.referer !== "https://pan.example.com/") {
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("forbidden");
        return;
      }
      const range = /^bytes=(\d+)-(\d+)?$/.exec(String(request.headers.range ?? ""));
      if (request.method === "HEAD") {
        response.writeHead(200, { "content-type": "video/mp4", "content-length": String(MEDIA_BYTES.length), "accept-ranges": "bytes" });
        response.end();
        return;
      }
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(MEDIA_BYTES.length - 1, range[2] ? Number(range[2]) : MEDIA_BYTES.length - 1);
        const body = MEDIA_BYTES.subarray(start, end + 1);
        response.writeHead(206, {
          "content-type": "video/mp4",
          "content-length": String(body.length),
          "content-range": `bytes ${start}-${end}/${MEDIA_BYTES.length}`,
          "accept-ranges": "bytes",
        });
        response.end(body);
        return;
      }
      response.writeHead(200, { "content-type": "video/mp4", "content-length": String(MEDIA_BYTES.length), "accept-ranges": "bytes" });
      response.end(MEDIA_BYTES);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observed,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("protected media fixture completes real HTTP range seeks without leaking credentials into playback URLs", async () => {
  const fixture = await startMediaFixture();
  try {
    const sessions = new PlaybackSessionStore();
    const session = sessions.create({
      url: `${fixture.baseUrl}/proxy/protected.mp4`,
      headers: { Cookie: "sid=secret", Referer: "https://pan.example.com/" },
      format: "mp4",
      resolvedBy: "direct",
    });
    const service = new MediaProtocolService(sessions);
    const playbackUrl = sessions.playbackUrl(session.id);
    assert.doesNotMatch(playbackUrl, /sid=secret|pan\.example/);

    const first = await service.handle(new Request(playbackUrl, { headers: { Range: "bytes=100-199" } }));
    const second = await service.handle(new Request(playbackUrl, { headers: { Range: "bytes=700-799" } }));
    const head = await service.handle(new Request(playbackUrl, { method: "HEAD" }));

    assert.equal(first.status, 206);
    assert.equal(first.headers.get("content-range"), "bytes 100-199/1024");
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), MEDIA_BYTES.subarray(100, 200));
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), MEDIA_BYTES.subarray(700, 800));
    assert.equal(head.status, 200);
    assert.deepEqual(fixture.observed.map((entry) => [entry.method, entry.range, entry.cookie, entry.referer]), [
      ["GET", "bytes=100-199", "sid=secret", "https://pan.example.com/"],
      ["GET", "bytes=700-799", "sid=secret", "https://pan.example.com/"],
      ["HEAD", "", "sid=secret", "https://pan.example.com/"],
    ]);
  } finally {
    await fixture.close();
  }
});

test("protected HLS fixture rewrites nested manifests, key and segment through the guarded session", async () => {
  const fixture = await startMediaFixture();
  try {
    const sessions = new PlaybackSessionStore();
    const session = sessions.create({
      url: `${fixture.baseUrl}/proxy/master.m3u8`,
      headers: { Referer: "https://pan.example.com/" },
      format: "hls",
      resolvedBy: "direct",
    });
    const service = new MediaProtocolService(sessions);
    const master = await (await service.handle(new Request(sessions.playbackUrl(session.id)))).text();
    const variantUrl = master.match(/fongmi-media:\/\/[^\s]+/)?.[0];
    assert.ok(variantUrl);
    const variant = await (await service.handle(new Request(variantUrl))).text();
    const guardedUrls = variant.match(/fongmi-media:\/\/session\/[^"\n,]+/g) ?? [];
    assert.equal(guardedUrls.length, 2);
    const key = await service.handle(new Request(guardedUrls[0]!));
    const segment = await service.handle(new Request(guardedUrls[1]!));
    assert.equal((await key.arrayBuffer()).byteLength, 16);
    assert.deepEqual([...new Uint8Array(await segment.arrayBuffer())], [0x47, 0x40, 0x00, 0x10]);
    assert.deepEqual(fixture.observed.map((entry) => entry.url), [
      "/proxy/master.m3u8",
      "/proxy/variant.m3u8",
      "/proxy/key.bin",
      "/proxy/segment.ts",
    ]);
  } finally {
    await fixture.close();
  }
});

test("an existing playback session follows CatVod from one real dynamic port to another", async () => {
  const firstFixture = await startMediaFixture();
  let secondFixture: Awaited<ReturnType<typeof startMediaFixture>> | undefined;
  try {
    let activeBaseUrl = firstFixture.baseUrl;
    const sessions = new PlaybackSessionStore();
    const session = sessions.create({
      url: "http://127.0.0.1:1/proxy/protected.mp4",
      headers: { Cookie: "sid=secret", Referer: "https://pan.example.com/" },
      format: "mp4",
      resolvedBy: "direct",
    });
    const service = new MediaProtocolService(sessions, (url, init) => fetch(url, init), (url) => resolveCatVodRuntimeUrl(url, activeBaseUrl));
    const playbackUrl = sessions.playbackUrl(session.id);
    assert.equal((await service.handle(new Request(playbackUrl, { headers: { Range: "bytes=0-9" } }))).status, 206);

    await firstFixture.close();
    secondFixture = await startMediaFixture();
    activeBaseUrl = secondFixture.baseUrl;
    const resumed = await service.handle(new Request(playbackUrl, { headers: { Range: "bytes=500-509" } }));
    assert.equal(resumed.status, 206);
    assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), MEDIA_BYTES.subarray(500, 510));
    assert.equal(secondFixture.observed[0]?.url, "/proxy/protected.mp4");
  } finally {
    if (secondFixture) await secondFixture.close();
    else await firstFixture.close().catch(() => undefined);
  }
});
