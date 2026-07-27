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
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "range",
]);

const BLOCKED_UPSTREAM_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
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

      if (request.method === "GET" && response.ok && isHlsManifest(resource, response)) {
        return this.rewriteManifestResponse(session, resource, response, upstreamUrl);
      }

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "媒体请求失败";
      return textResponse(message, /不存在|过期/.test(message) ? 404 : 502);
    }
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
