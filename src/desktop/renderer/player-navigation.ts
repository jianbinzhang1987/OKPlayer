export interface NavigationEpisode {
  name: string;
  url: string;
}

export interface NavigationLine {
  flag: string;
  show?: string;
  episodes: NavigationEpisode[];
}

export type PlaybackLinePreference = "stable" | "quality";

export interface PlaybackLineFallback {
  line: NavigationLine;
  episode: NavigationEpisode;
}

export interface PlaybackEpisodeTarget extends PlaybackLineFallback {}

export interface EpisodeNavigation {
  flag: string;
  episodes: NavigationEpisode[];
  currentIndex: number;
  previous?: NavigationEpisode;
  next?: NavigationEpisode;
}

const DIRECT_MEDIA_PATTERN = /\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i;
const STABLE_LINE_PATTERN = /(?:极速|秒播|直连|默认|稳定|流畅|快速)/i;
const QUALITY_LINE_PATTERN = /(?:原画|4K|蓝光|超清|杜比|HDR|高码率|无损)/i;
const PAN_LINE_PATTERN = /(?:夸克|UC|百度|115|天翼|阿里|移动|网盘|云盘)/i;

export function playbackLineScore(line: NavigationLine, preference: PlaybackLinePreference = "stable"): number {
  if (!line.episodes.length) return -10_000;
  const label = line.flag;
  const direct = line.episodes.some((episode) => DIRECT_MEDIA_PATTERN.test(episode.url));
  const stable = STABLE_LINE_PATTERN.test(label);
  const quality = QUALITY_LINE_PATTERN.test(label);
  const pan = PAN_LINE_PATTERN.test(label);
  let score = Math.min(20, line.episodes.length / 5);

  if (pan) {
    // Netdisk lines: original quality is the primary value. 原画 lines
    // (夸克原画 / 百度原画) win over 极速/秒播 speed lines regardless of the
    // global preference, now that pan original links play through the web
    // engine. Speed lines remain the runtime fallback target.
    if (quality) score += 120;
    if (direct) score += 70;
    if (stable) score += 40;
    score -= 10;
    return score;
  }

  if (preference === "quality") {
    if (quality) score += 110;
    if (direct) score += 80;
    if (stable) score += 30;
  } else {
    if (direct) score += 110;
    if (stable) score += 90;
    if (quality) score += 15;
  }
  return score;
}

export function resolvePreferredPlaybackLine(
  lines: NavigationLine[] | undefined,
  preference: PlaybackLinePreference = "stable",
): NavigationLine | undefined {
  if (!lines?.length) return undefined;
  return [...lines].sort((left, right) => playbackLineScore(right, preference) - playbackLineScore(left, preference))[0];
}

export function resolveFallbackPlaybackLine(
  lines: NavigationLine[] | undefined,
  currentFlag: string,
  currentEpisode: NavigationEpisode,
  attemptedFlags: readonly string[] = [],
  preference: PlaybackLinePreference = "stable",
): PlaybackLineFallback | undefined {
  if (!lines?.length) return undefined;
  const attempted = new Set([...attemptedFlags, currentFlag]);
  const currentLine = lines.find((line) => line.flag === currentFlag);
  const currentIndex = currentLine?.episodes.findIndex((episode) => episode.url === currentEpisode.url || episode.name === currentEpisode.name) ?? -1;
  const ranked = [...lines]
    .filter((line) => !attempted.has(line.flag) && line.episodes.length > 0)
    .sort((left, right) => playbackLineScore(right, preference) - playbackLineScore(left, preference));

  for (const line of ranked) {
    const episode = line.episodes.find((item) => item.name === currentEpisode.name)
      ?? (currentIndex >= 0 ? line.episodes[currentIndex] : undefined);
    if (episode) return { line, episode };
  }
  return undefined;
}

export function resolvePlaybackEpisodeTarget(
  lines: NavigationLine[] | undefined,
  referenceEpisode: NavigationEpisode,
  referenceIndex = -1,
  preference: PlaybackLinePreference = "stable",
): PlaybackEpisodeTarget | undefined {
  if (!lines?.length) return undefined;
  const ranked = [...lines]
    .filter((line) => line.episodes.length > 0)
    .sort((left, right) => playbackLineScore(right, preference) - playbackLineScore(left, preference));
  for (const line of ranked) {
    const byName = line.episodes.find((episode) => normalizedEpisodeName(episode.name) === normalizedEpisodeName(referenceEpisode.name));
    const episode = byName ?? (referenceIndex >= 0 ? line.episodes[referenceIndex] : undefined);
    if (episode) return { line, episode };
  }
  return undefined;
}

export function resolveEpisodeNavigation(
  lines: NavigationLine[] | undefined,
  preferredFlag: string | undefined,
  episodeUrl: string | undefined,
): EpisodeNavigation | undefined {
  if (!lines?.length || !episodeUrl) return undefined;

  const preferred = preferredFlag ? lines.find((line) => line.flag === preferredFlag) : undefined;
  const resolvedLine = preferred?.episodes.some((episode) => episode.url === episodeUrl)
    ? preferred
    : lines.find((line) => line.episodes.some((episode) => episode.url === episodeUrl));
  if (!resolvedLine) return undefined;

  const currentIndex = resolvedLine.episodes.findIndex((episode) => episode.url === episodeUrl);
  if (currentIndex < 0) return undefined;

  return {
    flag: resolvedLine.flag,
    episodes: resolvedLine.episodes,
    currentIndex,
    ...(currentIndex > 0 ? { previous: resolvedLine.episodes[currentIndex - 1] } : {}),
    ...(currentIndex + 1 < resolvedLine.episodes.length ? { next: resolvedLine.episodes[currentIndex + 1] } : {}),
  };
}

function normalizedEpisodeName(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/(?:第|集|期|话|章|episode|ep)/ig, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/^0+(?=\d)/, "")
    .toLowerCase();
}
