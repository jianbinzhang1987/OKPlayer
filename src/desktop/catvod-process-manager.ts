import { utilityProcess, type UtilityProcess } from "electron";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { CatVodBundleManager } from "../core/catvod/catvod-bundle-manager.ts";
import { appendCatVodLog, maskCatVodLogSecrets } from "./catvod-log-service.ts";
import type {
  CatVodBundleVersion,
  CatVodRemoteAccessPolicy,
  CatVodRemoteAccessRecord,
  CatVodServiceStatus,
  CatVodUpdateResult,
} from "../core/catvod/catvod-types.ts";

const START_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 250;
const logWriteQueues = new Map<string, Promise<void>>();

export type CatVodHostMessageHandler = (payload: unknown) => Promise<unknown> | unknown;

export interface CatVodProcessManagerOptions {
  bundleManager: CatVodBundleManager;
  sourceMd5Url: string;
  bootstrapPath: string;
  startTimeoutMs?: number;
  hostMessageHandler?: CatVodHostMessageHandler;
  remoteAccessPolicy?: CatVodRemoteAccessPolicy;
}

export class CatVodProcessManager {
  readonly bundleManager: CatVodBundleManager;

  private sourceMd5Url: string;
  private readonly bootstrapPath: string;
  private readonly startTimeoutMs: number;
  private hostMessageHandler?: CatVodHostMessageHandler;
  private child?: UtilityProcess;
  private currentStatus: CatVodServiceStatus;
  private stopping = false;
  private restartAttempts = 0;
  private remoteAccessPolicy: CatVodRemoteAccessPolicy;

  constructor(options: CatVodProcessManagerOptions) {
    this.bundleManager = options.bundleManager;
    this.sourceMd5Url = options.sourceMd5Url;
    this.bootstrapPath = options.bootstrapPath;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.hostMessageHandler = options.hostMessageHandler;
    this.remoteAccessPolicy = options.remoteAccessPolicy ?? "allow";
    this.currentStatus = {
      state: "stopped",
      sourceMd5Url: this.sourceMd5Url,
      remoteAccessPolicy: this.remoteAccessPolicy,
      remoteAccesses: [],
    };
  }

  status(): CatVodServiceStatus {
    return {
      ...this.currentStatus,
      remoteAccesses: this.currentStatus.remoteAccesses?.map((item) => ({ ...item })) ?? [],
    };
  }

  setSourceMd5Url(value: string): void {
    this.sourceMd5Url = value.trim();
    this.currentStatus.sourceMd5Url = this.sourceMd5Url;
  }

  setHostMessageHandler(handler?: CatVodHostMessageHandler): void {
    this.hostMessageHandler = handler;
  }

  setRemoteAccessPolicy(value: CatVodRemoteAccessPolicy): void {
    this.remoteAccessPolicy = value === "block-startup" ? "block-startup" : "allow";
    this.currentStatus.remoteAccessPolicy = this.remoteAccessPolicy;
  }

  async start(sourceMd5Url = this.sourceMd5Url): Promise<CatVodServiceStatus> {
    if (this.child && this.currentStatus.state === "running") return this.status();
    this.setSourceMd5Url(sourceMd5Url);
    this.stopping = false;
    this.currentStatus = {
      state: "starting",
      sourceMd5Url: this.sourceMd5Url,
      remoteAccessPolicy: this.remoteAccessPolicy,
      remoteAccesses: [],
      message: "正在准备 CatVod 服务",
    };

    try {
      const version = await this.bundleManager.ensureCurrent(this.sourceMd5Url);
      return await this.startVersion(version, false);
    } catch (error) {
      this.currentStatus = {
        ...this.currentStatus,
        state: "error",
        sourceMd5Url: this.sourceMd5Url,
        remoteAccessPolicy: this.remoteAccessPolicy,
        message: errorMessage(error),
      };
      throw error;
    }
  }

