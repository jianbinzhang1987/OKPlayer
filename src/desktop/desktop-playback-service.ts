import { probeMediaUrl, type MediaProbeResult } from "../core/media-probe.ts";
import type { PlayerResult, ResolvedMedia } from "../core/models.ts";
import type { AppService } from "../core/app-service.ts";
import type { PlayerService } from "../core/player-service.ts";
import type { BrowserSnifferService } from "./browser-sniffer-service.ts";
import { ExternalPlayerService, type ExternalPlayerLauncher, type ExternalPlayerOpenResult, type ExternalPlayerPreference } from "./external-player-service.ts";
import {
  classifyPlaybackFailure,
  PlaybackFailure,
  type PlaybackSourceImpact,
} from "./playback-error.ts";
import {
  PlaybackSessionStore,
  type PlaybackMediaFormat,
  type PlaybackResourceKind,
  type PlaybackSession,
} from "./media-protocol/playback-session-store.ts";
import {
  normalizePlaybackMode,
  selectPlaybackEngine as choosePlaybackEngine,
  type PlaybackMode,
} from "./player-engine-selector.ts";

export interface PreparePlaybackInput {
  siteKey: string;
  flag: string;
  episodeUrl: string;
  vodId?: string;
  vodName?: string;
  episodeName?: string;
  playbackMode?: PlaybackMode;
}

export interface PreparedPlayback {
  sessionId: string;
  playbackUrl: string;
  format: PlaybackMediaFormat;
  engine: "web" | "mpv";
  resolvedBy: ResolvedMedia["resolvedBy"];
  subtitleUrl?: string;
  danmakuUrl?: string;
  contentKind?: "vod" | "live";
}

interface PlaybackSourceService {
  resolve(siteKey: string, flag: string, episodeUrl: string, signal?: AbortSignal): Promise<ResolvedMedia>;
  playerResult(siteKey: string, flag: string, episodeUrl: string, signal?: AbortSignal): Promise<PlayerResult>;
  getConfig(): { ads?: string[] } | undefined;
  recordPlaybackSuccess?(siteKey: string, latencyMs?: number): Promise<void>;
  recordPlaybackFailure?(siteKey: string, reason: string, latencyMs?: number, sourceImpact?: PlaybackSourceImpact): Promise<void>;
}

interface PlaybackSniffer {
  sniff(url: string, options?: { headers?: Record<string, string>; adPatterns?: string[]; signal?: AbortSignal }): Promise<ResolvedMedia>;
  cancel(): void;
}

type PlaybackMediaProbe = typeof probeMediaUrl;
type NativePlaybackTarget = { url: string; headers?: Record<string, string> };
type NativePlaybackTargetResolver = (session: PlaybackSession) => NativePlaybackTarget;
type WebPlaybackUrlResolver = (session: PlaybackSession) => string;

const PREPARATION_TIMEOUT_MS = 15_000;

interface PlaybackFallbackPlayer {
  open(url: string, headers?: Record<string, string>): Promise<unknown>;
  stop(): Promise<unknown>;
  getBackend?(): string;
}

export class DesktopPlaybackService {
  private readonly source: PlaybackSourceService;
  private readonly fallbackPlayer: PlaybackFallbackPlayer;
  private readonly sniffer: PlaybackSniffer;
  private readonly sessions: PlaybackSessionStore;
  private readonly probe: PlaybackMediaProbe;
  private readonly externalPlayer: ExternalPlayerLauncher;
  private readonly nativePlaybackTarget: NativePlaybackTargetResolver;
  private readonly webPlaybackUrl: WebPlaybackUrlResolver | undefined;
  private preparationController?: AbortController;

