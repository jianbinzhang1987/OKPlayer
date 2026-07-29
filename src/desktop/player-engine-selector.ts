import {
  isWebPlaybackCandidate,
  type PlaybackMediaFormat,
} from "./media-protocol/playback-session-store.ts";

export type PlaybackMode = "auto" | "standard" | "compatibility";
export type PlaybackEngine = "web" | "mpv";

export interface PlaybackEngineSelectionInput {
  format: PlaybackMediaFormat;
  sourceUrl: string;
  headers?: Record<string, string>;
  playbackMode?: PlaybackMode;
  siteKey?: string;
  flag?: string;
}

const COMPATIBILITY_FIRST_FORMATS = new Set<PlaybackMediaFormat>([
  "dash",
  "flv",
  "mpeg-ts",
  "unknown",
]);

const COMPATIBILITY_FIRST_EXTENSIONS = new Set([
  "mkv",
  "flv",
  "ts",
  "mts",
  "m2ts",
  "avi",
  "wmv",
  "rmvb",
  "rm",
  "3gp",
]);

export function normalizePlaybackMode(value: unknown): PlaybackMode {
  if (value === "standard" || value === "compatibility") return value;
  return "auto";
}

export function selectPlaybackEngine(input: PlaybackEngineSelectionInput): PlaybackEngine {
  const playbackMode = normalizePlaybackMode(input.playbackMode);
  if (playbackMode === "compatibility") return "mpv";

  const webCandidate = isWebPlaybackCandidate(input.format, input.sourceUrl);
  if (playbackMode === "standard") return webCandidate ? "web" : "mpv";

  if (!webCandidate) return "mpv";
  if (COMPATIBILITY_FIRST_FORMATS.has(input.format)) return "mpv";
  if (COMPATIBILITY_FIRST_EXTENSIONS.has(extensionOf(input.sourceUrl))) return "mpv";
  return "web";
}

function extensionOf(value: string): string {
  try {
    return new URL(value).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  } catch {
    return value.toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/)?.[1] ?? "";
  }
}
