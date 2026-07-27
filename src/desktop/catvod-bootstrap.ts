import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { redactSensitiveError } from "../core/log-redaction.ts";
import {
  createCatVodNetworkAuditEvent,
  normalizeCatVodRemoteAccessPolicy,
  requestMethodFromNodeArgs,
  requestUrlFromNodeArgs,
  type CatVodNetworkAuditEvent,
} from "./catvod-network-audit.ts";

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data?: unknown } | unknown) => void): void;
}

interface HostRequestMessage {
  type: "catvod-host-request";
  id: string;
  payload: unknown;
}

interface HostResponseMessage {
  type: "catvod-host-response";
  id: string;
  result?: unknown;
  error?: string;
}

interface CatVodModule {
  start?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
}

interface NetworkAuditMessage {
  type: "catvod-network-audit";
  access: CatVodNetworkAuditEvent;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
let bridgeServer: http.Server | undefined;
let catVodModule: CatVodModule | undefined;
let startupAuditActive = true;
const remoteAccessPolicy = normalizeCatVodRemoteAccessPolicy(process.env.CATVOD_REMOTE_ACCESS_POLICY);

parentPort?.on("message", (event) => {
  const message = ((event as { data?: unknown })?.data ?? event) as Partial<HostResponseMessage>;
  if (message.type !== "catvod-host-response" || !message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(message.result ?? null);
});

void main().catch((error) => {
  console.error("CatVod bootstrap failed", redactSensitiveError(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  installStartupNetworkAudit();
  const auditWindowMs = Math.max(1_000, Math.min(60_000, Number(process.env.CATVOD_REMOTE_AUDIT_WINDOW_MS) || 15_000));
  const auditTimer = setTimeout(() => { startupAuditActive = false; }, auditWindowMs);
  auditTimer.unref();

  bridgeServer = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/msg") {
      response.writeHead(404).end("Not Found");
      return;
    }
    try {
      const payload = JSON.parse(await readBody(request)) as unknown;
      const result = await requestHost(payload);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result ?? null));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: redactSensitiveError(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    bridgeServer!.once("error", reject);
    bridgeServer!.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });

  const address = bridgeServer.address();
  const bridgePort = typeof address === "object" && address ? address.port : 0;
  if (!bridgePort) throw new Error("CatVod 宿主桥未取得监听端口");
  (globalThis as Record<string, unknown>).catDartServerPort = () => bridgePort;

  const scriptPath = process.env.CATVOD_SCRIPT_PATH?.trim();
  if (!scriptPath) throw new Error("缺少 CATVOD_SCRIPT_PATH");
  const requireFromRuntime = createRequire(path.join(process.cwd(), "catvod-bootstrap.cjs"));
  catVodModule = requireFromRuntime(scriptPath) as CatVodModule;
  if (typeof catVodModule.start !== "function") throw new Error("CatVod 脚本未导出 start 方法");
  await catVodModule.start();

  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
}

async function shutdown(): Promise<void> {
  await catVodModule?.stop?.().catch(() => undefined);
  if (bridgeServer) await new Promise<void>((resolve) => bridgeServer!.close(() => resolve()));
}

function installStartupNetworkAudit(): void {
  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (originalFetch) {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const method = init?.method ?? (typeof input === "object" && input !== null && "method" in input ? String(input.method) : "GET");
      auditRemoteAccess(input, method);
      return originalFetch(input, init);
    }) as typeof fetch;
  }

  wrapNodeClient(http, "http:");
  wrapNodeClient(https, "https:");
}

function wrapNodeClient(
  module: typeof http | typeof https,
  protocol: "http:" | "https:",
): void {
  const originalRequest = module.request.bind(module) as (...args: any[]) => http.ClientRequest;
  const originalGet = module.get.bind(module) as (...args: any[]) => http.ClientRequest;
  module.request = ((...args: any[]) => {
    auditRemoteAccess(requestUrlFromNodeArgs(protocol, args), requestMethodFromNodeArgs(args, "GET"));
    return originalRequest(...args);
  }) as typeof module.request;
  module.get = ((...args: any[]) => {
    auditRemoteAccess(requestUrlFromNodeArgs(protocol, args), requestMethodFromNodeArgs(args, "GET"));
    return originalGet(...args);
  }) as typeof module.get;
}

function auditRemoteAccess(value: unknown, method: unknown): void {
  const access = createCatVodNetworkAuditEvent(value, method, remoteAccessPolicy, startupAuditActive);
  if (!access) return;
  const message: NetworkAuditMessage = { type: "catvod-network-audit", access };
  parentPort?.postMessage(message);
  if (access.blocked) throw new Error(`CatVod 启动阶段远程访问已被策略阻止：${access.origin}`);
}

function requestHost(payload: unknown): Promise<unknown> {
  if (!parentPort) return Promise.resolve(null);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, 3_000);
    pending.set(id, { resolve, reject, timer });
    const message: HostRequestMessage = { type: "catvod-host-request", id, payload };
    parentPort.postMessage(message);
  });
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("CatVod 宿主消息过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}
