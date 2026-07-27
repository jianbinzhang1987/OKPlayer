import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";

async function withServer<T>(handler: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? "/", origin);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (url.pathname === "/api") {
      response.end(JSON.stringify({ list: [{ vod_id: "1", vod_name: `替代-${url.searchParams.get("wd") ?? "home"}` }] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
  try {
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("app service imports persists applies and clears a replacement registry", async () => {
  await withServer(async (origin) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fongmi-registry-app-"));
    const configPath = path.join(directory, "config.json");
    const registryPath = path.join(directory, "registry.json");
    const databasePath = path.join(directory, "app.sqlite");
    await writeFile(configPath, JSON.stringify({
      sites: [{ key: "guard", name: "Guard", type: 3, api: "csp_NewDemoGuard" }],
    }), "utf8");
    await writeFile(registryPath, JSON.stringify({
      replacements: [{
        id: "guard-http",
        match: { api: "csp_NewDemoGuard" },
        replacement: { runtime: "http", api: `${origin}/api` },
        source: { name: "测试替代", license: "MIT", verifiedAt: "2026-07-26" },
      }],
    }), "utf8");

    const service = new AppService(databasePath);
    try {
      await service.loadConfig(configPath);
      assert.equal(service.listSites()[0]?.supported, false);

      const loaded = await service.loadReplacementRegistry(registryPath);
      assert.equal(loaded.count, 1);
      const site = service.listSites()[0];
      assert.equal(site?.supported, true);
      assert.equal(site?.runtime, "http");
      assert.equal(site?.replacement?.sourceName, "测试替代");
      assert.equal((await service.search("电影", "guard"))[0]?.vodName, "替代-电影");
      assert.equal(service.getReplacementRegistryStatus().source, registryPath);

      await service.clearReplacementRegistry();
      assert.equal(service.getReplacementRegistryStatus().count, 0);
      assert.equal(service.listSites()[0]?.supported, false);
    } finally {
      service.close();
    }

    const restored = new AppService(databasePath);
    try {
      const status = await restored.restoreReplacementRegistry();
      assert.equal(status.count, 0);
      assert.equal(status.source, "");
    } finally {
      restored.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
