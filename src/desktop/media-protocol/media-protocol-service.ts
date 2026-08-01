import type { Protocol } from "electron";
import { rewriteHlsManifest } from "./hls-manifest-rewriter.ts";
import {
  PlaybackSessionStore,
  assertRemoteMediaUrl,
  type PlaybackResource,
  type PlaybackSession,
} from "./playback-session-store.ts";

export const MEDIA_PROTOCOL_SCHEME = "fongmi-media";

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "if-range",
  "range",
]);

const BLOCKED_UPSTREAM_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
]);

export type MediaFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type MediaUpstreamResolver = (url: string, resource: PlaybackResource, session: PlaybackSession) => string;

export class MediaProtocolService {
  private registered = false;
  private readonly sessions: PlaybackSessionStore;
  private readonly fetchMedia: MediaFetch;
  private readonly resolveUpstream: MediaUpstreamResolver;

  constructor(
    sessions: PlaybackSessionStore,
    fetchMedia: MediaFetch = (input, init) => fetch(input, init),
    resolveUpstream: MediaUpstreamResolver = (url) => url,
  ) {
    this.sessions = sessions;
    this.fetchMedia = fetchMedia;
    this.resolveUpstream = resolveUpstream;
  }

  register(protocolApi: Pick<Protocol, "handle">): void {
    if (this.registered) return;
    protocolApi.handle(MEDIA_PROTOCOL_SCHEME, (request) => this.handle(request));
    this.registered = true;
  }

  async handle(request: Request): Promise<Response> {
    const startedAt = Date.now();
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return textResponse("媒体协议只允许 GET 和 HEAD 请求", 405, { Allow: "GET, HEAD" });
      }

      const route = parseMediaProtocolUrl(request.url);
      const { session, resource } = this.sessions.getResource(route.sessionId, route.resourceId);
      const upstreamUrl = this.resolveUpstream(resource.url, resource, session);
      assertRemoteMediaUrl(upstreamUrl);

      const response = await this.fetchMedia(upstreamUrl, {
        method: request.method,
        headers: buildUpstreamHeaders(session, request.headers),
        redirect: "follow",
      });

      // No URL or credentials are logged — only the response shape needed to
      // diagnose buffering (status, content type, range headers, timing).
      console.log(
        `[media-protocol] ${request.method} kind=${resource.kind} upstream=${response.status} `
        + `type=${(response.headers.get("content-type") ?? "").slice(0, 40)} `
        + `len=${response.headers.get("content-length") ?? "-"} `
        + `range=${response.headers.get("content-range") ?? "-"} `
        + `resolve=${Date.now() - startedAt}ms`,
      );

      if (request.method === "GET" && response.ok && isHlsManifest(resource, response)) {
        return this.rewriteManifestResponse(session, resource, response, upstreamUrl);
      }

      return this.countedResponse(response, startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "媒体请求失败";
      return textResponse(message, /不存在|过期/.test(message) ? 404 : 502);
    }
  }

  private countedResponse(response: Response, startedAt: number): Response {
    const headers = uncacheableMediaHeaders(response.headers);
    if (!response.body) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    let bytes = 0;
    let stalled = false;
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let lastDataAt = Date.now();
        const watchdog = setInterval(() => {
          const idleMs = Date.now() - lastDataAt;
          if (idleMs > 5_000 && !stalled) {
            stalled = true;
            console.log(`[media-protocol] STALL idle=${idleMs}ms bytesSoFar=${bytes} elapsed=${Date.now() - startedAt}ms`);
          }
        }, 3_000);
        const pump = async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              lastDataAt = Date.now();
              bytes += value.byteLength;
              controller.enqueue(value);
            }
            controller.close();
          } catch (error) {
            // The downstream client aborted (seek/engine switch) or the
            // upstream dropped the connection. Release the reader and surface
            // the error through the stream so the gateway's error listener can
            // tear the response down without an uncaught exception.
            void reader.cancel().catch(() => undefined);
            controller.error(error);
          } finally {
            clearInterval(watchdog);
            console.log(`[media-protocol] done ${response.status} bytes=${bytes} elapsed=${Date.now() - startedAt}ms`);
          }
        };
        void pump();
      },
      cancel() {
        // The client went away (seek, engine switch, close); stop reading the
        // upstream immediately so the net.fetch request is released instead
        // of streaming the whole file to nobody.
        void reader.cancel().catch(() => undefined);
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private async rewriteManifestResponse(
    session: PlaybackSession,
    resource: PlaybackResource,
    response: Response,
    upstreamUrl: string,
  ): Promise<Response> {
    const responseUrl = response.url || upstreamUrl || resource.url;
    const manifest = await response.text();
    const rewritten = rewriteHlsManifest(manifest, responseUrl, ({ url, kind, parentUrl }) => {
      const registered = this.sessions.registerResource(session.id, url, kind, parentUrl);
      return this.sessions.playbackUrl(session.id, registered.id);
    });

    const headers = new Headers();
    headers.set("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
    headers.set("cache-control", response.headers.get("cache-control") ?? "no-store");
    headers.set("access-control-allow-origin", "*");
    const etag = response.headers.get("etag");
    if (etag) headers.set("etag", etag);
    const lastModified = response.headers.get("last-modified");
    if (lastModified) headers.set("last-modified", lastModified);

    return new Response(rewritten, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function uncacheableMediaHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  // libmpv and Chromium can retain validators after a protected playback is
  // closed. Reusing them on a later byte-range request makes CatVod/CDNs reply
  // 304 with no body, which a media demuxer cannot consume. Playback sessions
  // are short-lived and opaque, so caching their responses has no benefit.
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  // Renderer pages are file:// documents while protected playback is exposed
  // on an opaque 127.0.0.1 HTTP origin. The video element explicitly uses
  // anonymous CORS, so every media response must opt in. Credentials remain
  // main-process-only; the browser never sends provider cookies to this URL.
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "accept-ranges, content-length, content-range, content-type");
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.delete("access-control-allow-credentials");
  headers.delete("etag");
  headers.delete("last-modified");
  headers.delete("expires");
  return headers;
}

export function parseMediaProtocolUrl(value: string): { sessionId: string; resourceId: string } {
  const parsed = new URL(value);
  if (parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:` || parsed.hostname !== "session") {
    throw new Error("无效的媒体协议地址");
  }
  const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length !== 3 || parts[1] !== "resource" || !parts[0] || !parts[2]) {
    throw new Error("无效的播放会话资源地址");
  }
  return { sessionId: parts[0], resourceId: parts[2] };
}

function buildUpstreamHeaders(session: PlaybackSession, incoming: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(session.headers)) {
    const normalized = name.toLowerCase();
    if (!value || BLOCKED_UPSTREAM_HEADERS.has(normalized) || normalized.startsWith("sec-")) continue;
    headers.set(name, value);
  }
  for (const [name, value] of incoming.entries()) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/vnd.apple.mpegurl, application/x-mpegURL, video/*, audio/*, */*;q=0.5");
  }
  return headers;
}

function isHlsManifest(resource: PlaybackResource, response: Response): boolean {
  if (resource.kind === "manifest") return true;
  const contentType = response.headers.get("content-type") ?? "";
  if (/mpegurl|x-mpegurl/i.test(contentType)) return true;
  try {
    return new URL(response.url || resource.url).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return resource.url.toLowerCase().includes(".m3u8");
  }
}

function textResponse(message: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}
