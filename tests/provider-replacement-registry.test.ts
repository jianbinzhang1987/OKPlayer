import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";
import { auditVodConfig } from "../src/core/compatibility-audit.ts";
import type { VodConfig } from "../src/core/models.ts";
import { ProviderReplacementRegistry, type ProviderReplacement } from "../src/core/provider-replacement-registry.ts";
import { SourceAdapterError } from "../src/core/source-adapter.ts";
import { SourceAdapterFactory } from "../src/core/source-adapter-factory.ts";

async function withServer<T>(handler: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? "/", origin);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (url.pathname === "/api") {
      response.end(JSON.stringify({
        list: [{ vod_id: "1", vod_name: `替代结果-${url.searchParams.get("wd") ?? "home"}` }],
        pagecount: 1,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
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

function replacement(api: string, origin: string): ProviderReplacement {
  return {
    id: "demo-http-replacement",
    match: { api, jarHash: "abc123" },
    replacement: { runtime: "http", api: `${origin}/api` },
    capabilities: { player: false },
    source: {
      name: "测试 HTTP 替代源",
      repository: "https://example.com/repository",
      license: "MIT",
      verifiedAt: "2026-07-26",
    },
    notes: "仅用于自动化测试",
  };
}

test("replacement registry matches exact api and optional jar hash", () => {
  const entry = replacement("csp_NewDemoGuard", "https://example.com");
  const registry = new ProviderReplacementRegistry([entry]);
  assert.equal(registry.match({
    key: "demo",
    name: "Demo",
    type: 3,
    api: "CSP_NEWDEMOGUARD",
    jar: "https://example.com/spider.jar;md5;ABC123",
  })?.id, entry.id);
  assert.equal(registry.match({
    key: "demo",
    name: "Demo",
    type: 3,
    api: "csp_NewDemoGuard",
    jar: "https://example.com/spider.jar;md5;different",
  }), undefined);
});

test("factory transparently runs a verified replacement and enforces capability limits", async () => {
  await withServer(async (origin) => {
    const site = {
      key: "guard",
      name: "Android Guard",
      type: 3,
      api: "csp_NewDemoGuard",
      jar: "https://example.com/spider.jar;md5;abc123",
    };
    const entries = [replacement(site.api, origin)];
    const adapter = new SourceAdapterFactory({ replacements: entries }).create(site);

    assert.equal(adapter.supported, true);
    assert.equal(adapter.runtime, "http");
    assert.equal(adapter.site.api, site.api);
    assert.equal(adapter.replacement?.id, "demo-http-replacement");
    assert.equal(adapter.capabilities.player, false);

    const result = await adapter.search("电影");
    assert.equal(result.list[0]?.vodName, "替代结果-电影");
    assert.equal(result.list[0]?.siteKey, site.key);

    await assert.rejects(
      adapter.player("line", "https://example.com/video.m3u8"),
      (error: unknown) => error instanceof SourceAdapterError && error.code === "UNSUPPORTED",
    );
    await adapter.destroy();

    const config: VodConfig = {
      sourceUrl: "memory://replacement",
      sites: [site],
      parses: [], flags: [], headers: [], proxy: [], rules: [], hosts: [], ads: [],
    };
    const report = auditVodConfig(config, new ProviderReplacementRegistry(entries));
    assert.equal(report.supported, 1);
    assert.equal(report.androidOnly.length, 0);
    assert.equal(report.replaced[0]?.replacement?.sourceName, "测试 HTTP 替代源");
  });
});

test("source audit evaluates the effective replacement instead of ignoring the original Android runtime", async () => {
  await withServer(async (origin) => {
    const site = {
      key: "guard-audit",
      name: "Android Guard Audit",
      type: 3,
      api: "csp_NewDemoGuard",
      jar: "https://example.com/spider.jar;md5;abc123",
    };
    const factory = new SourceAdapterFactory({ replacements: [replacement(site.api, origin)] });
    const service = new AppService(":memory:", factory);
    try {
      await service.loadConfigText(JSON.stringify({ sites: [site] }), "memory://replacement-audit", "替代检测");
      const initial = service.startSourceAudit(true);
      assert.equal(initial.total, 1);
      assert.equal(service.listSites()[0]?.supported, true);

      for (let index = 0; index < 100 && service.getSourceAuditStatus().running; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const status = service.getSourceAuditStatus();
      assert.equal(status.completed, 1);
      assert.equal(status.blocked, 0);
      assert.notEqual(service.listSites()[0]?.quality.state, "blocked");
    } finally {
      service.close();
    }
  });
});
