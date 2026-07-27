export interface SearchMediaLike {
  vodName: string;
  vodYear?: string;
  typeName?: string;
  siteKey?: string;
  vodId?: string;
}

export interface SearchMediaGroup<T extends SearchMediaLike> {
  key: string;
  primary: T;
  items: T[];
}

const QUALITY_TOKEN_PATTERN = /(?:4k|8k|2160p|1080p|720p|蓝光|超清|高清|原画|高码率|hdr10?\+?|hdr|dolby|杜比|web[-_. ]?dl|webrip|bluray|bdrip|remux|hevc|x26[45]|h26[45]|aac|dts|国语|国粤双语|粤语|中字|字幕|内嵌|简中|繁中|无水印|修复版|加长版|导演剪辑版)/ig;
const SOURCE_TOKEN_PATTERN = /(?:夸克|阿里|百度|天翼|115|uc|网盘|云盘|秒播|极速|直连|采集|线路)/ig;
const BRACKET_PATTERN = /[\[【（(][^\]】）)]*[\]】）)]/g;
const YEAR_PATTERN = /(?:19|20)\d{2}/g;
const SEASON_PATTERNS = [
  /第\s*([零〇一二两三四五六七八九十百\d]+)\s*季/i,
  /(?:season|s)\s*0*(\d{1,3})(?!\d)/i,
];

export function normalizeSearchTitle(value: string): string {
  const source = String(value ?? "").normalize("NFKC").trim();
  const season = extractSeason(source);
  let title = source
    .replace(BRACKET_PATTERN, (block) => isNoiseBlock(block) ? " " : block)
    .replace(YEAR_PATTERN, " ")
    .replace(QUALITY_TOKEN_PATTERN, " ")
    .replace(SOURCE_TOKEN_PATTERN, " ")
    .replace(/第\s*[零〇一二两三四五六七八九十百\d]+\s*季/ig, " ")
    .replace(/(?:season|s)\s*0*\d{1,3}(?!\d)/ig, " ")
    .replace(/(?:全集|全\s*\d+\s*集|完结|更新至?\s*\d+\s*集?)/ig, " ")
    .replace(/[·•:：|｜_/\\+\-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
  if (!title) title = source.replace(/\s+/g, "").toLowerCase();
  return season === undefined ? title : `${title}::s${season}`;
}

export function normalizedSearchYear(value: string | undefined): string {
  const match = String(value ?? "").match(/(?:19|20)\d{2}/);
  return match?.[0] ?? "";
}

export function normalizedSearchType(value: string | undefined): "movie" | "tv" | "anime" | "variety" | "documentary" | "other" {
  const text = String(value ?? "").toLowerCase();
  if (/动漫|动画|anime/.test(text)) return "anime";
  if (/综艺|真人秀|variety/.test(text)) return "variety";
  if (/纪录|documentary/.test(text)) return "documentary";
  if (/电视剧|剧集|连续剧|短剧|tv|series/.test(text)) return "tv";
  if (/电影|movie|film/.test(text)) return "movie";
  return "other";
}

export function mediaTitlesCompatible(left: SearchMediaLike, right: SearchMediaLike): boolean {
  if (normalizeSearchTitle(left.vodName) !== normalizeSearchTitle(right.vodName)) return false;
  const leftYear = normalizedSearchYear(left.vodYear);
  const rightYear = normalizedSearchYear(right.vodYear);
  if (leftYear && rightYear && leftYear !== rightYear) return false;
  const leftType = normalizedSearchType(left.typeName);
  const rightType = normalizedSearchType(right.typeName);
  if (leftType !== "other" && rightType !== "other" && leftType !== rightType) return false;
  return true;
}

export function groupNormalizedSearchResults<T extends SearchMediaLike>(items: readonly T[]): SearchMediaGroup<T>[] {
  const groups: SearchMediaGroup<T>[] = [];
  for (const item of items) {
    const existing = groups.find((group) => mediaTitlesCompatible(group.primary, item));
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.push({
      key: `${normalizeSearchTitle(item.vodName)}::${normalizedSearchYear(item.vodYear) || "unknown"}::${groups.length}`,
      primary: item,
      items: [item],
    });
  }
  return groups;
}

export function rankAlternativeSourceCandidates<T extends SearchMediaLike>(
  origin: SearchMediaLike,
  candidates: readonly T[],
  attemptedSiteKeys: readonly string[] = [],
): T[] {
  const attempted = new Set(attemptedSiteKeys);
  return candidates
    .filter((item) => item.siteKey && item.siteKey !== origin.siteKey && !attempted.has(item.siteKey) && mediaTitlesCompatible(origin, item))
    .map((item, index) => ({ item, score: alternativeCandidateScore(origin, item) - index / 10_000 }))
    .sort((left, right) => right.score - left.score)
    .map(({ item }) => item);
}

function alternativeCandidateScore(origin: SearchMediaLike, candidate: SearchMediaLike): number {
  let score = 100;
  const originYear = normalizedSearchYear(origin.vodYear);
  const candidateYear = normalizedSearchYear(candidate.vodYear);
  if (originYear && candidateYear && originYear === candidateYear) score += 25;
  const originType = normalizedSearchType(origin.typeName);
  const candidateType = normalizedSearchType(candidate.typeName);
  if (originType !== "other" && originType === candidateType) score += 20;
  if (candidate.vodName.trim() === origin.vodName.trim()) score += 10;
  return score;
}

function extractSeason(value: string): number | undefined {
  for (const pattern of SEASON_PATTERNS) {
    const match = value.match(pattern);
    if (!match?.[1]) continue;
    const parsed = /^\d+$/.test(match[1]) ? Number(match[1]) : chineseNumber(match[1]);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 1000) return parsed;
  }
  return undefined;
}

function chineseNumber(value: string): number {
  const normalized = value.replace(/[〇零]/g, "零").replace(/两/g, "二");
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百]/.test(normalized)) return Number([...normalized].map((char) => digits[char] ?? "").join(""));
  let total = 0;
  let current = 0;
  for (const char of normalized) {
    if (char === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (char === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else {
      current = digits[char] ?? current;
    }
  }
  return total + current;
}

function isNoiseBlock(value: string): boolean {
  return /(?:4k|8k|2160p|1080p|720p|蓝光|超清|高清|原画|高码率|hdr|dolby|杜比|web[-_. ]?dl|webrip|bluray|remux|hevc|x26[45]|h26[45]|aac|dts)/i.test(value)
    || /(?:夸克|阿里|百度|天翼|115|uc|网盘|云盘|秒播|极速|直连|采集|线路)/i.test(value)
    || /(?:19|20)\d{2}/.test(value)
    || /(?:国语|粤语|中字|字幕|全集|完结|\d+\s*集)/i.test(value);
}
