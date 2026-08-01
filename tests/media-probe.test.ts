import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { probeMediaUrl, selectVerifiedMediaCandidate, type MediaProbeResult } from "../src/core/media-probe.ts";
import type { RankedMediaCandidate } from "../src/core/media-sniffer.ts";

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => route(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("媒体探测测试服务启动失败");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function route(request: IncomingMessage, response: ServerResponse): void {
  const address = request.socket.address();
  if (!address || typeof address === "string") throw new Error("无法获取测试服务地址");
  const origin = `http://127.0.0.1:${address.port}`;
  const url = new URL(request.url ?? "/", origin);

  if (url.pathname === "/master.m3u8") {
    response.statusCode = request.headers.range ? 206 : 200;
    response.setHeader("content-type", "application/vnd.apple.mpegurl");
    response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n/video/index.m3u8\n");
    return;
  }
  if (url.pathname === "/manifest.mpd") {
    response.setHeader("content-type", "application/dash+xml");
    response.end("<?xml version=\"1.0\"?><MPD type=\"static\"></MPD>");
    return;
  }
  if (url.pathname === "/video.mp4") {
    response.statusCode = 206;
    response.setHeader("content-type", "application/octet-stream");
    response.end(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
    return;
  }
  if (url.pathname === "/video.mkv") {
    response.statusCode = 206;
    response.setHeader("content-type", "video/x-matroska");
    response.end(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]));
    return;
  }
  if (url.pathname === "/video.mkv.raw") {
    // Netdisk signed links often omit a meaningful content-type; the EBML
    // magic must be enough to identify the Matroska container.
    response.statusCode = 206;
    response.setHeader("content-type", "application/octet-stream");
    response.end(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]));
    return;
  }
  if (url.pathname === "/fake.m3u8") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><html><body>Access denied</body></html>");
    return;
  }
  if (url.pathname === "/redirect") {
    response.statusCode = 302;
    response.setHeader("location", "/master.m3u8");
    response.end();
    return;
  }
  response.statusCode = 404;
  response.end("not found");
}

test("media probe validates HLS DASH MP4 and Matroska signatures", async () => {
  await withServer(async (origin) => {
    const hls = await probeMediaUrl(`${origin}/master.m3u8`, { expectedFormat: "hls" });
    assert.equal(hls.ok, true);
    assert.equal(hls.format, "hls");
    assert.ok(hls.bytesRead > 0);

    const dash = await probeMediaUrl(`${origin}/manifest.mpd`, { expectedFormat: "dash" });
    assert.equal(dash.ok, true);
    assert.equal(dash.format, "dash");

    const mp4 = await probeMediaUrl(`${origin}/video.mp4`, { expectedFormat: "mp4" });
    assert.equal(mp4.ok, true);
    assert.equal(mp4.format, "mp4");

    const mkv = await probeMediaUrl(`${origin}/video.mkv`, { expectedFormat: "mkv" });
    assert.equal(mkv.ok, true);
    assert.equal(mkv.format, "mkv");

    // Netdisk signed links often lack a content-type; the EBML magic alone
    // must identify Matroska so MKV routes straight to the mpv kernel.
    const rawMkv = await probeMediaUrl(`${origin}/video.mkv.raw`);
    assert.equal(rawMkv.ok, true);
    assert.equal(rawMkv.format, "mkv");
  });
});

test("media probe rejects HTML disguised as a manifest", async () => {
  await withServer(async (origin) => {
    const result = await probeMediaUrl(`${origin}/fake.m3u8`, { expectedFormat: "hls" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HTML/);
  });
});

test("candidate verification skips definite HTML failures", async () => {
  const candidates: RankedMediaCandidate[] = [
    { url: "https://example.com/fake.m3u8", score: 220, format: "hls", reasons: ["extension:m3u8"] },
    { url: "https://example.com/real.m3u8", score: 210, format: "hls", reasons: ["mime:hls"] },
  ];
  const probe = async (url: string): Promise<MediaProbeResult> => url.includes("fake")
    ? { ok: false, url, statusCode: 200, mimeType: "text/html", bytesRead: 20, reason: "响应内容是 HTML，不是媒体资源" }
    : { ok: true, url, statusCode: 200, mimeType: "application/vnd.apple.mpegurl", bytesRead: 20, format: "hls", reason: "媒体内容验证通过" };

  const result = await selectVerifiedMediaCandidate(candidates, {
    getHeaders: () => ({ Referer: "https://example.com/watch" }),
    probe,
  });
  assert.equal(result?.verified, true);
  assert.equal(result?.candidate.url, "https://example.com/real.m3u8");
});

test("candidate verification keeps uncertain authenticated candidates as fallback", async () => {
  const candidate: RankedMediaCandidate = {
    url: "https://example.com/signed?token=one-time",
    score: 120,
    format: "video",
    reasons: ["signed-url"],
  };
  const result = await selectVerifiedMediaCandidate([candidate], {
    getHeaders: () => ({ Cookie: "session=ready" }),
    probe: async (url) => ({ ok: false, url, statusCode: 403, mimeType: "", bytesRead: 0, reason: "HTTP 403" }),
  });
  assert.equal(result?.verified, false);
  assert.equal(result?.candidate.url, candidate.url);
  assert.equal(result?.headers.Cookie, "session=ready");
});

test("media probe follows redirects and preserves the final URL", async () => {
  await withServer(async (origin) => {
    const result = await probeMediaUrl(`${origin}/redirect`, { expectedFormat: "hls" });
    assert.equal(result.ok, true);
    assert.equal(result.url, `${origin}/master.m3u8`);
  });
});
