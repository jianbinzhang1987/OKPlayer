import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";

test("best home falls back without globally hiding an empty source", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fongmi-source-quality-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(url.pathname.startsWith("/empty") ? { list: [] } : {
      list: [{
        vod_id: "good-1",
        vod_name: "可用首页内容",
        vod_play_from: "直连",
        vod_play_url: "第1集$https://cdn.example.com/good.m3u8",
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ sites: [
    { key: "empty", name: "空首页源", type: 1, api: `${origin}/empty` },
    { key: "good", name: "可用首页源", type: 1, api: `${origin}/good` },
  ] }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configPath, "质量检测配置");
    const result = await service.bestHome("empty");
    assert.equal(result.siteKey, "good");
    assert.equal(result.list[0]?.vodName, "可用首页内容");
    const sites = service.listSites();
    assert.equal(sites.find((site) => site.key === "empty")?.supported, true);
    assert.equal(sites.find((site) => site.key === "empty")?.quality.state, "degraded");
    assert.equal(sites.find((site) => site.key === "good")?.supported, true);
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("playback failures quarantine a source", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fongmi-playback-quality-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ sites: [
    { key: "dead", name: "失效源", type: 1, api: "https://example.com/api" },
  ] }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configPath, "失效配置");
    await service.recordPlaybackFailure("dead", "媒体直链不可用：HTTP 404", 1_500);
    const site = service.listSites()[0];
    assert.equal(site?.supported, false);
    assert.equal(site?.quality.state, "blocked");
    await assert.rejects(service.detail("dead", "1"), /已被自动屏蔽/);
  } finally {
    service.close();
  }
});
