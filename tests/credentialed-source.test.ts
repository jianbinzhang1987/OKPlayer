import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatVodBundleManager } from "../src/core/catvod/catvod-bundle-manager.ts";
import { loadVodConfig } from "../src/core/config-loader.ts";

const USERNAME = "source-user";
const PASSWORD = "source-pass";
const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

test("credentialed config and CatVod URLs are requested with Basic Auth", async () => {
  const script = "module.exports={start(){},stop(){}};";
  const received: Array<{ url?: string; authorization?: string }> = [];
  const server = http.createServer((request, response) => {
    received.push({
      url: request.url,
      authorization: request.headers.authorization,
    });
    if (request.headers.authorization !== EXPECTED_AUTHORIZATION) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    if (request.url === "/config.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        sites: [{ key: "demo", name: "Demo", type: 0, api: "https://example.com/api" }],
      }));
      return;
    }
    if (request.url === "/cat/index.js.md5") {
      response.end(md5(script));
      return;
    }
    if (request.url === "/cat/index.js") {
      response.end(script);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "credentialed-source-"));
  const base = `http://${USERNAME}:${PASSWORD}@127.0.0.1:${port}`;

  try {
    const config = await loadVodConfig(`${base}/config.json`);
    assert.equal(config.sites[0]?.key, "demo");
    assert.equal(config.sourceUrl.includes("@"), false);

    const manager = new CatVodBundleManager({ rootDir, timeoutMs: 3_000 });
    const version = await manager.ensureCurrent(`${base}/cat/index.js.md5`);
    assert.equal(await readFile(manager.scriptPath(version), "utf8"), script);
    assert.equal((await manager.readManifest(`${base}/cat/index.js.md5`)).sourceMd5Url.includes("@"), false);

    assert.deepEqual(received.map((item) => item.url), [
      "/config.json",
      "/cat/index.js.md5",
      "/cat/index.js",
    ]);
    assert.ok(received.every((item) => item.authorization === EXPECTED_AUTHORIZATION));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(rootDir, { recursive: true, force: true });
  }
});
