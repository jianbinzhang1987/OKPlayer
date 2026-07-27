import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CatVodBundleManager } from "../src/core/catvod/catvod-bundle-manager.ts";
import { parseCatVodConfig } from "../src/core/catvod/catvod-config-parser.ts";
import { DEFAULT_CATVOD_MD5_URL } from "../src/core/catvod/catvod-types.ts";

const sourceMd5Url = process.argv[2]?.trim() || DEFAULT_CATVOD_MD5_URL;
const rootDir = await mkdtemp(path.join(os.tmpdir(), "fongmi-catvod-live-"));
const manager = new CatVodBundleManager({ rootDir, timeoutMs: 30_000 });
let child: ReturnType<typeof spawn> | undefined;

try {
  const version = await manager.ensureCurrent(sourceMd5Url);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.resolve("dist/main/catvod-bootstrap.cjs")], {
    cwd: manager.runtimeDir,
    env: {
      ...proxyEnvironment(),
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      HOST: "127.0.0.1",
      PORT: String(port),
      DEV_HTTP_PORT: String(port),
      NODE_ENV: "production",
      CATVOD_SCRIPT_PATH: manager.scriptPath(version),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  await waitForHealth(baseUrl, 45_000);
  const config = await getJson(`${baseUrl}/config`, 20_000);
  const parsed = parseCatVodConfig(config);
  if (parsed.summary.siteCount < 1) throw new Error("CatVod /config 未返回任何站点");

  const douban = parsed.sites.find((site) => site.contentType === "discovery");
  let homeCount = 0;
  let categoryCount = 0;
  if (douban?.originKey) {
    const home = await postJson(`${baseUrl}/spider/${douban.originKey.replace(/^nodejs_/, "")}/3/home`, { filter: true }, 25_000);
    homeCount = array(home.list).length;
    const firstCategory = array(home.class)[0] as Record<string, unknown> | undefined;
    const categoryId = text(firstCategory?.type_id);
    if (categoryId) {
      const category = await postJson(`${baseUrl}/spider/${douban.originKey.replace(/^nodejs_/, "")}/3/category`, {
        id: categoryId,
        tid: categoryId,
        page: 1,
        pg: 1,
        filters: {},
        extend: {},
      }, 25_000);
      categoryCount = array(category.list).length;
    }
  }
  if (homeCount < 1) throw new Error("CatVod 发现型首页未返回内容");

  const flows = await findPlayableFlows(baseUrl, parsed.sites, 3);
  const report = {
    status: "passed",
    sourceMd5Url,
    versionMd5: version.md5,
    sha256: version.sha256,
    siteCount: parsed.summary.siteCount,
    discoveryCount: parsed.summary.discoveryCount,
    vodCount: parsed.summary.vodCount,
    hiddenCount: parsed.summary.hiddenCount,
    homeCount,
    categoryCount,
    playableFlow: flows[0],
    playableFlows: flows,
    coverage: {
      minimumThreeSources: flows.length >= 3,
      hasHeaderSource: flows.some((flow) => flow.hasHeaders),
      hasLocalProxySource: flows.some((flow) => flow.urlKind === "local-proxy"),
    },
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  child?.kill("SIGTERM");
  await waitForExit(child, 3_000);
  await rm(rootDir, { recursive: true, force: true });
}

async function findPlayableFlows(baseUrl: string, sites: ReturnType<typeof parseCatVodConfig>["sites"], minimum: number) {
  const candidates = [
    "wexaitiantang", "ikanbot", "guazi", "wexDuBoKu", "wencai", "v6dashixiong", "wogg",
  ];
  const available = new Map(sites.map((site) => [site.originKey?.replace(/^nodejs_/, ""), site]));
  const failures: string[] = [];
  const flows: Array<{
    siteKey: string;
    siteName: string;
    searchResult: string;
    flag: string;
    parse: number;
    urlKind: "local-proxy" | "remote" | "opaque";
    hasHeaders: boolean;
  }> = [];
  for (const key of candidates) {
    const site = available.get(key);
    if (!site || site.searchable === 0) continue;
    try {
      const search = await postJson(`${baseUrl}/spider/${key}/3/search`, {
        wd: "庆余年",
        key: "庆余年",
        page: 1,
        pg: 1,
        quick: false,
      }, 25_000);
      const searchItem = array(search.list)[0] as Record<string, unknown> | undefined;
      const vodId = text(searchItem?.vod_id ?? searchItem?.id);
      if (!vodId) throw new Error("搜索无结果");

      const detail = await postJson(`${baseUrl}/spider/${key}/3/detail`, { id: [vodId] }, 30_000);
      const vod = array(detail.list)[0] as Record<string, unknown> | undefined;
      if (!vod) throw new Error("详情为空");
      const flag = text(vod.vod_play_from).split("$$$")[0]?.trim() ?? "";
      const firstLine = text(vod.vod_play_url).split("$$$")[0] ?? "";
      const firstEpisode = firstLine.split("#").find(Boolean) ?? "";
      const separator = firstEpisode.indexOf("$");
      const episodeId = (separator >= 0 ? firstEpisode.slice(separator + 1) : firstEpisode).trim();
      if (!flag || !episodeId) throw new Error("详情未返回可播放剧集");

      const play = await postJson(`${baseUrl}/spider/${key}/3/play`, {
        flag,
        id: episodeId,
        flags: [],
      }, 30_000);
      const playUrl = extractPlayerUrl(play.url);
      if (!playUrl) throw new Error("播放接口未返回 URL");
      flows.push({
        siteKey: key,
        siteName: site.name,
        searchResult: text(searchItem?.vod_name ?? searchItem?.name),
        flag,
        parse: Number(play.parse ?? play.jx ?? 0),
        urlKind: /^https?:\/\/127\.0\.0\.1/.test(playUrl) ? "local-proxy" : /^https?:\/\//.test(playUrl) ? "remote" : "opaque",
        hasHeaders: Object.keys(record(play.header ?? play.headers)).length > 0,
      });
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (flows.length >= minimum) return flows;
  throw new Error(`仅找到 ${flows.length}/${minimum} 个可完成搜索—详情—播放的抽样站点：${failures.join("；")}`);
}

async function waitForHealth(baseUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = "not started";
  while (Date.now() < deadline) {
    try {
      const health = await getJson(`${baseUrl}/health`, 2_000);
      if (health.ok === true) return;
      last = JSON.stringify(health);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`CatVod 启动超时：${last}`);
}

async function getJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return record(await response.json());
}

async function postJson(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.slice(0, 120)}`);
  try {
    return record(JSON.parse(payload));
  } catch {
    throw new Error(`响应不是 JSON：${payload.slice(0, 120)}`);
  }
}

function extractPlayerUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (let index = 1; index < value.length; index += 2) {
      if (typeof value[index] === "string" && value[index]) return value[index];
    }
  }
  return "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function proxyEnvironment(): NodeJS.ProcessEnv {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  return Object.fromEntries(keys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn> | undefined, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(timeoutMs).then(() => undefined),
  ]);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
