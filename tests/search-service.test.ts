import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import type { SiteConfig } from "../src/core/models.ts";
import { SearchService, type SearchEvent } from "../src/core/search-service.ts";

async function createSearchServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? "/", origin);
    const delay = url.pathname.includes("slow") ? 80 : 10;
    setTimeout(() => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        list: [{ vod_id: url.pathname, vod_name: url.searchParams.get("wd") }],
      }));
    }, delay);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试服务器启动失败");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function site(key: string, api: string): SiteConfig {
  return { key, name: key, type: 1, api, searchable: 1 };
}

test("多源搜索按实际返回速度增量回调", async () => {
  const server = await createSearchServer();
  try {
    const events: SearchEvent[] = [];
    const service = new SearchService();
    const search = service.start([
      site("slow", `${server.origin}/slow`),
      site("fast", `${server.origin}/fast`),
    ], "测试", (event) => events.push(event));
    await search.done;

    assert.equal(events.length, 2);
    assert.equal(events[0]?.site.key, "fast");
    assert.equal(events[1]?.site.key, "slow");
    assert.equal(events[0]?.result?.list[0]?.vodName, "测试");
  } finally {
    await server.close();
  }
});

test("新搜索会取消并屏蔽旧搜索结果", async () => {
  const server = await createSearchServer();
  try {
    const events: SearchEvent[] = [];
    const service = new SearchService();
    const oldSearch = service.start([
      site("slow", `${server.origin}/slow`),
    ], "旧关键词", (event) => events.push(event));

    const newSearch = service.start([
      site("fast", `${server.origin}/fast`),
    ], "新关键词", (event) => events.push(event));

    await Promise.all([oldSearch.done, newSearch.done]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.site.key, "fast");
    assert.equal(events[0]?.result?.list[0]?.vodName, "新关键词");
  } finally {
    await server.close();
  }
});
