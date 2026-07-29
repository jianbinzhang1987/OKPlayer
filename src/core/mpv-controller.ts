import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { createMpvIpcEndpoint, isWindowsNamedPipe } from "../desktop/platform/player-runtime.ts";

export interface MpvOptions {
  executable?: string;
  ipcPath?: string;
  startupTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

export interface MpvEvent {
  event?: string;
  name?: string;
  data?: unknown;
  error?: string;
  request_id?: number;
}

export class MpvController {
  private process?: ChildProcessWithoutNullStreams;
  private socket?: Socket;
  private readonly executable: string;
  private readonly ipcPath: string;
  private readonly startupTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  private buffer = "";
  private requestId = 0;

  constructor(options: MpvOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.executable = options.executable ?? (this.platform === "win32" ? "mpv.exe" : "mpv");
    this.ipcPath = options.ipcPath ?? createMpvIpcEndpoint({ platform: this.platform });
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
  }

  getIpcPath() {
    return this.ipcPath;
  }

  getBackend() {
    return "mpv-ipc";
  }

  isStarted() {
    return this.process !== undefined && this.socket !== undefined && !this.socket.destroyed;
  }

  async start(): Promise<void> {
    if (this.isStarted()) return;
    await this.cleanupIpcEndpoint();

    this.process = spawn(this.executable, [
      `--input-ipc-server=${this.ipcPath}`,
      "--idle=yes",
      "--force-window=yes",
      "--keep-open=yes",
      "--terminal=no",
    ], {
      windowsHide: true,
    });

    this.process.stdout.on("data", (chunk) => this.emit("stdout", chunk.toString("utf8")));
    this.process.stderr.on("data", (chunk) => this.emit("stderr", chunk.toString("utf8")));
    this.process.on("error", (error) => this.emit("error", error));
    this.process.on("exit", (code, signal) => {
      this.socket?.destroy();
      this.socket = undefined;
      this.process = undefined;
      this.emit("exit", { code, signal });
    });

    await this.connectWithRetry();
    await this.observeProperty(1, "time-pos");
    await this.observeProperty(2, "duration");
    await this.observeProperty(3, "pause");
    await this.observeProperty(4, "volume");
    await this.observeProperty(5, "mute");
  }

  private async connectWithRetry(): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.connect();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    this.process?.kill();
    this.process = undefined;
    throw new Error(`无法连接 mpv IPC：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.ipcPath);
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        socket.on("error", (error) => this.emit("error", error));
        socket.on("data", (chunk) => this.handleData(chunk.toString("utf8")));
        socket.on("close", () => {
          if (this.socket === socket) this.socket = undefined;
        });
        this.socket = socket;
        resolve();
      });
    });
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line) as MpvEvent;
        if (payload.event === "property-change" && payload.name) this.emit(payload.name, payload.data);
        if (payload.event) this.emit(payload.event, payload);
        this.emit("message", payload);
      } catch (error) {
        this.emit("error", error);
      }
    }
  }

  async load(url: string, headers: Record<string, string> = {}) {
    const headerFields = formatHttpHeaderFields(headers);
    const userAgent = headerValue(headers, "user-agent") || "Mozilla/5.0";
    const referrer = headerValue(headers, "referer") || headerValue(headers, "referrer");
    // User-Agent values commonly contain commas. Passing them through mpv's
    // comma-delimited http-header-fields option splits one valid header into
    // several malformed headers and can make otherwise valid media return 400.
    // Keep the dedicated properties separate and reset every request-scoped
    // value so credentials and referrers never leak into the next item.
    await this.command(["set_property", "user-agent", userAgent]);
    await this.command(["set_property", "referrer", referrer]);
    await this.command(["set_property", "http-header-fields", headerFields]);
    return this.command(["loadfile", url, "replace"]);
  }

  play() {
    return this.command(["set_property", "pause", false]);
  }

  pause() {
    return this.command(["set_property", "pause", true]);
  }

  stop() {
    return this.command(["stop"]);
  }

  seek(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("播放位置必须是非负数");
    return this.command(["seek", seconds, "absolute"]);
  }

  setSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 5) throw new Error("播放速度范围应为0.25到5");
    return this.command(["set_property", "speed", speed]);
  }

  setVolume(volume: number) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error("音量范围应为0到100");
    return this.command(["set_property", "volume", Math.round(volume)]);
  }

  setMuted(muted: boolean) {
    return this.command(["set_property", "mute", Boolean(muted)]);
  }

  observeProperty(id: number, name: string) {
    return this.command(["observe_property", id, name]);
  }

  async command(command: unknown[]): Promise<void> {
    this.emit("command", command);
    if (!this.socket || this.socket.destroyed) return;
    const payload = `${JSON.stringify({ command, request_id: ++this.requestId })}\n`;
    await new Promise<void>((resolve, reject) => {
      this.socket!.write(payload, (error) => error ? reject(error) : resolve());
    });
  }

  on(event: string, callback: (value: unknown) => void) {
    const callbacks = this.listeners.get(event) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(callback);
  }

  onCommand(callback: (value: unknown) => void) {
    return this.on("command", callback);
  }

  private emit(event: string, value: unknown) {
    this.listeners.get(event)?.forEach((callback) => callback(value));
  }

  async release() {
    if (this.socket && !this.socket.destroyed) {
      await this.command(["quit"]);
      this.socket.end();
      this.socket.destroy();
    }
    this.socket = undefined;
    this.process?.kill();
    this.process = undefined;
    await this.cleanupIpcEndpoint();
  }

  private async cleanupIpcEndpoint(): Promise<void> {
    if (this.platform === "win32" || isWindowsNamedPipe(this.ipcPath)) return;
    await rm(this.ipcPath, { force: true }).catch(() => undefined);
  }
}

const BLOCKED_MPV_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
]);

export function formatHttpHeaderFields(headers: Record<string, string>): string {
  const fields: string[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const normalized = name.toLowerCase();
    const value = String(rawValue ?? "").trim();
    if (!name || !value || BLOCKED_MPV_HEADERS.has(normalized)) continue;
    if (normalized === "user-agent" || normalized === "referer" || normalized === "referrer") continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    if (/[\r\n]/.test(value)) continue;
    fields.push(`${name}: ${value}`);
  }
  return fields.join(",");
}

function headerValue(headers: Record<string, string>, target: string): string {
  const entry = Object.entries(headers).find(([name]) => name.trim().toLowerCase() === target);
  const value = String(entry?.[1] ?? "").trim();
  return /[\r\n]/.test(value) ? "" : value;
}
