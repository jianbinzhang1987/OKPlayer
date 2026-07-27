export interface EmbeddedPlaybackSession {
  sessionId: string;
  playbackUrl: string;
  format: string;
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

export interface PlayerEpisode {
  name: string;
  url: string;
}

export type WebPlayerEngine = "legacy" | "artplayer";

export function normalizeWebPlayerEngine(value: unknown): WebPlayerEngine {
  return value === "artplayer" ? "artplayer" : "legacy";
}
