import { randomUUID } from "node:crypto";
import type { HeadersMap, ResolvedMedia } from "../../core/models.ts";

export type PlaybackMediaFormat = "hls" | "dash" | "mp4" | "mkv" | "webm" | "flv" | "mpeg-ts" | "audio" | "unknown";
export type PlaybackResourceKind = "manifest" | "segment" | "key" | "subtitle" | "danmaku" | "initialization" | "media";

export interface PlaybackMetadata {
  siteKey?: string;
  vodId?: string;
  vodName?: string;
  episodeName?: string;
  episodeUrl?: string;
}

export interface PlaybackResource {
  id: string;
  url: string;
  kind: PlaybackResourceKind;
  parentUrl?: string;
}

export interface PlaybackSession {
  id: string;
  sourceUrl: string;
  headers: HeadersMap;
  format: PlaybackMediaFormat;
  resolvedBy: ResolvedMedia["resolvedBy"];
  metadata: PlaybackMetadata;
  resources: Map<string, PlaybackResource>;
  createdAt: number;
  lastAccessAt: number;
  expiresAt: number;
}

interface InternalPlaybackSession extends PlaybackSession {
  resourceIndex: Map<string, string>;
}

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const ROOT_RESOURCE_ID = "root";
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export class PlaybackSessionStore {
  private readonly sessions = new Map<string, InternalPlaybackSession>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("播放会话有效期必须大于 0");
    this.ttlMs = ttlMs;
  }

  create(media: ResolvedMedia, metadata: PlaybackMetadata = {}): PlaybackSession {
    const now = Date.now();
    const id = randomUUID();
    const format = normalizePlaybackFormat(media.format, media.url);
    const rootKind: PlaybackResourceKind = format === "hls" || format === "dash" ? "manifest" : "media";
    const root: PlaybackResource = { id: ROOT_RESOURCE_ID, url: media.url, kind: rootKind };
    const session: InternalPlaybackSession = {
      id,
      sourceUrl: media.url,
      headers: { ...media.headers },
      format,
      resolvedBy: media.resolvedBy,
      metadata: { ...metadata },
      resources: new Map([[ROOT_RESOURCE_ID, root]]),
      resourceIndex: new Map([[resourceIndexKey(media.url, rootKind), ROOT_RESOURCE_ID]]),
      createdAt: now,
      lastAccessAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): PlaybackSession {
    const session = this.requireSession(sessionId);
    this.touch(session);
    return session;
  }

  getResource(sessionId: string, resourceId: string): { session: PlaybackSession; resource: PlaybackResource } {
    const session = this.requireSession(sessionId);
    const resource = session.resources.get(resourceId);
    if (!resource) throw new Error("播放资源不存在");
    this.touch(session);
    return { session, resource };
  }

  registerResource(
    sessionId: string,
    url: string,
    kind: PlaybackResourceKind,
    parentUrl?: string,
  ): PlaybackResource {
    const session = this.requireSession(sessionId);
    assertRemoteMediaUrl(url);
    const key = resourceIndexKey(url, kind);
    const existingId = session.resourceIndex.get(key);
    if (existingId) {
      const existing = session.resources.get(existingId);
      if (existing) return existing;
    }

    const resource: PlaybackResource = {
      id: randomUUID(),
      url,
      kind,
      ...(parentUrl ? { parentUrl } : {}),
    };
    session.resources.set(resource.id, resource);
    session.resourceIndex.set(key, resource.id);
    this.touch(session);
    return resource;
  }

  playbackUrl(sessionId: string, resourceId = ROOT_RESOURCE_ID): string {
    return `fongmi-media://session/${encodeURIComponent(sessionId)}/resource/${encodeURIComponent(resourceId)}`;
  }

  close(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  closeAll(): void {
    this.sessions.clear();
  }

  pruneExpired(now = Date.now()): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    this.pruneExpired();
    return this.sessions.size;
  }

  countBySitePrefix(prefix: string): number {
    this.pruneExpired();
    if (!prefix) return 0;
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.metadata.siteKey?.startsWith(prefix)) count += 1;
    }
    return count;
  }

  private requireSession(sessionId: string): InternalPlaybackSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("播放会话不存在");
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      throw new Error("播放会话已过期");
    }
    return session;
  }

  private touch(session: InternalPlaybackSession): void {
    const now = Date.now();
    session.lastAccessAt = now;
    session.expiresAt = now + this.ttlMs;
  }
}

export function normalizePlaybackFormat(format: string | undefined, url: string): PlaybackMediaFormat {
  const normalized = format?.trim().toLowerCase();
  if (normalized === "hls" || normalized === "m3u8") return "hls";
  if (normalized === "dash" || normalized === "mpd") return "dash";
  if (normalized === "mp4" || normalized === "m4v" || normalized === "mov") return "mp4";
  if (normalized === "mkv" || normalized === "matroska" || normalized === "video/x-matroska") return "mkv";
  if (normalized === "webm") return "webm";
  if (normalized === "flv") return "flv";
  if (normalized === "mpeg-ts" || normalized === "ts") return "mpeg-ts";
  if (normalized === "audio") return "audio";

  const extension = extensionOf(url);
  if (extension === "m3u8") return "hls";
  if (extension === "mpd") return "dash";
  if (["mp4", "m4v", "mov"].includes(extension)) return "mp4";
  if (extension === "mkv") return "mkv";
  if (extension === "webm") return "webm";
  if (extension === "flv") return "flv";
  if (extension === "ts") return "mpeg-ts";
  if (["mp3", "aac", "m4a", "flac", "ogg"].includes(extension)) return "audio";
  return "unknown";
}

export function isWebPlaybackCandidate(format: PlaybackMediaFormat, sourceUrl: string): boolean {
  if (!isRemoteMediaUrl(sourceUrl)) return false;
  return format === "hls" || format === "mp4" || format === "webm" || format === "audio";
}

export function assertRemoteMediaUrl(value: string): URL {
  const parsed = new URL(value);
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) throw new Error("内置播放器仅允许 HTTP/HTTPS 媒体资源");
  if (parsed.username || parsed.password) throw new Error("媒体地址不允许包含用户名或密码");
  return parsed;
}

function isRemoteMediaUrl(value: string): boolean {
  try {
    assertRemoteMediaUrl(value);
    return true;
  } catch {
    return false;
  }
}

function resourceIndexKey(url: string, kind: PlaybackResourceKind): string {
  return `${kind}\u0000${url}`;
}

function extensionOf(value: string): string {
  try {
    return new URL(value).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  } catch {
    return value.toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/)?.[1] ?? "";
  }
}
