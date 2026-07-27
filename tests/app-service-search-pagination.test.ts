import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";

test("current and aggregated search forward page and expose hasMore metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fongmi-search-pagination-"));
  const requestedPages: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const page = url.searchParams.get("pg") ?? "1";
    requestedPages.push(page);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      page: Number(page),
      pagecount: 3,
      total: 3,
      limit: 1,
      list: [{
        vod_id: `page-${page}`,
        vod_name: `分页影片 ${page}`,
        vod_play_from: "直连",
        vod_play_url: `正片$https://media.example.com/page-${page}.mp4`,
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    sites: [{ key: "paged", name: "分页测试源", type: 1, api: `http://127.0.0.1:${address.port}/api`, searchable: 1 }],
  }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configPath, "分页配置");

    const current = await service.searchDetailed("影片", "paged", "current-site", 2);
    assert.equal(current.page, 2);
    assert.equal(current.hasMore, true);
    assert.equal(current.list[0]?.vodId, "page-2");
    assert.equal(current.statuses[0]?.pageCount, 3);
    assert.equal(current.statuses[0]?.hasMore, true);

    const global = await service.searchDetailed("影片", undefined, "all-configs", 3);
    assert.equal(global.page, 3);
    assert.equal(global.hasMore, false);
    assert.equal(global.list[0]?.vodId, "page-3");
    assert.equal(global.statuses[0]?.pageCount, 3);
    assert.equal(global.statuses[0]?.hasMore, false);
    assert.ok(requestedPages.includes("2"));
    assert.ok(requestedPages.includes("3"));
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
