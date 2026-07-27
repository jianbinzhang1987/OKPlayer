import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatVodBundleManager } from "../src/core/catvod/catvod-bundle-manager.ts";

function hash(value: Buffer | string) {
  return createHash("md5").update(value).digest("hex");
}

async function serverFor(script: string, md5Override?: string) {
  const server = http.createServer((request, response) => {
    if (request.url === "/cat/index.js.md5") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(md5Override ?? hash(script));
      return;
    }
    if (request.url === "/cat/index.js") {
      response.writeHead(200, {
        "content-type": "text/javascript",
        "content-length": Buffer.byteLength(script),
      });
      response.end(script);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/cat/index.js.md5`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("CatVodBundleManager downloads, verifies and activates a valid bundle", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "catvod-bundle-"));
  const source = await serverFor("module.exports={start(){},stop(){}};");
  try {
    const manager = new CatVodBundleManager({ rootDir, timeoutMs: 3_000 });
    const current = await manager.ensureCurrent(source.url);
    assert.equal(current.md5, hash("module.exports={start(){},stop(){}};"));
    assert.match(current.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(manager.scriptPath(current), "utf8"), "module.exports={start(){},stop(){}};");
    const manifest = await manager.readManifest(source.url);
    assert.equal(manifest.current?.md5, current.md5);
  } finally {
    await source.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CatVodBundleManager switches current bundle when the MD5 source URL changes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "catvod-bundle-source-switch-"));
  const firstSource = await serverFor("module.exports={version:'first'};");
  const secondSource = await serverFor("module.exports={version:'second'};");
  try {
    const manager = new CatVodBundleManager({ rootDir, timeoutMs: 3_000 });
    const first = await manager.ensureCurrent(firstSource.url);
    const second = await manager.ensureCurrent(secondSource.url);
    assert.notEqual(second.md5, first.md5);
    assert.equal(await readFile(manager.scriptPath(second), "utf8"), "module.exports={version:'second'};");
    const manifest = await manager.readManifest(secondSource.url);
    assert.equal(manifest.sourceMd5Url, secondSource.url);
    assert.equal(manifest.current?.md5, second.md5);
    assert.equal(await manager.currentVersion(firstSource.url), undefined);
    assert.equal((await manager.currentVersion(secondSource.url))?.md5, second.md5);
  } finally {
    await Promise.all([firstSource.close(), secondSource.close()]);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CatVodBundleManager repairs a corrupted current script from the original source", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "catvod-bundle-repair-"));
  const script = "module.exports={version:'repair'};";
  const source = await serverFor(script);
  try {
    const manager = new CatVodBundleManager({ rootDir, timeoutMs: 3_000 });
    const current = await manager.ensureCurrent(source.url);
    await writeFile(manager.scriptPath(current), "corrupted-script");
    const repaired = await manager.ensureCurrent(source.url);
    assert.equal(repaired.md5, current.md5);
    assert.equal(await readFile(manager.scriptPath(repaired), "utf8"), script);
  } finally {
    await source.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CatVodBundleManager recovers from a damaged manifest", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "catvod-manifest-repair-"));
  const script = "module.exports={version:'manifest-repair'};";
  const source = await serverFor(script);
  try {
    const manager = new CatVodBundleManager({ rootDir, timeoutMs: 3_000 });
    await manager.ensureCurrent(source.url);
    await writeFile(manager.manifestPath, "{broken-json");
    const recovered = await manager.ensureCurrent(source.url);
    assert.equal(recovered.md5, hash(script));
    assert.equal((await manager.readManifest(source.url)).current?.md5, recovered.md5);
    assert.ok((await readdir(rootDir)).some((name) => name.startsWith("manifest.json.corrupt-")));
  } finally {
    await source.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CatVodBundleManager keeps a verified current version available while the network is offline", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "catvod-offline-current-"));
  const script = "module.exports={version:'offline'};";
  const source = await serverFor(script);
  const manager = new CatVodBundleManager({ rootDir, timeoutMs: 500 });
  try {
    const current = await manager.ensureCurrent(source.url);
    await source.close();
    const offline = await manager.ensureCurrent(source.url);
    assert.equal(offline.md5, current.md5);
    assert.equal(await readFile(manager.scriptPath(offline), "utf8"), script);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CatVodBundleManager rejects a script whose MD5 does not match", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "catvod-bundle-"));
  const source = await serverFor("module.exports={};", "00000000000000000000000000000000");
  try {
    const manager = new CatVodBundleManager({ rootDir, timeoutMs: 3_000 });
    await assert.rejects(() => manager.ensureCurrent(source.url), /MD5 校验失败/);
    assert.equal((await manager.readManifest(source.url)).current, undefined);
  } finally {
    await source.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CatVodBundleManager keeps candidate separate and supports activation and rollback", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "catvod-bundle-"));
  let script = "module.exports={version:1};";
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith(".md5")) return void response.end(hash(script));
    if (request.url?.endsWith("index.js")) return void response.end(script);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/index.js.md5`;
  try {
    const manager = new CatVodBundleManager({ rootDir, timeoutMs: 3_000 });
    const first = await manager.ensureCurrent(url);
    script = "module.exports={version:2};";
    const checked = await manager.checkForUpdate(url);
    assert.equal(checked.state, "downloaded");
    assert.equal((await manager.readManifest(url)).current?.md5, first.md5);
    const activated = await manager.activateCandidate(url);
    assert.equal(activated.state, "activated");
    assert.notEqual(activated.current?.md5, first.md5);
    const rolledBack = await manager.rollback(url);
    assert.equal(rolledBack.current?.md5, first.md5);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(rootDir, { recursive: true, force: true });
  }
});
