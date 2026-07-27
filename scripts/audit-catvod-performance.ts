import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CatVodBundleManager } from "../src/core/catvod/catvod-bundle-manager.ts";
import { parseCatVodConfig } from "../src/core/catvod/catvod-config-parser.ts";
import { DEFAULT_CATVOD_MD5_URL } from "../src/core/catvod/catvod-types.ts";

const execFileAsync = promisify(execFile);
const sourceMd5Url = process.argv[2]?.trim() || DEFAULT_CATVOD_MD5_URL;
const rootDir = await mkdtemp(path.join(os.tmpdir(), "fongmi-catvod-performance-"));
const artifactDir = path.resolve("artifacts/catvod-performance");
const manager = new CatVodBundleManager({ rootDir, timeoutMs: 30_000 });
let child: ReturnType<typeof spawn> | undefined;

try {
  const bundleStartedAt = performance.now();
  const version = await manager.ensureCurrent(sourceMd5Url);
  const bundleMs = Math.round(performance.now() - bundleStartedAt);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const startupStartedAt = performance.now();
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

  await waitForHealth(baseUrl, 60_000);
  const startupMs = Math.round(performance.now() - startupStartedAt);
  const configSamples: number[] = [];
  const parseSamples: number[] = [];
  let parsed = parseCatVodConfig({});
  for (let index = 0; index < 5; index += 1) {
    const requestStartedAt = performance.now();
    const config = await getJson(`${baseUrl}/config`, 20_000);
    configSamples.push(Math.round(performance.now() - requestStartedAt));
    const parseStartedAt = performance.now();
    parsed = parseCatVodConfig(config);
    parseSamples.push(Math.round(performance.now() - parseStartedAt));
  }
  await delay(2_000);
  const resources = child.pid ? await processResources(child.pid) : {};
  child.kill("SIGTERM");
  await waitForExit(child, 5_000);
  const portReleased = await isUnavailable(`${baseUrl}/health`);

  const configAverageMs = Math.round(configSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, configSamples.length));
  const parseAverageMs = Math.round(parseSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, parseSamples.length));
  const report = {
    auditedAt: new Date().toISOString(),
    sourceMd5Url,
    versionMd5: version.md5,
    siteCount: parsed.summary.siteCount,
    timings: {
      bundleMs,
      startupMs,
      configSamplesMs: configSamples,
      configAverageMs,
      parseSamplesMs: parseSamples,
      parseAverageMs,
    },
    resources,
    portReleased,
    thresholds: {
      startupUnder60Seconds: startupMs < 60_000,
      configAverageUnder10Seconds: configAverageMs < 10_000,
      parseAverageUnder1Second: parseAverageMs < 1_000,
      siteCountLoaded: parsed.summary.siteCount > 0,
      rssUnder512MB: resources.rssMb === undefined || resources.rssMb < 512,
      idleCpuUnder25Percent: resources.cpuPercent === undefined || resources.cpuPercent < 25,
      portReleased,
    },
  };
  const passed = Object.values(report.thresholds).every(Boolean);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify({ ...report, passed }, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactDir, "report.md"), renderMarkdown({ ...report, passed }), "utf8");
  console.log(JSON.stringify({ ...report, passed }, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  const failure = { auditedAt: new Date().toISOString(), passed: false, message: error instanceof Error ? error.stack ?? error.message : String(error) };
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  child?.kill("SIGTERM");
  await waitForExit(child, 3_000);
  await rm(rootDir, { recursive: true, force: true });
}

async function processResources(pid: number): Promise<{ rssMb?: number; cpuPercent?: number }> {
  if (!['darwin', 'linux'].includes(process.platform)) return {};
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)]);
    const [rss, cpu] = stdout.trim().split(/\s+/).map(Number);
    return {
      ...(typeof rss === "number" && Number.isFinite(rss) ? { rssMb: Math.round((rss / 1024) * 100) / 100 } : {}),
      ...(typeof cpu === "number" && Number.isFinite(cpu) ? { cpuPercent: cpu } : {}),
    };
  } catch {
    return {};
  }
}

async function waitForHealth(baseUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = "服务尚未响应";
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
  const value = await response.json();
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

async function isUnavailable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return false;
  } catch {
    return true;
  }
}

function waitForExit(target: ReturnType<typeof spawn> | undefined, timeoutMs: number): Promise<void> {
  if (!target || target.exitCode !== null) return Promise.resolve();
  return Promise.race([new Promise<void>((resolve) => target.once("exit", () => resolve())), delay(timeoutMs)]);
}

function proxyEnvironment(): NodeJS.ProcessEnv {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  return Object.fromEntries(keys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

function renderMarkdown(report: any): string {
  return `# CatVod 性能与资源基线\n\n- 时间：${report.auditedAt}\n- 结果：${report.passed ? "通过" : "失败"}\n- 版本：${report.versionMd5}\n- 站点数：${report.siteCount}\n- Bundle 准备：${report.timings.bundleMs} ms\n- 服务启动：${report.timings.startupMs} ms\n- /config 平均：${report.timings.configAverageMs} ms\n- 配置解析平均：${report.timings.parseAverageMs} ms\n- RSS：${report.resources.rssMb ?? "未采集"} MB\n- 空闲 CPU：${report.resources.cpuPercent ?? "未采集"}%\n- 退出后端口释放：${report.portReleased ? "是" : "否"}\n`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
