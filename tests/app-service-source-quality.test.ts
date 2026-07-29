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
    response.end(JSON.stringify(url.pathname.startsWith("/empty")
      ? { list: [] }
      : url.pathname.startsWith("/pan")
        ? { class: [{ type_id: "mine:quark", type_name: "夸克" }], list: [] }
        : {
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
    { key: "pan", name: "我的网盘", type: 1, api: `${origin}/pan`, contentType: "pan" },
    { key: "good", name: "可用首页源", type: 1, api: `${origin}/good` },
  ] }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configPath, "质量检测配置");
    const result = await service.bestHome("pan");
    assert.equal(result.siteKey, "good");
    assert.equal(result.list[0]?.vodName, "可用首页内容");
    const panHome = await service.home("pan");
    assert.deepEqual(panHome.categories, [{ id: "mine:quark", name: "夸克" }]);
    const sites = service.listSites();
    assert.equal(sites.find((site) => site.key === "empty")?.supported, true);
    assert.equal(sites.find((site) => site.key === "pan")?.quality.reason, "首页分类获取正常");
    assert.equal(sites.find((site) => site.key === "pan")?.quality.failureCount, 0);
    assert.equal(sites.find((site) => site.key === "good")?.supported, true);
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("playback failures lower source quality without hiding the whole source", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fongmi-playback-quality-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ sites: [
    { key: "dead", name: "失效源", type: 1, api: "https://example.com/api" },
  ] }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configPath, "失效配置");
    await service.recordPlaybackFailure("dead", "媒体直链不可用：HTTP 404", 1_500);
    await service.recordPlaybackFailure("dead", "媒体直链不可用：HTTP 404", 1_500);
    await service.recordPlaybackFailure("dead", "媒体直链不可用：HTTP 404", 1_500);

    const site = service.listSites()[0];
    assert.equal(site?.supported, true);
    assert.equal(site?.quality.state, "blocked");
  } finally {
    service.close();
  }
});

test("source audit includes desktop dynamic sources such as CatVod-backed pan providers", async () => {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/video.m3u8") {
      response.setHeader("content-type", "application/vnd.apple.mpegurl");
      response.end("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nsegment.ts\n");
      return;
    }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      list: [{
        vod_id: "dynamic-1",
        vod_name: "网盘示例",
        vod_play_from: "夸克",
        vod_play_url: `第1集$${origin}/video.m3u8`,
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;

  const service = new AppService(":memory:");
  try {
    await service.loadConfigText(JSON.stringify({
      sites: [{ key: "ordinary", name: "普通来源", type: 1, api: `${origin}/api` }],
    }), "memory://ordinary", "普通配置");
    await service.setDynamicSites([{ key: "dynamic-pan", name: "桌面网盘来源", type: 1, api: `${origin}/api`, contentType: "pan" }]);

    const initial = service.startSourceAudit(true);
    assert.equal(initial.total, 2);
    for (let index = 0; index < 100 && service.getSourceAuditStatus().running; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.getSourceAuditStatus().completed, 2);
    assert.equal(service.listSites().find((site) => site.key === "dynamic-pan")?.quality.state, "healthy");
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
