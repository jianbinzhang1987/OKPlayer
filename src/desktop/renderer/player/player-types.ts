export type PlaybackMode = "auto" | "standard" | "compatibility";

export interface EmbeddedPlaybackSession {
  sessionId: string;
  playbackUrl: string;
  format: string;
  engine?: "web" | "mpv";
  title: string;
  episode: string;
  siteKey: string;
  vodId: string;
  episodeUrl: string;
  subtitleUrl?: string;
  danmakuUrl?: string;
  contentKind?: "vod" | "live";
  startPosition?: number;
}

export interface PlaybackProgress {
  position: number;
  duration: number;
  completed: boolean;
}

export interface CompatibilityPlaybackFailure {
  progress: PlaybackProgress;
  reason: string;
}

export interface PlayerEpisode {
  name: string;
  url: string;
}

export type WebPlayerEngine = "legacy" | "artplayer";

export function normalizeWebPlayerEngine(value: unknown): WebPlayerEngine {
  return value === "artplayer" ? "artplayer" : "legacy";
}

export function normalizePlaybackMode(value: unknown): PlaybackMode {
  if (value === "standard" || value === "compatibility") return value;
  return "auto";
}
