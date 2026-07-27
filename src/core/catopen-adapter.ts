import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseLooseData } from "./drpy-operation-runtime.ts";
import { redactSensitiveText, redactSensitiveValue } from "./log-redaction.ts";
import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import {
  runSourceOperation,
  type SourceAdapter,
  type SourceCapabilities,
} from "./source-adapter.ts";
import { parseSourceResult, parseVod } from "./vod-parser.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string; stack?: string };
  type?: string;
  level?: string;
  args?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(value: string): unknown {
  const source = value.trim();
  if (!source) return {};
  try { return JSON.parse(source); } catch {
    try { return parseLooseData(source); } catch { return source; }
  }
}

function workerEntry(): { path: string; execArgv: string[] } {
  const sourceMode = import.meta.url.endsWith(".ts");
  return {
    path: fileURLToPath(new URL(sourceMode ? "./catopen-worker.ts" : "./catopen-worker.js", import.meta.url)),
    execArgv: sourceMode ? ["--experimental-strip-types"] : [],
  };
}

class CatOpenProcess {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  async call(method: string, args: unknown[] = []): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`CatOpen 子进程调用超时：${method}`);
        reject(error);
        this.stop(error);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send?.({ id, method, args }, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CatOpen 子进程已关闭"));
    }
    this.pending.clear();
    child.disconnect?.();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.connected && this.child.exitCode === null) return this.child;
    const entry = workerEntry();
    const child = fork(entry.path, [], {
      execArgv: entry.execArgv,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.on("data", (chunk) => console.warn("[catopen-worker]", redactSensitiveText(String(chunk).trim())));
    child.on("message", (raw: unknown) => this.onMessage(raw));
    child.once("error", (error) => this.stop(error));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.stop(new Error(`CatOpen 子进程退出：code=${code ?? "null"}, signal=${signal ?? "null"}`));
    });
    this.child = child;
    return child;
  }

  private onMessage(raw: unknown): void {
    if (!isRecord(raw)) return;
    const message = raw as WorkerMessage;
    if (message.type === "log") {
      const level = message.level === "error" ? "error" : message.level === "warn" ? "warn" : "debug";
      console[level]("[catopen]", ...redactSensitiveValue(message.args ?? []));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message || "CatOpen 子进程执行失败");
      if (message.error.stack) error.stack = message.error.stack;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  private stop(error: Error): void {
    const child = this.child;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (child && !child.killed) child.kill("SIGKILL");
  }
}

function playerUrl(value: unknown, fallback: string): string {
  if (typeof value === "string") return value || fallback;
  if (Array.isArray(value)) {
    for (let index = 1; index < value.length; index += 2) {
      const candidate = value[index];
      if (typeof candidate === "string" && candidate) return candidate;
    }
  }
  return fallback;
}

function playerHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

