import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";
import { loadVodConfig } from "../src/core/config-loader.ts";
import { sourceFingerprint } from "../src/core/source-quality.ts";

test("global search schedules and returns proven search sources first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fongmi-search-ranking-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const high = url.pathname.startsWith("/high/");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      list: [{
        vod_id: high ? "high" : "low",
        vod_name: high ? "高质量来源结果" : "低质量来源结果",
        vod_play_from: "直连",
        vod_play_url: `第1集$https://cdn.example.com/${high ? "high" : "low"}.m3u8`,
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    sites: [
      { key: "low", name: "低质量来源", type: 1, api: `${origin}/low/api`, searchable: 1 },
      { key: "high", name: "高质量来源", type: 1, api: `${origin}/high/api`, searchable: 1 },
    ],
  }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configPath, "排序配置");
    const config = await loadVodConfig(configPath);
    const low = config.sites.find((site) => site.key === "low")!;
    const high = config.sites.find((site) => site.key === "high")!;
    const now = Date.now();
    service.storage.saveSourceQuality({
      configSource: configPath,
      siteKey: low.key,
      fingerprint: sourceFingerprint(low),
      state: "degraded",
      stage: "search",
      reason: "最近搜索超时",
      latencyMs: 7_000,
      checkedAt: now,
      failureCount: 4,
      successCount: 1,
      lastFailureAt: now,
      searchSuccessCount: 1,
      searchFailureCount: 4,
    });
    service.storage.saveSourceQuality({
      configSource: configPath,
      siteKey: high.key,
      fingerprint: sourceFingerprint(high),
      state: "healthy",
      stage: "media",
      reason: "最近播放成功",
      latencyMs: 600,
      checkedAt: now,
      failureCount: 1,
      successCount: 8,
      lastSuccessAt: now,
      lastSearchSuccessAt: now,
      searchSuccessCount: 7,
      searchFailureCount: 1,
      lastMediaSuccessAt: now,
      mediaSuccessCount: 2,
      mediaFailureCount: 0,
    });

    const result = await service.searchDetailed("测试", undefined, "all-configs");
    assert.deepEqual(result.list.map((item) => item.vodName), ["高质量来源结果", "低质量来源结果"]);
    assert.equal(service.storage.getSourceQuality(configPath, "high")?.searchSuccessCount, 8);
    assert.equal(service.storage.getSourceQuality(configPath, "low")?.searchSuccessCount, 2);

    const firstBatch = await service.searchDetailed("测试", undefined, "all-configs", 1, { maxSources: 1 });
    assert.deepEqual(firstBatch.list.map((item) => item.vodName), ["高质量来源结果"]);
    assert.deepEqual(firstBatch.statuses.map((status) => status.siteName), ["高质量来源"]);

    const remaining = await service.searchDetailed("测试", undefined, "all-configs", 1, { excludeSiteKeys: ["high"] });
    assert.deepEqual(remaining.list.map((item) => item.vodName), ["低质量来源结果"]);
    assert.deepEqual(remaining.statuses.map((status) => status.siteName), ["低质量来源"]);

    const included = await service.searchDetailed("测试", undefined, "all-configs", 1, { includeSiteKeys: ["high"] });
    assert.deepEqual(included.list.map((item) => item.vodName), ["高质量来源结果"]);

    const exhausted = await service.searchDetailed("测试", undefined, "all-configs", 1, { excludeSiteKeys: ["high", "low"] });
    assert.deepEqual(exhausted.list, []);
    assert.deepEqual(exhausted.statuses, []);
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
