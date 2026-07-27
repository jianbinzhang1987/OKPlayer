import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";
import { decodeSourceReference } from "../src/core/source-reference.ts";

test("global search aggregates every saved config and preserves duplicate site keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fongmi-global-search-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const sourceName = url.pathname.startsWith("/a/") ? "配置A影片" : "配置B影片";
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      list: [{
        vod_id: "1",
        vod_name: sourceName,
        vod_play_from: "直连",
        vod_play_url: `第1集$https://cdn.example.com/${url.pathname.startsWith("/a/") ? "a" : "b"}.m3u8`,
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const configA = path.join(dir, "a.json");
  const configB = path.join(dir, "b.json");
  await writeFile(configA, JSON.stringify({ sites: [{ key: "shared", name: "同名源", type: 1, api: `${origin}/a/api`, searchable: 1 }] }));
  await writeFile(configB, JSON.stringify({ sites: [{ key: "shared", name: "同名源", type: 1, api: `${origin}/b/api`, searchable: 1 }] }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configA, "配置 A");
    await service.loadConfig(configB, "配置 B");

    const global = await service.searchDetailed("影片", undefined, "all-configs");
    assert.equal(global.list.length, 2);
    assert.deepEqual(global.list.map((item) => item.vodName).sort(), ["配置A影片", "配置B影片"]);
    assert.equal(global.statuses.filter((item) => item.state === "success").length, 2);
    assert.equal(new Set(global.list.map((item) => item.siteKey)).size, 2);

    for (const item of global.list) {
      assert.ok(item.siteKey);
      const reference = decodeSourceReference(item.siteKey!);
      assert.ok(reference);
      assert.equal(reference?.siteKey, "shared");
      const detail = await service.detail(item.siteKey!, item.vodId);
      assert.equal(detail.vodName, item.vodName);
      assert.equal(detail.siteKey, item.siteKey);
      assert.match(detail.siteName ?? "", /同名源 · 配置 [AB]/);
    }

    const current = await service.searchDetailed("影片", "shared", "current-site");
    assert.equal(current.list.length, 1);
    assert.equal(current.list[0]?.vodName, "配置B影片");
    assert.equal(service.listConfigs().find((item) => item.url === configB)?.enabled, true);
    assert.equal(service.listConfigs().find((item) => item.url === configA)?.enabled, false);
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