export class CatOpenAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "catopen" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = {
    home: true,
    category: true,
    search: true,
    detail: true,
    player: true,
    proxy: true,
    health: false,
  };

  private readonly processHost: CatOpenProcess;
  private readonly timeoutMs: number;
  private readonly scriptUrl: string;
  private readonly configValue: string;
  private methods = new Set<string>();
  private initialized: Promise<void> | undefined;

  constructor(site: SiteConfig) {
    this.site = site;
    this.timeoutMs = Math.max(1, site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    if (/^https?:\/\//i.test(site.api)) {
      this.scriptUrl = site.api;
      this.configValue = site.ext ?? "";
    } else if (/^csp_catopen$/i.test(site.api) && /^https?:\/\//i.test(site.ext?.trim() ?? "")) {
      this.scriptUrl = site.ext!.trim();
      this.configValue = "";
    } else {
      throw new Error("CatOpen 需要在 api 中配置脚本 URL，或使用 csp_CatOpen + ext 脚本 URL");
    }
    this.processHost = new CatOpenProcess(this.timeoutMs);
  }

  async init(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = runSourceOperation(this.site, "init", async () => {
      const code = await this.loadScript();
      const result = await this.processHost.call("__init", [{
        code,
        config: {
          stype: this.site.type === 14 ? 4 : 3,
          skey: this.site.key,
          sourceKey: this.site.key,
          ext: parseConfig(this.configValue),
        },
        timeoutMs: this.timeoutMs,
      }]);
      this.methods = new Set(Array.isArray(result) ? result.filter((item): item is string => typeof item === "string") : []);
      const coreMethods = ["home", "homeVod", "category", "detail", "detailContent", "search", "play"];
      if (!coreMethods.some((method) => this.methods.has(method))) {
        throw new Error("脚本未导出兼容的 FongMi JavaScript Provider 方法");
      }
    });
    try {
      await this.initialized;
    } catch (error) {
      this.initialized = undefined;
      await this.processHost.close();
      throw error;
    }
  }

  async home(): Promise<SourceResult> {
    return runSourceOperation(this.site, "home", async () => {
      await this.init();
      if (this.methods.has("homeVod")) return this.sourceResult(await this.processHost.call("homeVod"));
      return this.sourceResult(await this.processHost.call("home", [true]));
    });
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      await this.init();
      const result = await this.processHost.call("category", [tid, page, Object.keys(extend).length > 0, extend]);
      return this.sourceResult(result);
    });
  }

  async search(keyword: string, page = "1"): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      await this.init();
      const result = this.sourceResult(await this.processHost.call("search", [keyword, false, page]));
      this.mark(result);
      return result;
    });
  }

  async detail(id: string): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      await this.init();
      const raw = this.methods.has("detailContent")
        ? await this.processHost.call("detailContent", [[id]])
        : await this.processHost.call("detail", [id]);
      const result = this.sourceResult(raw);
      const vod = result.list[0] ?? parseVod(raw);
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
      return vod;
    });
  }

  async player(flag: string, episodeUrl: string, flags: string[] = []): Promise<PlayerResult> {
    return runSourceOperation(this.site, "player", async () => {
      await this.init();
      const raw = await this.processHost.call("play", [flag, episodeUrl, flags]);
      const value = typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : isRecord(raw) ? raw : {};
      return {
        key: this.site.key,
        flag: typeof value.flag === "string" && value.flag ? value.flag : flag,
        url: playerUrl(value.url, episodeUrl),
        parse: Number(value.parse ?? value.jx ?? 0),
        playUrl: typeof value.playUrl === "string" ? value.playUrl : "",
        header: { ...(this.site.header ?? {}), ...playerHeaders(value.header ?? value.headers) },
        ...(typeof value.format === "string" ? { format: value.format } : {}),
      };
    });
  }

  async proxy(params: Record<string, string>): Promise<unknown> {
    return runSourceOperation(this.site, "proxy", async () => {
      await this.init();
      if (!this.methods.has("proxy")) return [];
      return this.processHost.call("proxy", [params]);
    });
  }

  async destroy(): Promise<void> {
    await this.processHost.close();
    this.initialized = undefined;
    this.methods.clear();
  }

  private sourceResult(raw: unknown): SourceResult {
    let value = raw;
    if (typeof raw === "string") {
      try { value = JSON.parse(raw); } catch { return { list: [], pageCount: 0, message: "" }; }
    }
    const result = parseSourceResult(value);
    this.mark(result);
    return result;
  }

  private mark(result: SourceResult): void {
    result.list.forEach((vod) => {
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
    });
  }

  private async loadScript(): Promise<string> {
    const response = await fetch(this.scriptUrl, {
      headers: { ...(this.site.header ?? {}) },
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`CatOpen 脚本下载失败：HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_SCRIPT_BYTES) throw new Error(`CatOpen 脚本超过 ${MAX_SCRIPT_BYTES} bytes 限制`);
    const code = await response.text();
    if (Buffer.byteLength(code, "utf8") > MAX_SCRIPT_BYTES) throw new Error(`CatOpen 脚本超过 ${MAX_SCRIPT_BYTES} bytes 限制`);
    return code;
  }
}
