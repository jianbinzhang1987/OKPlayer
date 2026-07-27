import type {
  ContentKind,
  Episode,
  Flag,
  SourceCategory,
  SourceFilterGroup,
  SourceResult,
  Vod,
} from "./models.ts";

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function parseEpisodes(value: string): Episode[] {
  if (value.trim() === "") return [];
  return value.split("#").filter(Boolean).map((entry, index) => {
    const separator = entry.indexOf("$");
    const defaultName = String(index + 1).padStart(2, "0");
    if (separator < 0) return { name: defaultName, url: entry.trim(), index };
    const name = entry.slice(0, separator).trim() || defaultName;
    const url = entry.slice(separator + 1).trim();
    return { name, url, index };
  }).filter((episode) => episode.url !== "");
}

export function parseFlags(playFrom: string, playUrl: string): Flag[] {
  const names = playFrom.split("$$$");
  const urls = playUrl.split("$$$");
  const size = Math.min(names.length, urls.length);
  const flags: Flag[] = [];
  for (let index = 0; index < size; index += 1) {
    const flag = names[index]?.trim() ?? "";
    const rawEpisodes = urls[index] ?? "";
    if (flag === "" || rawEpisodes.trim() === "") continue;
    flags.push({ flag, show: flag, episodes: parseEpisodes(rawEpisodes) });
  }
  return flags;
}

export function parseVod(input: unknown): Vod {
  const raw = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const vodPlayFrom = text(raw.vod_play_from);
  const vodPlayUrl = text(raw.vod_play_url);
  const vodTag = text(raw.vod_tag ?? raw.tag);
  const contentKind = normalizeContentKind(raw.content_kind ?? raw.contentKind, vodTag);
  return {
    vodId: text(raw.vod_id ?? raw.id),
    vodName: text(raw.vod_name ?? raw.name),
    ...(vodTag ? { vodTag } : {}),
    ...(contentKind ? { contentKind } : {}),
    ...(text(raw.action_type ?? raw.actionType) ? { actionType: text(raw.action_type ?? raw.actionType) } : {}),
    ...(raw.action_payload !== undefined ? { actionPayload: raw.action_payload } : raw.actionPayload !== undefined ? { actionPayload: raw.actionPayload } : {}),
    typeName: text(raw.type_name ?? raw.type),
    vodPic: text(raw.vod_pic ?? raw.pic),
    vodRemarks: text(raw.vod_remarks ?? raw.note),
    vodYear: text(raw.vod_year ?? raw.year),
    vodArea: text(raw.vod_area ?? raw.area),
    vodDirector: text(raw.vod_director ?? raw.director),
    vodActor: text(raw.vod_actor ?? raw.actor),
    vodContent: text(raw.vod_content ?? raw.des),
    vodPlayFrom,
    vodPlayUrl,
    flags: parseFlags(vodPlayFrom, vodPlayUrl),
  };
}

export function parseSourceResult(input: unknown): SourceResult {
  const raw = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const list = Array.isArray(raw.list) ? raw.list.map(parseVod) : [];
  const categories = parseCategories(raw.class ?? raw.categories);
  const filters = parseFilters(raw.filters);
  const page = finiteNumber(raw.page);
  const pageCount = finiteNumber(raw.pagecount ?? raw.pageCount) ?? 0;
  const total = finiteNumber(raw.total);
  const limit = finiteNumber(raw.limit);
  return {
    list,
    ...(categories.length ? { categories } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(page !== undefined ? { page } : {}),
    pageCount,
    ...(total !== undefined ? { total } : {}),
    ...(limit !== undefined ? { limit } : {}),
    message: text(raw.msg ?? raw.message),
  };
}

export function parseJsonSourceResult(payload: string): SourceResult {
  try {
    return parseSourceResult(JSON.parse(payload));
  } catch (error) {
    throw new Error(`播放源返回的内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeContentKind(value: unknown, vodTag: string): ContentKind | undefined {
  const candidate = text(value);
  if (["playable", "discovery", "folder", "action", "live"].includes(candidate)) return candidate as ContentKind;
  if (vodTag === "folder") return "folder";
  if (vodTag === "action") return "action";
  return undefined;
}

function parseCategories(value: unknown): SourceCategory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      const label = item.trim();
      return label ? [{ id: label, name: label }] : [];
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const id = text(raw.type_id ?? raw.id ?? raw.value);
    const name = text(raw.type_name ?? raw.name ?? raw.label ?? id);
    return id && name ? [{ id, name }] : [];
  });
}

function parseFilters(value: unknown): Record<string, SourceFilterGroup[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const output: Record<string, SourceFilterGroup[]> = {};
  for (const [categoryId, groups] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const parsed = groups.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const raw = item as Record<string, unknown>;
      const key = text(raw.key ?? raw.id);
      const name = text(raw.name ?? raw.label ?? key);
      const values = Array.isArray(raw.value) ? raw.value : Array.isArray(raw.options) ? raw.options : [];
      const options = values.flatMap((option) => {
        if (typeof option === "string") {
          const label = option.trim();
          return label ? [{ label, value: label }] : [];
        }
        if (typeof option !== "object" || option === null || Array.isArray(option)) return [];
        const source = option as Record<string, unknown>;
        const optionValue = text(source.v ?? source.value ?? source.id);
        const label = text(source.n ?? source.name ?? source.label ?? optionValue);
        return label ? [{ label, value: optionValue }] : [];
      });
      if (!key || !name || !options.length) return [];
      const defaultValue = text(raw.init ?? raw.defaultValue);
      return [{ key, name, options, ...(defaultValue ? { defaultValue } : {}) }];
    });
    if (parsed.length) output[categoryId] = parsed;
  }
  return output;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function xmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1] ?? "") : "";
}

export function parseXmlSourceResult(payload: string): SourceResult {
  const videos = [...payload.matchAll(/<video(?:\s[^>]*)?>([\s\S]*?)<\/video>/gi)].map((match) => {
    const block = match[1] ?? "";
    return parseVod({
      vod_id: xmlTag(block, "id"),
      vod_name: xmlTag(block, "name"),
      type_name: xmlTag(block, "type"),
      vod_pic: xmlTag(block, "pic"),
      vod_remarks: xmlTag(block, "note"),
      vod_year: xmlTag(block, "year"),
      vod_area: xmlTag(block, "area"),
      vod_director: xmlTag(block, "director"),
      vod_actor: xmlTag(block, "actor"),
      vod_content: xmlTag(block, "des"),
      vod_play_from: [...block.matchAll(/<dd[^>]*flag=["']([^"']+)["'][^>]*>/gi)].map((item) => decodeXml(item[1] ?? "")).join("$$$"),
      vod_play_url: [...block.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)].map((item) => decodeXml(item[1] ?? "")).join("$$$"),
    });
  });
  const pageMatch = payload.match(/<list[^>]*pagecount=["'](\d+)["']/i);
  return { list: videos, pageCount: pageMatch ? Number(pageMatch[1]) : 0, message: "" };
}
