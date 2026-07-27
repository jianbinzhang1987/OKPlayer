import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { HttpSource } from "../src/core/http-source.ts";

function startServer() {
  const requests: URL[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ list: [{ vod_id: "1", vod_name: "影片" }] }));
  });
  return new Promise<{ baseUrl: string; requests: URL[]; close(): Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server failed");
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/api`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("http source supports home and category", async () => {
  const fixture = await startServer();
  try {
    const source = new HttpSource({ key: "s", name: "测试源", type: 1, api: fixture.baseUrl });
    assert.equal((await source.home()).list[0]?.vodName, "影片");
    assert.equal((await source.category("2", "3", { year: "2026" })).list.length, 1);
    assert.equal(fixture.requests[0]?.searchParams.get("filter"), "true");
    assert.equal(fixture.requests[1]?.searchParams.get("t"), "2");
    assert.equal(fixture.requests[1]?.searchParams.get("pg"), "3");
    assert.equal(fixture.requests[1]?.searchParams.get("f"), JSON.stringify({ year: "2026" }));
  } finally {
    await fixture.close();
  }
});
