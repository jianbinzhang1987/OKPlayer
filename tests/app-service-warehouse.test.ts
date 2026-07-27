import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";

async function createWarehouseFixture() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/warehouse.json") {
      response.end(JSON.stringify({ urls: [
        { name: "线路甲", url: "./a.json" },
        { name: "线路乙", url: "./b.json" },
        { name: "失效线路", url: "./missing.json" },
      ] }));
      return;
    }

    if (url.pathname === "/a.json" || url.pathname === "/b.json") {
      const key = "same";
      const label = url.pathname === "/a.json" ? "甲" : "乙";
      const apiKey = url.pathname === "/a.json" ? "a" : "b";
      response.end(JSON.stringify({ sites: [{
        key,
        name: `测试源${label}`,
        type: 1,
        api: `./api/${apiKey}`,
        searchable: 1,
      }] }));
      return;
    }

    if (url.pathname === "/api/a" || url.pathname === "/api/b") {
      const label = url.pathname.endsWith("a") ? "甲" : "乙";
      if (url.searchParams.get("ids")) {
        response.end(JSON.stringify({ list: [{
          vod_id: `${label}-1`,
          vod_name: `影片${label}`,
          vod_play_from: "direct",
          vod_play_url: `第1集$https://cdn.example.com/${label}.m3u8`,
        }] }));
      } else {
        response.end(JSON.stringify({ list: [{ vod_id: `${label}-1`, vod_name: `影片${label}` }] }));
      }
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed");
  const origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, warehouseUrl: `${origin}/warehouse.json` };
}

test("app service imports a warehouse as multiple named configurations and isolates duplicate site keys", async () => {
  const fixture = await createWarehouseFixture();
  const service = new AppService(":memory:");
  try {
    await service.loadConfig(fixture.warehouseUrl, "父级仓库");

    const configs = service.listConfigs();
    assert.equal(configs.length, 2);
    assert.deepEqual(configs.map((item) => item.name).sort(), ["线路乙", "线路甲"]);
    assert.equal(configs.filter((item) => item.enabled).length, 1);
    assert.equal(configs.find((item) => item.enabled)?.name, "线路甲");
    assert.equal(service.listSites()[0]?.name, "测试源甲");

    const search = await service.searchDetailed("影片", undefined, "all-configs");
    assert.equal(search.list.length, 2);
    assert.deepEqual(search.list.map((item) => item.configName).sort(), ["线路乙", "线路甲"]);
    assert.equal(new Set(search.list.map((item) => item.siteKey)).size, 2);
  } finally {
    service.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("restoring an active configuration preserves its saved name", async () => {
  const fixture = await createWarehouseFixture();
  const databasePath = `${process.cwd()}/.tmp-app-service-warehouse-${Date.now()}.sqlite`;
  let first = new AppService(databasePath);
  try {
    await first.loadConfig(`${fixture.origin}/a.json`, "自定义名称");
    first.close();

    const restored = new AppService(databasePath);
    try {
      await restored.restoreActiveConfig();
      assert.equal(restored.listConfigs().find((item) => item.enabled)?.name, "自定义名称");
    } finally {
      restored.close();
    }
  } finally {
    try { first.close(); } catch {}
    await import("node:fs/promises").then(({ rm }) => rm(databasePath, { force: true }));
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("deleting the active configuration switches to the next saved configuration", async () => {
  const fixture = await createWarehouseFixture();
  const service = new AppService(":memory:");
  try {
    await service.loadConfig(`${fixture.origin}/a.json`, "线路甲");
    await service.loadConfig(`${fixture.origin}/b.json`, "线路乙");
    const active = service.listConfigs().find((item) => item.enabled);
    assert.equal(active?.name, "线路乙");

    await service.deleteConfig(active!.url);

    assert.equal(service.listConfigs().length, 1);
    assert.equal(service.listConfigs()[0]?.name, "线路甲");
    assert.equal(service.listConfigs()[0]?.enabled, true);
    assert.equal(service.listSites()[0]?.name, "测试源甲");
  } finally {
    service.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});
