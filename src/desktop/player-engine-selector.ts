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
  "mkv",
  "mpeg-ts",
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

  // Netdisk "original" MP4s are frequently HEVC even though the container is
  // browser-shaped. Electron/Chromium codec support varies by build and these
  // files can consume tens of megabytes while remaining stuck before
  // metadata. The managed libmpv runtime has the required demuxer/codecs and
  // already receives the same opaque loopback URL, so prefer it in auto mode.
  if (input.format === "mp4" && isPanOriginalLine(input)) return "mpv";

  // Unknown formats are not guessed here: start with the Chromium web engine
  // and let the renderer detect "format not supported" to fall back to the
  // native mpv kernel on the same resolved session.
  if (input.format === "unknown") return "web";
  if (!webCandidate) return "mpv";
  if (COMPATIBILITY_FIRST_FORMATS.has(input.format)) return "mpv";
  if (COMPATIBILITY_FIRST_EXTENSIONS.has(extensionOf(input.sourceUrl))) return "mpv";
  return "web";
}

function isPanOriginalLine(input: Pick<PlaybackEngineSelectionInput, "siteKey" | "flag">): boolean {
  const context = `${input.siteKey ?? ""} ${input.flag ?? ""}`;
  return /原画/i.test(context)
    && /夸克|quark|(?:^|\W)uc(?:\W|$)|百度|baidu|(?:^|\D)115(?:\D|$)|pan115|天翼|pan189|移动云盘|pan139/i.test(context);
}

function extensionOf(value: string): string {
  try {
    return new URL(value).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  } catch {
    return value.toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/)?.[1] ?? "";
  }
}
