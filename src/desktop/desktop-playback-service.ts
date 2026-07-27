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
  isWebPlaybackCandidate,
  type PlaybackMediaFormat,
  type PlaybackResourceKind,
} from "./media-protocol/playback-session-store.ts";

export interface PreparePlaybackInput {
  siteKey: string;
  flag: string;
  episodeUrl: string;
  vodId?: string;
  vodName?: string;
  episodeName?: string;
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

const PREPARATION_TIMEOUT_MS = 15_000;

interface PlaybackFallbackPlayer {
  open(url: string, headers?: Record<string, string>): Promise<unknown>;
  stop(): Promise<unknown>;
}

export class DesktopPlaybackService {
  private readonly source: PlaybackSourceService;
  private readonly fallbackPlayer: PlaybackFallbackPlayer;
  private readonly sniffer: PlaybackSniffer;
  private readonly sessions: PlaybackSessionStore;
  private readonly probe: PlaybackMediaProbe;
  private readonly externalPlayer: ExternalPlayerLauncher;
  private preparationController?: AbortController;

  constructor(
    source: PlaybackSourceService,
    fallbackPlayer: PlaybackFallbackPlayer,
    sniffer: PlaybackSniffer,
    sessions: PlaybackSessionStore,
    probe: PlaybackMediaProbe = probeMediaUrl,
    externalPlayer: ExternalPlayerLauncher = new ExternalPlayerService(),
  ) {
    this.source = source;
    this.fallbackPlayer = fallbackPlayer;
    this.sniffer = sniffer;
    this.sessions = sessions;
    this.probe = probe;
    this.externalPlayer = externalPlayer;
  }

  static fromAppServices(
    source: AppService,
    fallbackPlayer: PlayerService,
    sniffer: BrowserSnifferService,
    sessions: PlaybackSessionStore,
  ): DesktopPlaybackService {
    return new DesktopPlaybackService(source, fallbackPlayer, sniffer, sessions);
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
        playbackUrl: this.sessions.playbackUrl(session.id),
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

  async fallback(sessionId: string): Promise<{ status: "started" }> {
    const session = this.sessions.get(sessionId);
    try {
      await this.fallbackPlayer.open(session.sourceUrl, session.headers);
      return { status: "started" };
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
      const resolved = await this.source.resolve(input.siteKey, input.flag, input.episodeUrl, signal);
      const likelyPlaybackPage = isLikelyPlaybackPage(resolved.url);
      const explicitDirectMedia = isLikelyDirectMediaUrl(resolved.url);
      if (!likelyPlaybackPage && shouldProbeResolvedMedia(resolved, explicitDirectMedia)) {
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
  _headers: Record<string, string>,
  _input: Pick<PreparePlaybackInput, "siteKey" | "flag">,
): "web" | "mpv" {
  // Protected headers stay inside the main-process playback session and are
  // forwarded by fongmi-media. Web-compatible MP4/HLS therefore remain in the
  // application window first; codec or browser failures still trigger the
  // existing automatic compatibility fallback.
  return isWebPlaybackCandidate(format, sourceUrl) ? "web" : "mpv";
}

function isLikelyDirectMediaUrl(value: string): boolean {
  return /\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i.test(value);
}

function shouldProbeResolvedMedia(media: ResolvedMedia, explicitDirectMedia: boolean): boolean {
  if (explicitDirectMedia) return true;
  if (media.format && media.format !== "unknown") return true;
  return Object.keys(media.headers).some((key) => /^(?:cookie|referer|user-agent|authorization)$/i.test(key));
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
