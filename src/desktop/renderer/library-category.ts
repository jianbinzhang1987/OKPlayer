export type StandardLibraryCategoryId = "all" | "movie" | "tv" | "variety" | "anime" | "documentary" | "kids" | "more";
export type LibrarySortMode = "来源默认" | "最近更新" | "名称";

export interface RawLibraryCategory {
  id: string;
  name: string;
}

export interface LibraryCategoryGroup {
  id: StandardLibraryCategoryId;
  name: string;
  sourceCategories: RawLibraryCategory[];
}

export interface LibraryMediaItem {
  vodId: string;
  vodName: string;
  siteKey?: string;
  vodYear?: string;
  vodRemarks?: string;
  typeName?: string;
  vodTag?: string;
  contentKind?: string;
}

const CATEGORY_LABELS: Record<StandardLibraryCategoryId, string> = {
  all: "全部",
  movie: "电影",
  tv: "电视剧",
  variety: "综艺",
  anime: "动漫",
  documentary: "纪录片",
  kids: "儿童",
  more: "更多分类",
};

const HIDDEN_CATEGORY_PATTERN = /(?:登录|登陆|账号|扫码|配置|设置|工具|网盘|云盘|夸克|百度盘|115|天翼盘|移动盘|直播|电视台|频道|文件夹|目录|搜索|公告|说明|帮助|反馈|成人|福利)/i;

const CATEGORY_PATTERNS: Array<[Exclude<StandardLibraryCategoryId, "all" | "more">, RegExp]> = [
  ["documentary", /(?:纪录片|纪录|纪实|人文|自然探索)/i],
  ["kids", /(?:儿童|少儿|亲子|幼儿|宝宝|启蒙|学龄)/i],
  ["anime", /(?:动漫|动画|国漫|日漫|番剧|卡通|漫画改编)/i],
  ["variety", /(?:综艺|真人秀|脱口秀|晚会|选秀|访谈|音乐节目)/i],
  ["tv", /(?:电视剧|连续剧|剧集|国产剧|大陆剧|港剧|台剧|韩剧|日剧|美剧|英剧|泰剧|海外剧|短剧|微短剧|情景剧)/i],
  ["movie", /(?:电影|影片|院线|影院|动作片|喜剧片|爱情片|科幻片|恐怖片|惊悚片|悬疑片|犯罪片|战争片|灾难片|剧情片|经典片|高清片)/i],
];

export function classifyLibraryCategory(category: RawLibraryCategory): StandardLibraryCategoryId | "hidden" {
  const value = `${category.name} ${category.id}`.trim();
  if (!value) return "hidden";
  if (HIDDEN_CATEGORY_PATTERN.test(value)) return "hidden";
  for (const [id, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(value)) return id;
  }
  return "more";
}

export function buildLibraryCategoryGroups(categories: RawLibraryCategory[]): LibraryCategoryGroup[] {
  const deduplicated = new Map<string, RawLibraryCategory>();
  for (const category of categories) {
    const id = String(category.id ?? "").trim();
    const name = String(category.name ?? "").trim();
    if (!id || !name) continue;
    deduplicated.set(`${id}\u0000${name}`, { id, name });
  }

  const buckets = new Map<StandardLibraryCategoryId, RawLibraryCategory[]>();
  for (const category of deduplicated.values()) {
    const classified = classifyLibraryCategory(category);
    if (classified === "hidden") continue;
    buckets.set(classified, [...(buckets.get(classified) ?? []), category]);
  }

  const order: StandardLibraryCategoryId[] = ["movie", "tv", "variety", "anime", "documentary", "kids", "more"];
  return [
    { id: "all", name: CATEGORY_LABELS.all, sourceCategories: [] },
    ...order.flatMap((id) => {
      const sourceCategories = buckets.get(id) ?? [];
      return sourceCategories.length ? [{ id, name: CATEGORY_LABELS[id], sourceCategories }] : [];
    }),
  ];
}

export function isLibraryMediaItem(item: LibraryMediaItem): boolean {
  if (!item?.vodId || !item.vodName) return false;
  if (["folder", "action"].includes(String(item.vodTag ?? "").toLowerCase())) return false;
  if (["folder", "action", "live", "discovery"].includes(String(item.contentKind ?? "").toLowerCase())) return false;
  const description = `${item.vodName} ${item.typeName ?? ""}`;
  return !HIDDEN_CATEGORY_PATTERN.test(description);
}

export function dedupeLibraryItems<T extends LibraryMediaItem>(
  items: T[],
  options: { includeFolders?: boolean } = {},
): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    if (options.includeFolders) {
      if (!item?.vodId || !item.vodName) continue;
      if (String(item.vodTag ?? "").toLowerCase() === "action") continue;
      if (["action", "live", "discovery"].includes(String(item.contentKind ?? "").toLowerCase())) continue;
    } else if (!isLibraryMediaItem(item)) continue;
    const identity = item.siteKey && item.vodId
      ? `${item.siteKey}\u0000${item.vodId}`
      : `${item.vodName.trim().toLowerCase()}\u0000${item.vodYear ?? ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push(item);
  }
  return output;
}

export function sortLibraryItems<T extends LibraryMediaItem>(items: T[], sort: LibrarySortMode): T[] {
  if (sort === "名称") return [...items].sort((a, b) => a.vodName.localeCompare(b.vodName, "zh-CN"));
  return [...items];
}
