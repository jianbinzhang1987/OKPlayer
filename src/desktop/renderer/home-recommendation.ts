import { isLibraryMediaItem, type LibraryMediaItem } from "./library-category.ts";

export interface HomeRecommendationItem extends LibraryMediaItem {
  vodPic?: string;
  vodContent?: string;
  vodArea?: string;
}

export type HomeContentGroup = "movie" | "tv" | "other";

const MOVIE_PATTERN = /(?:电影|影片|院线|动作片|喜剧片|爱情片|科幻片|恐怖片|悬疑片|犯罪片|战争片|剧情片)/i;
const TV_PATTERN = /(?:电视剧|连续剧|剧集|国产剧|港剧|台剧|韩剧|日剧|美剧|英剧|泰剧|短剧|微短剧)/i;
const HIDDEN_HOME_PATTERN = /(?:登录|登陆|账号|扫码|配置|设置|工具|网盘管理|云盘管理|直播|电视台|频道|文件夹|目录|公告|说明|帮助)/i;

function isHomeMediaItem(item: HomeRecommendationItem): boolean {
  if (!item?.vodId || !item.vodName) return false;
  if (["folder", "action"].includes(String(item.vodTag ?? "").toLowerCase())) return false;
  if (["folder", "action", "live"].includes(String(item.contentKind ?? "").toLowerCase())) return false;
  if (HIDDEN_HOME_PATTERN.test(`${item.vodName} ${item.typeName ?? ""}`)) return false;
  return item.contentKind === "discovery" || isLibraryMediaItem(item);
}

export function homeItemIdentity(item: HomeRecommendationItem): string {
  if (item.siteKey && item.vodId) return `${item.siteKey}\u0000${item.vodId}`;
  return `${item.vodName.trim().toLowerCase()}\u0000${item.vodYear ?? ""}`;
}

export function classifyHomeContent(item: HomeRecommendationItem): HomeContentGroup {
  const description = `${item.typeName ?? ""} ${item.vodName}`;
  if (MOVIE_PATTERN.test(description)) return "movie";
  if (TV_PATTERN.test(description)) return "tv";
  return "other";
}

export function selectHomeRecommendations<T extends HomeRecommendationItem>(
  items: T[],
  options: { limit?: number; excluded?: Iterable<string>; cachedOrder?: Iterable<string> } = {},
): T[] {
  const limit = Math.min(8, Math.max(1, options.limit ?? 8));
  const excluded = new Set(options.excluded ?? []);
  const candidates = items.filter((item) => {
    if (!isHomeMediaItem(item)) return false;
    if (excluded.has(homeItemIdentity(item))) return false;
    return Boolean(item.vodPic || item.vodContent || item.vodRemarks);
  });

  const unique = new Map<string, T>();
  for (const item of candidates) {
    const identity = homeItemIdentity(item);
    if (!unique.has(identity)) unique.set(identity, item);
  }

  const cachedOrder = [...(options.cachedOrder ?? [])];
  const cachedRank = new Map(cachedOrder.map((identity, index) => [identity, index]));
  return [...unique.values()]
    .map((item, index) => ({ item, index, identity: homeItemIdentity(item), group: classifyHomeContent(item) }))
    .sort((a, b) => {
      const priority = (group: HomeContentGroup) => group === "movie" || group === "tv" ? 0 : 1;
      const priorityDifference = priority(a.group) - priority(b.group);
      if (priorityDifference !== 0) return priorityDifference;
      const aCached = cachedRank.get(a.identity);
      const bCached = cachedRank.get(b.identity);
      if (aCached !== undefined || bCached !== undefined) {
        if (aCached === undefined) return 1;
        if (bCached === undefined) return -1;
        return aCached - bCached;
      }
      return a.index - b.index;
    })
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function selectHomeSection<T extends HomeRecommendationItem>(
  items: T[],
  group: Exclude<HomeContentGroup, "other">,
  excluded: Iterable<string> = [],
  limit = 6,
): T[] {
  const excludedSet = new Set(excluded);
  return items
    .filter((item) => isHomeMediaItem(item) && classifyHomeContent(item) === group && !excludedSet.has(homeItemIdentity(item)))
    .filter((item, index, list) => list.findIndex((candidate) => homeItemIdentity(candidate) === homeItemIdentity(item)) === index)
    .slice(0, limit);
}
