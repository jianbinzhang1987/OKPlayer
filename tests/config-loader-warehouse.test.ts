import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { expandVodConfigs, loadConfigDocument, loadVodConfig, parseConfigText } from "../src/core/config-loader.ts";

test("config parser accepts comments trailing commas and string URLs", () => {
  const parsed = parseConfigText(`{
    // comment
    "sites": [
      {"key":"a","name":"A","type":1,"api":"https://example.com/api//path",},
    ],
  }`);
  assert.equal(Array.isArray(parsed.sites), true);
  assert.equal((parsed.sites as Array<Record<string, unknown>>)[0]?.api, "https://example.com/api//path");
});

test("warehouse documents are detected and recursively expanded", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/warehouse.json") {
      response.end(JSON.stringify({ urls: [
        { name: "A", url: "./a.json" },
        { name: "Nested", url: "./nested.json" },
      ] }));
      return;
    }
    if (request.url === "/nested.json") {
      response.end(`{ "urls": [{ "name": "B", "url": "./b.json", }], }`);
      return;
    }
    if (request.url === "/a.json") {
      response.end(JSON.stringify({ sites: [{ key: "a", name: "A", type: 1, api: "./api" }] }));
      return;
    }
    if (request.url === "/b.json") {
      response.end(`{
        // JSON5 style config
        sites: [{ key: 'b', name: 'B', type: 3, api: 'csp_XBPQ', ext: { 主页url: 'https://example.com' }, }],
      }`);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server failed");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const document = await loadConfigDocument(`${origin}/warehouse.json`);
    assert.equal(document.kind, "warehouse");
    if (document.kind === "warehouse") {
      assert.equal(document.warehouse.entries[0]?.url, `${origin}/a.json`);
    }
    await assert.rejects(loadVodConfig(`${origin}/warehouse.json`), /影视仓多仓索引/);

    const expanded = await expandVodConfigs(`${origin}/warehouse.json`);
    assert.equal(expanded.configs.length, 2);
    assert.deepEqual(expanded.configs.map((item) => item.sites[0]?.key).sort(), ["a", "b"]);
    assert.deepEqual(expanded.entries.map((item) => ({ name: item.name, source: item.source })), [
      { name: "A", source: `${origin}/a.json` },
      { name: "B", source: `${origin}/b.json` },
    ]);
    assert.equal(expanded.warehouses.length, 2);
    assert.equal(expanded.failures.length, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});
