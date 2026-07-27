import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";

async function createFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "tv-app-service-"));
  const configPath = path.join(dir, "config.json");
  const server = await import("node:http").then(({ createServer }) => createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("ids")) {
      res.end(JSON.stringify({ list: [{ vod_id: "1", vod_name: "测试片", vod_play_from: "线路一", vod_play_url: "第1集$https://cdn.example.com/a.m3u8" }] }));
    } else {
      res.end(JSON.stringify({ list: [{ vod_id: "1", vod_name: "测试片" }] }));
    }
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  await writeFile(configPath, JSON.stringify({ sites: [{ key: "s", name: "源", type: 1, api: `http://127.0.0.1:${address.port}/api` }] }));
  return { dir, configPath, server };
}

test("app service binds config search detail and resolve", async () => {
  const fixture = await createFixture();
  const service = new AppService(":memory:");
  try {
    await service.loadConfig(fixture.configPath);
    assert.equal(service.listSites().length, 1);
    const list = await service.search("测试");
    assert.equal(list[0]?.vodName, "测试片");
    const detailed = await service.searchDetailed("测试");
    assert.equal(detailed.statuses[0]?.state, "success");
    assert.equal(detailed.statuses[0]?.count, 1);
    const detail = await service.detail("s", "1");
    assert.equal(detail.flags[0]?.episodes[0]?.name, "第1集");
    const media = await service.resolve("s", "线路一", "https://cdn.example.com/a.m3u8");
    assert.equal(media.url, "https://cdn.example.com/a.m3u8");
    service.renameConfig(fixture.configPath, "重命名配置");
    assert.equal(service.listConfigs()[0]?.name, "重命名配置");
    await service.deleteConfig(fixture.configPath);
    assert.equal(service.listConfigs().length, 0);
    assert.equal(service.listSites().length, 0);
  } finally {
    service.close();
    fixture.server.close();
  }
});

test("detail restores the saved config that owns a history source", async () => {
  const fixture = await createFixture();
  const secondConfigPath = path.join(fixture.dir, "second-config.json");
  const address = fixture.server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  await writeFile(secondConfigPath, JSON.stringify({
    sites: [{ key: "other", name: "其他源", type: 1, api: `http://127.0.0.1:${address.port}/other` }],
  }));

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(fixture.configPath, "原配置");
    await service.loadConfig(secondConfigPath, "当前配置");
    assert.equal(service.listSites()[0]?.key, "other");

    const detail = await service.detail("s", "1");

    assert.equal(detail.vodName, "测试片");
    assert.equal(service.listSites()[0]?.key, "s");
    assert.equal(service.listConfigs().find((item) => item.url === fixture.configPath)?.enabled, true);
    assert.equal(service.listConfigs().find((item) => item.url === secondConfigPath)?.enabled, false);
  } finally {
    service.close();
    fixture.server.close();
  }
});