  constructor(
    source: PlaybackSourceService,
    fallbackPlayer: PlaybackFallbackPlayer,
    sniffer: PlaybackSniffer,
    sessions: PlaybackSessionStore,
    probe: PlaybackMediaProbe = probeMediaUrl,
    externalPlayer: ExternalPlayerLauncher = new ExternalPlayerService(),
    nativePlaybackTarget: NativePlaybackTargetResolver = (session) => ({ url: session.sourceUrl, headers: session.headers }),
    webPlaybackUrl?: WebPlaybackUrlResolver,
  ) {
    this.source = source;
    this.fallbackPlayer = fallbackPlayer;
    this.sniffer = sniffer;
    this.sessions = sessions;
    this.probe = probe;
    this.externalPlayer = externalPlayer;
    this.nativePlaybackTarget = nativePlaybackTarget;
    this.webPlaybackUrl = webPlaybackUrl;
  }

  static fromAppServices(
    source: AppService,
    fallbackPlayer: PlayerService,
    sniffer: BrowserSnifferService,
    sessions: PlaybackSessionStore,
    nativePlaybackTarget?: NativePlaybackTargetResolver,
    webPlaybackUrl?: WebPlaybackUrlResolver,
  ): DesktopPlaybackService {
    return new DesktopPlaybackService(source, fallbackPlayer, sniffer, sessions, undefined, undefined, nativePlaybackTarget, webPlaybackUrl);
  }

