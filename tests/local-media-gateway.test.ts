import assert from "node:assert/strict";
import test from "node:test";
import { LocalMediaGateway } from "../src/desktop/media-protocol/local-media-gateway.ts";
import { MediaProtocolService } from "../src/desktop/media-protocol/media-protocol-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";

test("local media gateway forwards opaque session requests and range headers", async () => {
  const sessions = new PlaybackSessionStore();
  const session = sessions.create({ url: "https://cdn.example.com/protected.mkv", headers: { Cookie: "secret" }, format: "mkv", resolvedBy: "direct" });
  let request: Request | undefined;
  const gateway = new LocalMediaGateway({
    handle: async (value) => {
      request = value;
      return new Response("media", { status: 206, headers: { "content-range": "bytes 0-4/5", "content-type": "video/x-matroska" } });
    },
  } as any, sessions);
  await gateway.start();
  try {
    const response = await fetch(gateway.playbackUrl(session.id), { headers: { Range: "bytes=0-4" } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "media");
    assert.equal(request?.url, sessions.playbackUrl(session.id));
    assert.equal(request?.headers.get("range"), "bytes=0-4");
    assert.equal(request?.headers.get("cookie"), null);
  } finally {
    await gateway.stop();
  }
});

test("gateway stream errors tear down the response without an uncaught exception", async () => {
  const sessions = new PlaybackSessionStore();
  const session = sessions.create({ url: "https://cdn.example.com/protected.mkv", headers: {}, format: "mkv", resolvedBy: "direct" });
  const gateway = new LocalMediaGateway({
    handle: async () => {
      // Simulate the upstream dropping the connection mid-stream (the same
      // path that previously surfaced net::ERR_CONNECTION_CLOSED as an
      // uncaught exception from a listener-less Node stream).
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          setTimeout(() => controller.error(new Error("net::ERR_CONNECTION_CLOSED")), 5);
        },
      });
      return new Response(stream, { status: 206 });
    },
  } as any, sessions);
  await gateway.start();
  try {
    const response = await fetch(gateway.playbackUrl(session.id));
    assert.equal(response.status, 206);
    // Reading may either deliver partial bytes or fail; either way the
    // gateway must not throw an uncaught exception.
    await response.text().catch(() => "aborted");
  } finally {
    await gateway.stop();
  }
});

test("media protocol wrapper releases the upstream reader when the client aborts", async () => {
  const sessions = new PlaybackSessionStore();
  const session = sessions.create({ url: "https://cdn.example.com/protected.mp4", headers: {}, format: "mp4", resolvedBy: "direct" });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // One chunk, then stay open forever (simulates an endless netdisk
      // stream). The client aborts before it finishes.
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const service = new MediaProtocolService(
    sessions,
    async () => new Response(body, { status: 206, headers: { "content-type": "video/mp4" } }),
  );
  const gateway = new LocalMediaGateway(service, sessions);
  await gateway.start();
  try {
    const controller = new AbortController();
    const response = await fetch(gateway.playbackUrl(session.id), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    for (let attempt = 0; attempt < 40 && !cancelled; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cancelled, true, "upstream reader must be cancelled when the client aborts");
  } finally {
    await gateway.stop();
  }
});
