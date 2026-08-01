import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { MediaProtocolService } from "./media-protocol-service.ts";
import { PlaybackSessionStore } from "./playback-session-store.ts";

const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/**
 * A loopback HTTP view of protected playback sessions for libmpv.
 *
 * Electron custom protocols are not available to libmpv.  Keeping the real
 * URL and credentials in the main process lets the native player request a
 * stable, opaque loopback address instead.
 */
export class LocalMediaGateway {
  private server?: Server;
  private port?: number;
  private readonly media: Pick<MediaProtocolService, "handle">;
  private readonly sessions: PlaybackSessionStore;

  constructor(media: Pick<MediaProtocolService, "handle">, sessions: PlaybackSessionStore) {
    this.media = media;
    this.sessions = sessions;
  }

  async start(): Promise<void> {
    if (this.port) return;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string" || !address.port) throw new Error("本地媒体网关未能分配端口");
    this.port = address.port;
  }

  playbackUrl(sessionId: string, resourceId = "root"): string {
    if (!this.port) throw new Error("本地媒体网关尚未启动");
    return `http://127.0.0.1:${this.port}/session/${encodeURIComponent(sessionId)}/resource/${encodeURIComponent(resourceId)}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      const route = parseGatewayRoute(request.url ?? "");
      const mediaRequest = new Request(this.sessions.playbackUrl(route.sessionId, route.resourceId), {
        method: request.method,
        headers: incomingHeaders(request),
      });
      const upstream = await this.media.handle(mediaRequest);
      response.writeHead(upstream.status, responseHeaders(upstream.headers));
      if (request.method === "HEAD" || !upstream.body) {
        response.end();
        logMediaRequest(request, upstream.status, upstream.headers, 0, startedAt);
        return;
      }
      let bytes = 0;
      const stream = Readable.fromWeb(upstream.body as never);
      stream.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      // The client can abort mid-stream (seek, engine switch, close) and the
      // upstream can drop the connection (net::ERR_CONNECTION_CLOSED). A Node
      // stream without an error listener turns that into a main-process
      // uncaught exception that kills playback — tear the response down
      // quietly instead.
      stream.on("error", () => {
        if (!response.writableEnded) response.destroy();
      });
      response.once("close", () => {
        // Client disconnected before the stream finished; stop reading the
        // upstream so the net.fetch body is released instead of surfacing a
        // late error.
        if (!stream.destroyed) stream.destroy();
      });
      response.once("finish", () => logMediaRequest(request, upstream.status, upstream.headers, bytes, startedAt));
      stream.pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("媒体会话不存在或已过期");
    }
  }
}

function logMediaRequest(request: IncomingMessage, status: number, headers: Headers, bytes: number, startedAt: number): void {
  const elapsedMs = Date.now() - startedAt;
  const length = headers.get("content-length") ?? headers.get("content-range")?.split("/")[1] ?? "";
  const seconds = elapsedMs / 1000;
  const rate = bytes > 0 && seconds > 0 ? bytes / 1024 / 1024 / seconds : 0;
  // No URL or credentials are logged; only the transfer shape needed to
  // diagnose buffering (per-request size, duration and throughput).
  console.log(
    `[media-gateway] ${request.method} status=${status} bytes=${bytes} total=${length} `
    + `elapsed=${elapsedMs}ms rate=${rate.toFixed(2)}MB/s range=${request.headers.range ?? "-"}`,
  );
}

function parseGatewayRoute(value: string): { sessionId: string; resourceId: string } {
  const parsed = new URL(value, "http://127.0.0.1");
  const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length !== 4 || parts[0] !== "session" || parts[2] !== "resource" || !parts[1] || !parts[3]) {
    throw new Error("invalid local media route");
  }
  return { sessionId: parts[1], resourceId: parts[3] };
}

function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(raw) ? raw.join(", ") : raw);
  }
  return headers;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) output[name] = value;
  }
  return output;
}
