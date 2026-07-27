import assert from "node:assert/strict";
import test from "node:test";
import { CatVodProtocolService } from "../src/desktop/catvod-protocol-service.ts";

test("CatVodProtocolService forwards stable URLs, range and source headers to the active port", async () => {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const protocol = {
    handle(_scheme: string, value: (request: Request) => Promise<Response>) {
      handler = value;
    },
  };
  const observed: Array<{ url: string; method?: string; range?: string; referer?: string }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    observed.push({
      url,
      method: init?.method,
      range: headers.get("range") ?? undefined,
      referer: headers.get("referer") ?? undefined,
    });
    return new Response("segment", { status: 206, headers: { "content-range": "bytes 0-6/7" } });
  };

  new CatVodProtocolService(() => "http://127.0.0.1:9988", fetchImpl as never).register(protocol as never);
  assert.ok(handler);
  const response = await handler!(new Request("fongmi-catvod://service/proxy/session/segment.ts", {
    headers: { range: "bytes=0-6", referer: "https://example.com/player" },
  }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-6/7");
  assert.deepEqual(observed, [{
    url: "http://127.0.0.1:9988/proxy/session/segment.ts",
    method: "GET",
    range: "bytes=0-6",
    referer: "https://example.com/player",
  }]);
});

test("CatVodProtocolService returns 503 while the local service is stopped", async () => {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const protocol = { handle(_scheme: string, value: (request: Request) => Promise<Response>) { handler = value; } };
  new CatVodProtocolService(() => undefined, (async () => new Response()) as never).register(protocol as never);
  const response = await handler!(new Request("fongmi-catvod://service/imageProxy?url=x"));
  assert.equal(response.status, 503);
});
