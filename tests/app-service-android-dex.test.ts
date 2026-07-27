import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";

test("app service marks Android Dex spider sites unsupported with a precise error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fongmi-dex-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    spider: "https://example.com/spider.png;md5;abc",
    sites: [{
      key: "玩偶",
      name: "💓玩偶┃4K💓",
      type: 3,
      api: "csp_NewWoggGuard",
      searchable: 1,
    }],
  }), "utf8");

  const service = new AppService(":memory:");
  try {
    await service.loadConfig(configPath);
    const sites = service.listSites();
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.runtime, "android-dex");
    assert.equal(sites[0]?.supported, false);

    await assert.rejects(
      service.search("庆余年", "玩偶"),
      /Android Dex\/JAR Spider.*csp_NewWoggGuard/,
    );
    await assert.rejects(
      service.search("庆余年"),
      /可搜索站点均依赖 Android Dex\/JAR Spider/,
    );
  } finally {
    service.close();
  }
});
