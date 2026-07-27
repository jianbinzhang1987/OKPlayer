import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService, type IncrementalSearchEvent } from "../src/core/app-service.ts";

test("incremental global search emits a fast source before the slow source completes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fongmi-incremental-search-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const fast = url.pathname.startsWith("/fast/");
    setTimeout(() => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        list: [{
          vod_id: fast ? "fast-1" : "slow-1",
          vod_name: fast ? "快速来源结果" : "慢速来源结果",
          vod_play_from: "直连",
          vod_play_url: `第1集$https://cdn.example.com/${fast ? "fast" : "slow"}.m3u8`,
        }],
      }));
    }, fast ? 20 : 220);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const fastConfig = path.join(directory, "fast.json");
  const slowConfig = path.join(directory, "slow.json");
  await writeFile(fastConfig, JSON.stringify({ sites: [{ key: "fast", name: "快速源", type: 1, api: `${origin}/fast/api`, searchable: 1 }] }));
  await writeFile(slowConfig, JSON.stringify({ sites: [{ key: "slow", name: "慢速源", type: 1, api: `${origin}/slow/api`, searchable: 1 }] }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(fastConfig, "快速配置");
    await service.loadConfig(slowConfig, "慢速配置");

    const events: IncrementalSearchEvent[] = [];
    let finished = false;
    let resolveFirstSource!: () => void;
    const firstSource = new Promise<void>((resolve) => { resolveFirstSource = resolve; });
    const searchPromise = service.searchDetailedIncremental(
      "测试",
      undefined,
      "all-configs",
      1,
      (event) => {
        events.push(event);
        if (event.type === "source" && event.status?.siteName === "快速源") resolveFirstSource();
      },
    ).then((result) => {
      finished = true;
      return result;
    });

    await firstSource;
    assert.equal(finished, false, "the renderer should receive the fast source before the batch completes");
    assert.equal(events.find((event) => event.type === "source")?.status?.siteName, "快速源");

    const result = await searchPromise;
    assert.deepEqual(result.list.map((item) => item.vodName).sort(), ["快速来源结果", "慢速来源结果"]);
    assert.equal(events.filter((event) => event.type === "source").length, 2);
    assert.equal(events.at(-1)?.type, "complete");
    assert.equal(events.at(-1)?.completed, 2);
    assert.equal(events.at(-1)?.total, 2);
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
