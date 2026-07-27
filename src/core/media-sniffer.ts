import type { HeadersMap } from "./models.ts";

export interface MediaCandidateInput {
  url: string;
  statusCode?: number;
  resourceType?: string;
  mimeType?: string;
  requestHeaders?: HeadersMap;
  responseHeaders?: HeadersMap;
}

export interface RankedMediaCandidate extends MediaCandidateInput {
  score: number;
  format?: string;
  reasons: string[];
}

const MEDIA_EXTENSIONS: Record<string, { score: number; format: string }> = {
  m3u8: { score: 110, format: "hls" },
  mpd: { score: 105, format: "dash" },
  mp4: { score: 90, format: "mp4" },
  m4v: { score: 86, format: "mp4" },
  flv: { score: 82, format: "flv" },
  webm: { score: 80, format: "webm" },
  mkv: { score: 78, format: "mkv" },
  mov: { score: 76, format: "mov" },
  mp3: { score: 65, format: "audio" },
  aac: { score: 62, format: "audio" },
  m4a: { score: 62, format: "audio" },
  ts: { score: 25, format: "mpeg-ts" },
};

const DEFAULT_AD_PATTERNS = [
  /(?:^|[./_-])ads?(?:[./?&=_-]|$)/i,
  /doubleclick|googleads|googlesyndication|adservice|advert|analytics|tracking/i,
  /(?:pre|mid|post)[_-]?roll/i,
  /\/vast(?:[/?]|$)|[?&]vast=/i,
];

function extensionOf(value: string): string {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return pathname.match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  } catch {
    return value.toLowerCase().match(/\.([a-z0-9]+)(?:[?#]|$)/)?.[1] ?? "";
  }
}

function normalizedMime(candidate: MediaCandidateInput): string {
  const direct = candidate.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (direct) return direct;
  const header = Object.entries(candidate.responseHeaders ?? {})
    .find(([key]) => key.toLowerCase() === "content-type")?.[1];
  return header?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isSignedUnknownUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hasSignature = [...url.searchParams.keys()].some((key) => /token|sign|auth|expires|key|policy/i.test(key));
    return hasSignature && extensionOf(value) === "";
  } catch {
    return false;
  }
}

function matchesAd(value: string, customPatterns: string[]): boolean {
  if (DEFAULT_AD_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return customPatterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) return false;
    try {
      return new RegExp(trimmed, "i").test(value);
    } catch {
      return value.toLowerCase().includes(trimmed.toLowerCase());
    }
  });
}

export function rankMediaCandidate(candidate: MediaCandidateInput, adPatterns: string[] = []): RankedMediaCandidate | undefined {
  if (!/^https?:\/\//i.test(candidate.url)) return undefined;
  if (matchesAd(candidate.url, adPatterns)) return undefined;
  if (candidate.statusCode !== undefined && (candidate.statusCode < 200 || candidate.statusCode >= 400)) return undefined;

  const reasons: string[] = [];
  let score = 0;
  let format: string | undefined;
  const extension = extensionOf(candidate.url);
  const extensionInfo = MEDIA_EXTENSIONS[extension];
  if (extensionInfo) {
    score += extensionInfo.score;
    format = extensionInfo.format;
    reasons.push(`extension:${extension}`);
  }

  const mime = normalizedMime(candidate);
  if (/mpegurl|x-mpegurl/i.test(mime)) {
    score += 110;
    format ??= "hls";
    reasons.push("mime:hls");
  } else if (/dash\+xml/i.test(mime)) {
    score += 105;
    format ??= "dash";
    reasons.push("mime:dash");
  } else if (mime.startsWith("video/")) {
    score += 80;
    reasons.push(`mime:${mime}`);
  } else if (mime.startsWith("audio/")) {
    score += 55;
    reasons.push(`mime:${mime}`);
  } else if (/octet-stream/i.test(mime) && isSignedUnknownUrl(candidate.url)) {
    score += 45;
    reasons.push("mime:signed-stream");
  }

  const resourceType = candidate.resourceType?.toLowerCase() ?? "";
  if (resourceType === "media") {
    score += 25;
    reasons.push("resource:media");
  } else if (["xhr", "fetch"].includes(resourceType)) {
    score += 8;
    reasons.push(`resource:${resourceType}`);
  }

  if (isSignedUnknownUrl(candidate.url) && (resourceType === "media" || mime.startsWith("video/") || mime.startsWith("audio/"))) {
    score += 50;
    reasons.push("signed-url");
  }

  if (/\.(?:vtt|srt|ass)(?:$|[?#])/i.test(candidate.url) || /subtitle|text\//i.test(mime)) return undefined;
  if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js)(?:$|[?#])/i.test(candidate.url)) return undefined;
  if (/\.(?:ts|m4s)(?:$|[?#])/i.test(candidate.url) || /\/segment(?:s)?\//i.test(candidate.url)) score -= 20;
  if (score < 45) return undefined;

  return {
    ...candidate,
    score,
    ...(format ? { format } : {}),
    reasons,
  };
}

export function rankMediaCandidates(candidates: MediaCandidateInput[], adPatterns: string[] = []): RankedMediaCandidate[] {
  const byUrl = new Map<string, RankedMediaCandidate>();
  for (const candidate of candidates) {
    const ranked = rankMediaCandidate(candidate, adPatterns);
    if (!ranked) continue;
    const existing = byUrl.get(ranked.url);
    if (!existing || ranked.score > existing.score) byUrl.set(ranked.url, ranked);
  }
  return [...byUrl.values()].sort((left, right) => right.score - left.score);
}

export function forwardMediaHeaders(headers: HeadersMap = {}): HeadersMap {
  const allowed = new Set(["user-agent", "referer", "origin", "cookie", "accept", "accept-language"]);
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) => allowed.has(key.toLowerCase()) && value.trim() !== ""));
}