  async prepare(input: PreparePlaybackInput): Promise<PreparedPlayback> {
    validatePrepareInput(input);
    this.cancelPreparation();
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(PREPARATION_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    this.preparationController = controller;

    const startedAt = Date.now();
    try {
      const media = await this.resolveMedia(input, signal);
      const session = this.sessions.create(media, {
        siteKey: input.siteKey,
        ...(input.vodId ? { vodId: input.vodId } : {}),
        ...(input.vodName ? { vodName: input.vodName } : {}),
        ...(input.episodeName ? { episodeName: input.episodeName } : {}),
        episodeUrl: input.episodeUrl,
      });
      const engine = selectPlaybackEngine(session.format, session.sourceUrl, session.headers, input);
      const subtitleUrl = registerOptionalResource(this.sessions, session.id, media.subtitleUrl, "subtitle");
      const danmakuUrl = registerOptionalResource(this.sessions, session.id, media.danmakuUrl, "danmaku");
      await this.source.recordPlaybackSuccess?.(input.siteKey, Date.now() - startedAt).catch(() => undefined);
      return {
        sessionId: session.id,
        playbackUrl: this.webPlaybackUrl
          ? this.webPlaybackUrl(session)
          : this.sessions.playbackUrl(session.id),
        format: session.format,
        engine,
        resolvedBy: session.resolvedBy,
        ...(subtitleUrl ? { subtitleUrl } : {}),
        ...(danmakuUrl ? { danmakuUrl } : {}),
        ...(media.contentKind ? { contentKind: media.contentKind } : {}),
      };
    } catch (error) {
      const failure = controller.signal.aborted
        ? new PlaybackFailure("CANCELLED", "播放准备已取消")
        : timeoutSignal.aborted
          ? new PlaybackFailure("PREPARATION_TIMEOUT", "播放地址解析超过 15 秒")
          : classifyPlaybackFailure(error, "SOURCE_RESOLVE_FAILED");
      if (!controller.signal.aborted && failure.sourceImpact !== "none") {
        await this.source.recordPlaybackFailure?.(
          input.siteKey,
          failure.message,
          Date.now() - startedAt,
          failure.sourceImpact,
        ).catch(() => undefined);
      }
      throw failure;
    } finally {
      if (this.preparationController === controller) this.preparationController = undefined;
    }
  }

  async fallback(sessionId: string): Promise<{ status: "started"; backend: string }> {
    const session = this.sessions.get(sessionId);
    try {
      const target = this.nativePlaybackTarget(session);
      await this.fallbackPlayer.open(target.url, target.headers);
      return { status: "started", backend: this.fallbackPlayer.getBackend?.() ?? "mpv-ipc" };
    } catch (error) {
      throw new PlaybackFailure(
        "COMPAT_ENGINE_FAILED",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  async openExternal(sessionId: string, preference: ExternalPlayerPreference): Promise<ExternalPlayerOpenResult> {
    const session = this.sessions.get(sessionId);
    if (Object.keys(session.headers).length > 0) {
      throw new PlaybackFailure(
        "EXTERNAL_PLAYER_UNSAFE",
        "媒体依赖专用请求头，不能安全传递给外部播放器",
      );
    }
    try {
      return await this.externalPlayer.open(session.sourceUrl, preference);
    } catch (error) {
      throw new PlaybackFailure(
        "EXTERNAL_PLAYER_FAILED",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  close(sessionId: string): { closed: boolean } {
    return { closed: this.sessions.close(sessionId) };
  }

  cancelPreparation(): void {
    this.preparationController?.abort();
    this.sniffer.cancel();
  }

  async stopFallback(): Promise<void> {
    await this.fallbackPlayer.stop();
  }

  closeAll(): void {
    this.sessions.closeAll();
  }

  private async resolveMedia(input: PreparePlaybackInput, signal: AbortSignal): Promise<ResolvedMedia> {
    try {
      const sourceMedia = await this.source.resolve(input.siteKey, input.flag, input.episodeUrl, signal);
      const resolvedFromLocalPanProxy = isLocalPanProxyUrl(sourceMedia.url);
      const resolvedFromBaiduProxy = isBaiduPanProxyUrl(sourceMedia.url);
      const resolved = unwrapLocalPanProxyMedia(sourceMedia);
      const likelyPlaybackPage = isLikelyPlaybackPage(resolved.url);
      const explicitDirectMedia = isLikelyDirectMediaUrl(resolved.url);
      // A CatVod pan proxy has already created this short-lived URL together
      // with the exact provider headers. A separate 64 KiB preflight uses a
      // different request lifecycle and Quark may answer it with 412, so the
      // probe on a pan proxy is ADVISORY: a 206 tells us the container (MKV →
      // mpv directly, no 10s web wait), while any failure leaves the format
      // unknown and the renderer watchdog routes it (web first, then mpv).
      if (!likelyPlaybackPage && shouldProbeResolvedMedia(resolved, explicitDirectMedia)) {
        if (resolvedFromLocalPanProxy) {
          // A pan proxy lease is trusted and short-lived. The probe is purely
          // advisory: a 206 tells us the container (MKV → mpv directly, no
          // 10s web wait). ANY probe failure — including an aborted/timed-out
          // request that THROWS from probeMediaUrl — must not flip the line.
          // Playback routing is provider-aware below: Quark/UC retain the
          // optimized proxy, while Baidu avoids its incompatible parallel
          // range behavior.
          let probe: MediaProbeResult | undefined;
          try {
            probe = await this.probe(resolved.url, {
              headers: resolved.headers,
              ...(resolved.format ? { expectedFormat: resolved.format } : {}),
              timeoutMs: 4_000,
              signal,
            });
          } catch {
            probe = undefined;
          }
          // Baidu's CDN serves byte ranges reliably and quickly when the
          // signed URL is requested with its original User-Agent. CatVod's
          // 16-way smart proxy, however, is frequently throttled by Baidu:
          // parallel chunks time out and libmpv never receives enough of the
          // MP4 header to start. Keep the optimized proxy for Quark/UC, but
          // let our credential-preserving media gateway fetch Baidu directly.
          const playbackMedia = resolvedFromBaiduProxy ? resolved : sourceMedia;
          return {
            ...playbackMedia,
            ...(probe?.ok && probe.format ? { format: probe.format } : {}),
          };
        }
        const probe = await this.probe(resolved.url, {
          headers: resolved.headers,
          ...(resolved.format ? { expectedFormat: resolved.format } : {}),
          timeoutMs: 4_000,
          signal,
        });
        if (probe.ok) {
          return {
            ...resolved,
            url: probe.url,
            ...(probe.format ? { format: probe.format } : {}),
          };
        }
        if ((probe.statusCode === 401 || probe.statusCode === 403) && isPanPlaybackInput(input)) {
          throw new PlaybackFailure(
            "AUTH_EXPIRED",
            `网盘凭据校验失败：HTTP ${probe.statusCode}`,
            { userMessage: "网盘登录已失效，请重新登录后继续播放。" },
          );
        }
        if (probe.statusCode === 412 && isPanPlaybackInput(input)) {
          // Netdisk signed links are short-lived; a 412 usually means the
          // link expired between resolution and the first real Range request,
          // not that the line is dead. Report it as a retryable link expiry
          // (renderer re-fetches a fresh link for the same line) instead of
          // switching lines.
          throw new PlaybackFailure(
            "MEDIA_URL_EXPIRED",
            `网盘原画链接已失效：HTTP ${probe.statusCode}`,
            { userMessage: "网盘原画链接已失效，正在重新获取播放地址。", sourceImpact: "none" },
          );
        }
        if (explicitDirectMedia && isDefinitiveDirectProbeFailure(probe)) throw new DirectMediaUnavailableError(probe.reason);
        return resolved;
      }
      if (!likelyPlaybackPage) return resolved;
      try {
        const sniffed = await this.sniffer.sniff(resolved.url, {
          headers: resolved.headers,
          adPatterns: this.source.getConfig()?.ads ?? [],
          signal,
        });
        return mergePlaybackExtras(sniffed, resolved);
      } catch (sniffError) {
        const message = sniffError instanceof Error ? sniffError.message : String(sniffError);
        throw new Error(`解析结果是网页地址，媒体嗅探失败：${message}`);
      }
    } catch (resolveError) {
      if (resolveError instanceof DirectMediaUnavailableError) throw resolveError;
      if (resolveError instanceof PlaybackFailure && ["AUTH_REQUIRED", "AUTH_EXPIRED", "CANCELLED"].includes(resolveError.code)) {
        throw resolveError;
      }
      try {
        const result = await this.source.playerResult(input.siteKey, input.flag, input.episodeUrl, signal);
        const sniffed = await this.sniffer.sniff(result.url, {
          headers: result.header,
          adPatterns: this.source.getConfig()?.ads ?? [],
          signal,
        });
        return mergePlaybackExtras(sniffed, {
          url: result.url,
          headers: result.header,
          resolvedBy: "browser-sniffer",
          ...(result.subtitleUrl ? { subtitleUrl: result.subtitleUrl } : {}),
          ...(result.danmakuUrl ? { danmakuUrl: result.danmakuUrl } : {}),
          ...(result.contentKind ? { contentKind: result.contentKind } : {}),
        });
      } catch (sniffError) {
        const first = resolveError instanceof Error ? resolveError.message : String(resolveError);
        const second = sniffError instanceof Error ? sniffError.message : String(sniffError);
        throw new Error(`常规解析失败：${first}；网页嗅探失败：${second}`);
      }
    }
  }
}

function registerOptionalResource(
  sessions: PlaybackSessionStore,
  sessionId: string,
  value: string | undefined,
  kind: Extract<PlaybackResourceKind, "subtitle" | "danmaku">,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    const resource = sessions.registerResource(sessionId, url.toString(), kind);
    return sessions.playbackUrl(sessionId, resource.id);
  } catch {
    return undefined;
  }
}

function mergePlaybackExtras(media: ResolvedMedia, extras: ResolvedMedia): ResolvedMedia {
  return {
    ...media,
    ...(extras.subtitleUrl ? { subtitleUrl: extras.subtitleUrl } : {}),
    ...(extras.danmakuUrl ? { danmakuUrl: extras.danmakuUrl } : {}),
    ...(extras.contentKind ? { contentKind: extras.contentKind } : {}),
  };
}

class DirectMediaUnavailableError extends PlaybackFailure {
  constructor(reason: string) {
    super("LINE_UNAVAILABLE", `媒体直链不可用：${reason}`);
    this.name = "DirectMediaUnavailableError";
  }
}

export function selectPlaybackEngine(
  format: PlaybackMediaFormat,
  sourceUrl: string,
  headers: Record<string, string>,
  input: Pick<PreparePlaybackInput, "siteKey" | "flag" | "playbackMode">,
): "web" | "mpv" {
  return choosePlaybackEngine({
    format,
    sourceUrl,
    headers,
    playbackMode: normalizePlaybackMode(input.playbackMode),
    siteKey: input.siteKey,
    flag: input.flag,
  });
}

function isLikelyDirectMediaUrl(value: string): boolean {
  return /\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i.test(value);
}

function shouldProbeResolvedMedia(media: ResolvedMedia, explicitDirectMedia: boolean): boolean {
  if (explicitDirectMedia) return true;
  if (isLocalPanProxyUrl(media.url)) return true;
  if (media.format && media.format !== "unknown") return true;
  return Object.keys(media.headers).some((key) => /^(?:cookie|referer|user-agent|authorization)$/i.test(key));
}

function isLocalPanProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    const panProxyPath = /\/proxy\/(?:quark|baidu|uc|pan115|pan189|pan139)(?:\/|$)/i.test(url.pathname);
    // A CatVod player response can preserve the proxy's original host before
    // it is rebound to the active local service.  `pst` is CatVod's opaque
    // per-playback session payload, so it is a stronger identity signal than
    // the host alone and lets us unwrap that valid response before probing.
    return panProxyPath && (local || Boolean(url.searchParams.get("pst")?.trim()));
  } catch {
    return false;
  }
}

function isBaiduPanProxyUrl(value: string): boolean {
  try {
    return /\/proxy\/baidu(?:\/|$)/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

const PAN_PROXY_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "origin",
  "referer",
  "referrer",
  "user-agent",
]);

function unwrapLocalPanProxyMedia(media: ResolvedMedia): ResolvedMedia {
  try {
    const proxyUrl = new URL(media.url);
    if (!isLocalPanProxyUrl(media.url)) return media;
    const payload = proxyUrl.searchParams.get("pst")?.trim();
    if (!payload || payload.length > 64 * 1024) return media;

    const decoded = decodeBase64UrlJson(payload);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return media;
    const record = decoded as Record<string, unknown>;
    const upstreamValue = typeof record.url === "string" ? record.url.trim() : "";
    const upstreamUrl = new URL(upstreamValue);
    if (!["http:", "https:"].includes(upstreamUrl.protocol) || upstreamUrl.username || upstreamUrl.password) return media;

    const decodedHeaders = sanitizePanProxyHeaders(record.headers);
    return {
      ...media,
      url: upstreamUrl.toString(),
      headers: { ...decodedHeaders, ...media.headers },
    };
  } catch {
    return media;
  }
}

function decodeBase64UrlJson(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  if (!decoded || decoded.length > 64 * 1024) return undefined;
  return JSON.parse(decoded) as unknown;
}

function sanitizePanProxyHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedName = name.trim().toLowerCase();
    if (!PAN_PROXY_HEADER_ALLOWLIST.has(normalizedName) || typeof rawValue !== "string") continue;
    const headerValue = rawValue.trim();
    if (!headerValue || /[\r\n]/.test(headerValue) || headerValue.length > 16 * 1024) continue;
    output[name] = headerValue;
  }
  return output;
}

function isDefinitiveDirectProbeFailure(result: MediaProbeResult): boolean {
  return result.statusCode === 404 || result.statusCode === 410 || /HTML|格式不匹配/i.test(result.reason);
}

function isPanPlaybackInput(input: Pick<PreparePlaybackInput, "siteKey" | "flag" | "episodeUrl">): boolean {
  return /夸克|quark|\buc\b|百度|baidu|\b115\b|pan115|天翼|pan189|移动云盘|pan139/i
    .test(`${input.siteKey} ${input.flag} ${input.episodeUrl}`);
}

export function isLikelyPlaybackPage(value: string): boolean {
  if (/\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (/\.(?:html?|shtml)(?:$|[?#])/i.test(url.pathname)) return true;
    if (/\/(?:v_show|x\/cover|x\/page)\//i.test(url.pathname)) return true;
    return /(?:^|\.)(?:iqiyi\.com|youku\.com|v\.qq\.com)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function validatePrepareInput(input: PreparePlaybackInput): void {
  if (!input.siteKey?.trim()) throw new Error("缺少播放源标识");
  if (!input.episodeUrl?.trim()) throw new Error("缺少剧集播放地址");
}