  async stop(): Promise<CatVodServiceStatus> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (child) child.kill();
    this.currentStatus = {
      ...this.currentStatus,
      state: "stopped",
      sourceMd5Url: this.sourceMd5Url,
      versionMd5: this.currentStatus.versionMd5,
      remoteAccessPolicy: this.remoteAccessPolicy,
      message: "CatVod 服务已停止",
    };
    return this.status();
  }

  async restart(): Promise<CatVodServiceStatus> {
    await this.stop();
    this.restartAttempts = 0;
    return this.start();
  }

  async inspectUpdate(): Promise<CatVodUpdateResult> {
    const remote = await this.bundleManager.inspectRemote(this.sourceMd5Url);
    const current = await this.bundleManager.currentVersion(this.sourceMd5Url);
    const manifest = await this.bundleManager.readManifest(this.sourceMd5Url);
    this.currentStatus = {
      ...this.currentStatus,
      candidateMd5: manifest.candidate?.md5,
      previousMd5: manifest.previous?.md5,
    };
    if (current?.md5 === remote.md5) {
      return {
        state: "current",
        current,
        candidate: manifest.candidate,
        previous: manifest.previous,
        message: "当前已经是最新的 CatVod 版本",
      };
    }
    return {
      state: "available",
      current,
      candidate: manifest.candidate,
      previous: manifest.previous,
      message: `检测到 CatVod 新版本 ${remote.md5}，尚未下载`,
    };
  }

  async checkForUpdate(): Promise<CatVodUpdateResult> {
    const result = await this.bundleManager.checkForUpdate(this.sourceMd5Url);
    const manifest = await this.bundleManager.readManifest(this.sourceMd5Url);
    this.currentStatus = {
      ...this.currentStatus,
      candidateMd5: manifest.candidate?.md5,
      previousMd5: manifest.previous?.md5,
    };
    return result;
  }

  async activateCandidate(): Promise<CatVodUpdateResult> {
    const manifest = await this.bundleManager.readManifest(this.sourceMd5Url);
    if (!manifest.candidate) throw new Error("当前没有可激活的 CatVod 候选版本");
    await this.smokeTest(manifest.candidate);
    await this.stop();
    const result = await this.bundleManager.activateCandidate(this.sourceMd5Url);
    await this.start();
    return result;
  }

  async rollback(): Promise<CatVodUpdateResult> {
    await this.stop();
    const result = await this.bundleManager.rollback(this.sourceMd5Url);
    await this.start();
    return result;
  }

  setSiteCount(siteCount: number): void {
    this.currentStatus.siteCount = Math.max(0, siteCount);
  }

  private async startVersion(version: CatVodBundleVersion, smoke: boolean): Promise<CatVodServiceStatus> {
    await this.bundleManager.initialize();
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const scriptPath = this.bundleManager.scriptPath(version);
    const child = utilityProcess.fork(this.bootstrapPath, [], {
      cwd: this.bundleManager.runtimeDir,
      env: childEnvironment(port, smoke, scriptPath, this.remoteAccessPolicy),
      stdio: "pipe",
      serviceName: smoke ? "CatVod Candidate Smoke Test" : "CatVod Node Service",
      disclaim: true,
    });

    this.bindHostBridge(child);
    const logFile = path.join(this.bundleManager.logsDir, smoke ? "candidate.log" : "service.log");
    await mkdir(path.dirname(logFile), { recursive: true });
    pipeLogs(child, logFile);

    if (!smoke) {
      this.child = child;
      this.currentStatus = {
        ...this.currentStatus,
        state: "starting",
        sourceMd5Url: this.sourceMd5Url,
        port,
        baseUrl,
        versionMd5: version.md5,
        previousMd5: (await this.bundleManager.readManifest(this.sourceMd5Url)).previous?.md5,
        remoteAccessPolicy: this.remoteAccessPolicy,
        message: "CatVod 子进程已经启动，正在等待健康检查",
      };
      child.once("exit", () => void this.handleUnexpectedExit(version, child));
    }

    try {
      await waitForService(baseUrl, this.startTimeoutMs);
      const config = await fetchJson(`${baseUrl}/config`, 10_000);
      const siteCount = countSites(config);
      if (smoke) {
        child.kill();
        return {
          state: "running",
          sourceMd5Url: this.sourceMd5Url,
          port,
          baseUrl,
          versionMd5: version.md5,
          siteCount,
          remoteAccessPolicy: this.remoteAccessPolicy,
          remoteAccesses: this.currentStatus.remoteAccesses?.map((item) => ({ ...item })) ?? [],
          message: "候选版本冒烟测试通过",
        };
      }
      this.restartAttempts = 0;
      this.currentStatus = {
        ...this.currentStatus,
        state: "running",
        sourceMd5Url: this.sourceMd5Url,
        port,
        baseUrl,
        versionMd5: version.md5,
        startedAt: Date.now(),
        siteCount,
        candidateMd5: (await this.bundleManager.readManifest(this.sourceMd5Url)).candidate?.md5,
        previousMd5: (await this.bundleManager.readManifest(this.sourceMd5Url)).previous?.md5,
        remoteAccessPolicy: this.remoteAccessPolicy,
        message: "CatVod 服务运行正常",
      };
      return this.status();
    } catch (error) {
      child.kill();
      if (!smoke) this.child = undefined;
      throw error;
    }
  }

  private async smokeTest(version: CatVodBundleVersion): Promise<void> {
    await this.startVersion(version, true);
  }

  private bindHostBridge(child: UtilityProcess): void {
    child.on("message", (event) => {
      const message = ((event as { data?: unknown })?.data ?? event) as {
        type?: string;
        id?: string;
        payload?: unknown;
        access?: unknown;
      };
      if (message.type === "catvod-network-audit") {
        this.recordRemoteAccess(message.access);
        return;
      }
      if (message.type !== "catvod-host-request" || !message.id) return;
      Promise.resolve(this.hostMessageHandler?.(message.payload) ?? null)
        .then((result) => child.postMessage({
          type: "catvod-host-response",
          id: message.id,
          result,
        }))
        .catch((error) => child.postMessage({
          type: "catvod-host-response",
          id: message.id,
          error: errorMessage(error),
        }));
    });
  }

  private recordRemoteAccess(value: unknown): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const origin = typeof record.origin === "string" ? record.origin.trim() : "";
    const method = typeof record.method === "string" ? record.method.trim().toUpperCase() : "GET";
    const blocked = record.blocked === true;
    const at = Number(record.at) || Date.now();
    if (!origin || !/^https?:\/\//i.test(origin)) return;
    const items = this.currentStatus.remoteAccesses ?? [];
    const existing = items.find((item) => item.origin === origin && item.method === method && item.blocked === blocked);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = at;
    } else {
      const next: CatVodRemoteAccessRecord = {
        origin,
        method,
        phase: "startup",
        blocked,
        count: 1,
        firstSeenAt: at,
        lastSeenAt: at,
      };
      items.push(next);
    }
    this.currentStatus.remoteAccesses = items.slice(0, 100);
  }

  private async handleUnexpectedExit(version: CatVodBundleVersion, exitedChild: UtilityProcess): Promise<void> {
    if (this.stopping || this.child !== exitedChild) return;
    this.child = undefined;
    if (this.restartAttempts >= 1) {
      this.currentStatus = {
        ...this.currentStatus,
        state: "error",
        sourceMd5Url: this.sourceMd5Url,
        versionMd5: version.md5,
        remoteAccessPolicy: this.remoteAccessPolicy,
        message: "CatVod 服务异常退出，自动重启仍失败",
      };
      return;
    }
    this.restartAttempts += 1;
    this.currentStatus = {
      ...this.currentStatus,
      state: "starting",
      sourceMd5Url: this.sourceMd5Url,
      versionMd5: version.md5,
      remoteAccessPolicy: this.remoteAccessPolicy,
      message: "CatVod 服务异常退出，正在自动重启一次",
    };
    try {
      await this.startVersion(version, false);
    } catch (error) {
      this.currentStatus = {
        ...this.currentStatus,
        state: "error",
        sourceMd5Url: this.sourceMd5Url,
        versionMd5: version.md5,
        remoteAccessPolicy: this.remoteAccessPolicy,
        message: `CatVod 自动重启失败：${errorMessage(error)}`,
      };
    }
  }
}

