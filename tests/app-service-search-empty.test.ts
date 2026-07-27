import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";

test("search reports current-source empty all-source empty and source timeout separately", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fongmi-search-empty-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (url.pathname.startsWith("/slow/")) {
      const timer = setTimeout(() => response.end(JSON.stringify({ list: [] })), 2_800);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    response.end(JSON.stringify({ list: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    sites: [
      { key: "empty", name: "空结果来源", type: 1, api: `${origin}/empty/api`, searchable: 1 },
      { key: "slow", name: "超时来源", type: 1, api: `${origin}/slow/api`, searchable: 1, timeout: 1 },
    ],
  }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configPath, "搜索边界配置");

    const currentEmpty = await service.searchDetailed("不存在的影片", "empty", "current-site");
    assert.deepEqual(currentEmpty.list, []);
    assert.equal(currentEmpty.statuses[0]?.state, "success");
    assert.equal(currentEmpty.statuses[0]?.count, 0);

    const allEmpty = await service.searchDetailed("不存在的影片", undefined, "all-configs", 1, {
      includeSiteKeys: ["empty"],
    });
    assert.deepEqual(allEmpty.list, []);
    assert.equal(allEmpty.statuses.length, 1);
    assert.equal(allEmpty.statuses[0]?.state, "success");

    const timedOut = await service.searchDetailed("不存在的影片", undefined, "all-configs", 1, {
      includeSiteKeys: ["slow"],
    });
    assert.deepEqual(timedOut.list, []);
    assert.equal(timedOut.statuses.length, 1);
    assert.equal(timedOut.statuses[0]?.state, "error");
    assert.match(timedOut.statuses[0]?.message ?? "", /timeout|timed out|aborted|超时/i);
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
