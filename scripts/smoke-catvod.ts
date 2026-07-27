import { app } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatVodBundleManager } from "../src/core/catvod/catvod-bundle-manager.ts";
import { DEFAULT_CATVOD_MD5_URL } from "../src/core/catvod/catvod-types.ts";
import { CatVodProcessManager } from "../src/desktop/catvod-process-manager.ts";

const resultArgument = process.argv.find((value) => value.startsWith("--smoke-result="));
const resultFile = resultArgument?.slice("--smoke-result=".length);
const rootDir = await mkdtemp(path.join(os.tmpdir(), "fongmi-catvod-electron-"));

await app.whenReady();
let manager: CatVodProcessManager | undefined;
try {
  const bundleManager = new CatVodBundleManager({ rootDir, timeoutMs: 30_000 });
  const hostActions: string[] = [];
  manager = new CatVodProcessManager({
    bundleManager,
    sourceMd5Url: DEFAULT_CATVOD_MD5_URL,
    bootstrapPath: path.resolve("dist/main/catvod-bootstrap.cjs"),
    startTimeoutMs: 45_000,
    hostMessageHandler: async (payload) => {
      const record = typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const action = String(record.action ?? "");
      if (action) hostActions.push(action);
      if (action === "queryProfile") return {};
      if (action === "saveProfile") return { ok: true };
      return null;
    },
  });

  const status = await manager.start();
  if (status.state !== "running" || !status.baseUrl) throw new Error(`CatVod 未进入 running：${JSON.stringify(status)}`);
  const health = await fetch(`${status.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json()) as { ok?: boolean };
  const config = await fetch(`${status.baseUrl}/config`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.json()) as { video?: { sites?: unknown[] } };
  if (health.ok !== true) throw new Error("Electron CatVod 健康检查失败");
  const siteCount = Array.isArray(config.video?.sites) ? config.video.sites.length : 0;
  if (siteCount < 1) throw new Error("Electron CatVod 配置为空");

  const initialPort = status.port;
  const initialStartedAt = status.startedAt ?? 0;
  const child = (manager as unknown as { child?: { kill(): void } }).child;
  if (!child) throw new Error("CatVod Utility Process 不存在");
  child.kill();
  const restarted = await waitForRunning(manager, initialStartedAt, 50_000);
  if (!restarted.baseUrl) throw new Error("CatVod 异常重启后缺少 baseUrl");
  const restartedHealth = await fetch(`${restarted.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json()) as { ok?: boolean };
  if (restartedHealth.ok !== true) throw new Error("CatVod 异常退出后自动重启健康检查失败");

  const stopped = await manager.stop();
  const stoppedPortClosed = await isUnavailable(restarted.baseUrl);
  const secondStart = await manager.start();
  if (secondStart.state !== "running" || !secondStart.baseUrl) throw new Error("CatVod 停止后再次启动失败");
  const finalStop = await manager.stop();
  const finalPortClosed = await isUnavailable(secondStart.baseUrl);
  const result = {
    status: "passed",
    versionMd5: status.versionMd5,
    initialPort,
    restartedPort: restarted.port,
    secondStartPort: secondStart.port,
    siteCount,
    hostActions,
    autoRestarted: restarted.state === "running" && (restarted.startedAt ?? 0) > initialStartedAt,
    stopped: stopped.state === "stopped" && finalStop.state === "stopped",
    stoppedPortClosed,
    finalPortClosed,
  };
  if (!result.autoRestarted || !result.stopped || !stoppedPortClosed || !finalPortClosed) {
    throw new Error(`CatVod 生命周期验证失败：${JSON.stringify(result)}`);
  }
  if (resultFile) await writeFile(resultFile, JSON.stringify(result));
  console.log(JSON.stringify(result));
} catch (error) {
  const result = {
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
  if (resultFile) await writeFile(resultFile, JSON.stringify(result));
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  await manager?.stop().catch(() => undefined);
  await rm(rootDir, { recursive: true, force: true });
  app.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
}

async function waitForRunning(manager: CatVodProcessManager, previousStartedAt: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = manager.status();
  while (Date.now() < deadline) {
    last = manager.status();
    if (last.state === "running" && (last.startedAt ?? 0) > previousStartedAt) return last;
    if (last.state === "error") throw new Error(last.message ?? "CatVod 自动重启失败");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待 CatVod 自动重启超时：${JSON.stringify(last)}`);
}

async function isUnavailable(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_500) });
    return false;
  } catch {
    return true;
  }
}