function childEnvironment(
  port: number,
  smoke: boolean,
  scriptPath: string,
  remoteAccessPolicy: CatVodRemoteAccessPolicy,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.HOST = "127.0.0.1";
  env.PORT = String(port);
  env.DEV_HTTP_PORT = String(port);
  env.NODE_ENV = "production";
  env.CATVOD_SCRIPT_PATH = scriptPath;
  env.CATVOD_REMOTE_ACCESS_POLICY = remoteAccessPolicy;
  env.CATVOD_REMOTE_AUDIT_WINDOW_MS = "15000";
  if (smoke) env.CATVOD_SMOKE_TEST = "1";
  return env;
}

function pipeLogs(child: UtilityProcess, logFile: string): void {
  const write = (source: "stdout" | "stderr", chunk: unknown) => {
    const value = maskCatVodLogSecrets(String(chunk));
    const line = `[${new Date().toISOString()}] [${source}] ${value}`;
    const previous = logWriteQueues.get(logFile) ?? Promise.resolve();
    const next = previous.then(() => appendCatVodLog(logFile, line)).catch(() => undefined);
    logWriteQueues.set(logFile, next);
    void next.finally(() => {
      if (logWriteQueues.get(logFile) === next) logWriteQueues.delete(logFile);
    });
  };
  child.stdout?.on("data", (chunk) => write("stdout", chunk));
  child.stderr?.on("data", (chunk) => write("stderr", chunk));
}

async function waitForService(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "服务尚未响应";
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`, 1_500);
      if (health.ok === true) return;
      lastError = "健康检查返回异常";
    } catch (error) {
      lastError = errorMessage(error);
    }
    await delay(HEALTH_INTERVAL_MS);
  }
  throw new Error(`CatVod 服务启动超时：${lastError}`);
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("响应不是 JSON 对象");
  return value as Record<string, unknown>;
}

function countSites(config: Record<string, unknown>): number {
  const video = typeof config.video === "object" && config.video !== null && !Array.isArray(config.video)
    ? config.video as Record<string, unknown>
    : {};
  return Array.isArray(video.sites) ? video.sites.length : 0;
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
