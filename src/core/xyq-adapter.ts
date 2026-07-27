import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import { parseLooseData } from "./drpy-operation-runtime.ts";
import {
  extractFirst,
  parseHtml,
  selectAll,
  type HtmlElementNode,
} from "./drpy-runtime.ts";
import {
  combineSourceSignal,
  runSourceOperation,
  STANDARD_CAPABILITIES,
  type SourceAdapter,
  type SourceCapabilities,
} from "./source-adapter.ts";
import { parseSourceResult, parseVod } from "./vod-parser.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DIRECT_MEDIA_PATTERN = /\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i;
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const PC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_UA = "okhttp/3.12.11";

type XyqRule = Record<string, unknown>;

interface ListRuleNames {
  mode: string;
  array: string;
  nested?: string;
  jsoup: string;
  title: string;
  link: string;
  pic: string;
  remarks: string;
  prefix: string;
  suffix: string;
}

interface DirectPayload {
  url: string;
  name: string;
  pic: string;
  remarks: string;
}

interface RuleModifiers {
  base: string;
  includes: string[];
  excludes: string[];
  replacements: Array<[string, string]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function ruleText(rule: XyqRule, ...keys: string[]): string {
  for (const key of keys) {
    const value = text(rule[key]);
    if (value) return value;
  }
  return "";
}

function truthy(value: unknown, defaultValue = false): boolean {
  const normalized = text(value).toLowerCase();
  if (!normalized) return defaultValue;
  return ["1", "true", "yes", "是", "开启", "开"].includes(normalized);
}

function jsoupMode(value: unknown): boolean {
  const normalized = text(value).toLowerCase();
  if (!normalized) return true;
  return !["0", "false", "no", "否", "关", "关闭"].includes(normalized);
}

function stripComments(source: string): string {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output.replace(/^\uFEFF/, "").trim();
}

function parseRulePayload(source: string): XyqRule {
  const clean = stripComments(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    parsed = parseLooseData(clean);
  }
  if (!isRecord(parsed)) throw new Error("XYQ 规则不是有效对象");
  return parsed;
}

function resolveUa(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (["MOBILE_UA", "手机"].includes(normalized) || value.trim() === "手机") return MOBILE_UA;
  if (["PC_UA", "电脑"].includes(normalized) || value.trim() === "电脑") return PC_UA;
  return value.trim() || DEFAULT_UA;
}

function parseHeaders(value: unknown): Record<string, string> {
  const raw = text(value);
  if (!raw) return { "User-Agent": DEFAULT_UA };
  if (!raw.includes("$") && !raw.includes("#")) return { "User-Agent": resolveUa(raw) };
  const headers: Record<string, string> = {};
  for (const entry of raw.split("#")) {
    const separator = entry.indexOf("$");
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const valueText = entry.slice(separator + 1).trim();
    if (!key) continue;
    headers[key] = key.toLowerCase() === "user-agent" ? resolveUa(valueText) : valueText;
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) headers["User-Agent"] = DEFAULT_UA;
  return headers;
}

function parseModifiers(rule: string): RuleModifiers {
  const includes: string[] = [];
  const excludes: string[] = [];
  const replacements: Array<[string, string]> = [];
  const base = rule.replace(/\[(包含|不包含|替换):([^\]]*)\]/g, (_match, type: string, payload: string) => {
    if (type === "包含") includes.push(...payload.split(/[#，,]/).map((item) => item.trim()).filter(Boolean));
    else if (type === "不包含") excludes.push(...payload.split(/[#，,]/).map((item) => item.trim()).filter(Boolean));
    else {
      for (const pair of payload.split("#")) {
        const separator = pair.indexOf(">>");
        if (separator >= 0) replacements.push([pair.slice(0, separator), pair.slice(separator + 2)]);
      }
    }
    return "";
  }).trim();
  return { base, includes, excludes, replacements };
}

function applyModifiers(value: string, modifiers: RuleModifiers): string {
  if (modifiers.includes.length > 0 && !modifiers.includes.some((item) => value.includes(item))) return "";
  if (modifiers.excludes.some((item) => value.includes(item))) return "";
  let output = value;
  for (const [from, to] of modifiers.replacements) output = output.split(from).join(to);
  return output.trim();
}

function selectRuleNodes(root: HtmlElementNode, rawRule: string): HtmlElementNode[] {
  const modifiers = parseModifiers(rawRule);
  if (!modifiers.base) return [];
  return selectAll(root, modifiers.base).filter((node) => {
    const content = extractFirst(node, "&&OuterHtml");
    return applyModifiers(content, modifiers) !== "";
  });
}

function extractHtmlValue(node: HtmlElementNode, rawRule: string, baseUrl: string): string {
  if (!rawRule) return "";
  const modifiers = parseModifiers(rawRule);
  const directiveOnly = /^(?:Text|Html|OuterHtml|href|src|data-[\w-]+|title|alt|value|style|content|class|id|name|poster)$/i.test(modifiers.base);
  const expression = directiveOnly ? `&&${modifiers.base}` : modifiers.base;
  return applyModifiers(extractFirst(node, expression, baseUrl), modifiers);
}

function cutAll(source: string, rawRule: string): string[] {
  const modifiers = parseModifiers(rawRule);
  const separator = modifiers.base.indexOf("&&");
  if (separator < 0) return [];
  const startText = modifiers.base.slice(0, separator);
  const endText = modifiers.base.slice(separator + 2);
  const output: string[] = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const start = startText ? source.indexOf(startText, cursor) : cursor;
    if (start < 0) break;
    const contentStart = start + startText.length;
    const end = endText ? source.indexOf(endText, contentStart) : source.length;
    if (end < 0) break;
    const value = applyModifiers(source.slice(contentStart, end), modifiers);
    if (value) output.push(value);
    cursor = Math.max(end + Math.max(1, endText.length), contentStart + 1);
    if (!startText && !endText) break;
  }
  return output;
}

function cutFirst(source: string, rule: string): string {
  const value = cutAll(source, rule)[0] ?? "";
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function jsonPath(root: unknown, path: string): unknown {
  if (!path) return root;
  const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".").map((item) => item.trim()).filter(Boolean);
  let current = root;
  for (const key of keys) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
}

function jsonField(item: unknown, rawPath: string): string {
  for (const path of rawPath.split("||").map((entry) => entry.trim()).filter(Boolean)) {
    const value = jsonPath(item, path);
    if (value !== undefined && value !== null && text(value)) return text(value);
  }
  return "";
}

function normalizeUrl(value: string, baseUrl: string, prefix = "", suffix = ""): string {
  if (!value) return "";
  const decorated = `${prefix}${value}${suffix}`;
  try {
    return new URL(decorated, baseUrl).toString();
  } catch {
    return decorated;
  }
}

function normalizePlaybackUrl(value: string, baseUrl: string, prefix = "", suffix = ""): string {
  return normalizeUrl(value, baseUrl, prefix, suffix)
    .replace(/#isVideo=(?:true|false)#/gi, "")
    .trim();
}

function replacePlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const value = values[key] ?? values[key.toLowerCase()];
    return value === undefined ? match : value;
  });
}

function firstPageTemplate(template: string, page: string, startPage: string): string {
  const match = template.match(/\[firstPage=([\s\S]*)\]$/i);
  if (!match) return template;
  const normal = template.slice(0, match.index);
  return page === startPage ? (match[1] ?? normal) : normal;
}

function listRule(prefix: "首页" | "分类" | "搜索"): ListRuleNames {
  return {
    mode: `${prefix}截取模式`,
    array: `${prefix}列表数组规则`,
    ...(prefix === "首页" ? { nested: "首页片单列表数组规则" } : {}),
    jsoup: `${prefix}片单是否Jsoup写法`,
    title: `${prefix}片单标题`,
    link: `${prefix}片单链接`,
    pic: `${prefix}片单图片`,
    remarks: `${prefix}片单副标题`,
    prefix: `${prefix}片单链接加前缀`,
    suffix: `${prefix}片单链接加后缀`,
  };
}

function directMarker(payload: DirectPayload): string {
  return `xyq-direct:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeDirectMarker(value: string): DirectPayload | undefined {
  if (!value.startsWith("xyq-direct:")) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value.slice("xyq-direct:".length), "base64url").toString("utf8"));
    if (!isRecord(parsed)) return undefined;
    return {
      url: text(parsed.url),
      name: text(parsed.name),
      pic: text(parsed.pic),
      remarks: text(parsed.remarks),
    };
  } catch {
    return undefined;
  }
}

export class XyqAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "xyq" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = { ...STANDARD_CAPABILITIES };

  private rule: XyqRule | undefined;
  private rulePromise: Promise<XyqRule> | undefined;

  constructor(site: SiteConfig) {
    this.site = site;
    if (!site.ext?.trim()) throw new Error("XYQ 播放源缺少 ext 规则");
  }

  async init(): Promise<void> {
    await this.ensureRule();
  }

  async home(signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "home", async () => {
      const rule = await this.ensureRule(signal);
      if (!truthy(rule["是否开启获取首页数据"])) return { list: [], pageCount: 0, message: "" };
      const url = ruleText(rule, "首页推荐链接");
      if (!url) return { list: [], pageCount: 0, message: "" };
      const payload = await this.request(url, parseHeaders(rule["请求头参数"]), "GET", "", signal, rule);
      return this.parseList(payload, url, rule, listRule("首页"), listRule("分类"));
    });
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      const rule = await this.ensureRule(signal);
      const startPage = ruleText(rule, "分类起始页码") || "1";
      const rawTemplate = ruleText(rule, "分类链接");
      if (!rawTemplate) throw new Error("XYQ 规则缺少分类链接");
      const template = firstPageTemplate(rawTemplate, page, startPage);
      const placeholders = {
        cateId: extend.cateId || tid,
        cateid: extend.cateId || tid,
        catePg: page,
        catepg: page,
        page,
        pg: page,
        class: extend.class ?? "",
        area: extend.area ?? "",
        year: extend.year ?? "",
        lang: extend.lang ?? "",
        by: extend.by ?? "",
        letter: extend.letter ?? "",
      };
      const url = replacePlaceholders(template, placeholders);
      const payload = await this.request(url, parseHeaders(rule["请求头参数"]), "GET", "", signal, rule);
      return this.parseList(payload, url, rule, listRule("分类"));
    });
  }

  async search(keyword: string, page = "1", _quick = false, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      const rule = await this.ensureRule(signal);
      let template = ruleText(rule, "搜索链接");
      if (!template) throw new Error("XYQ 规则缺少搜索链接");
      const post = /;post$/i.test(template);
      template = template.replace(/;post$/i, "");
      const values = {
        wd: encodeURIComponent(keyword),
        keyword: encodeURIComponent(keyword),
        pg: page,
        page,
        SearchPg: page,
        searchPg: page,
        searchPage: page,
      };
      const url = replacePlaceholders(template, values);
      const body = post ? replacePlaceholders(ruleText(rule, "POST请求数据"), values) : "";
      const headers = parseHeaders(rule["搜索请求头参数"] ?? rule["请求头参数"]);
      if (post && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
      }
      const payload = await this.request(url, headers, post ? "POST" : "GET", body, signal, rule);
      return this.parseList(payload, url, rule, listRule("搜索"));
    });
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      const direct = decodeDirectMarker(id);
      if (direct) return this.directVod(id, direct);

      const rule = await this.ensureRule(signal);
      const headers = parseHeaders(rule["请求头参数"]);
      const payload = await this.request(id, headers, "GET", "", signal, rule);
      const baseUrl = id;
      const useJsoup = jsoupMode(rule["详情是否Jsoup写法"]);
      const root = useJsoup ? parseHtml(payload) : undefined;
      const value = (...keys: string[]) => {
        const expression = ruleText(rule, ...keys);
        if (!expression) return "";
        return useJsoup && root ? extractHtmlValue(root, expression, baseUrl) : cutFirst(payload, expression);
      };

      const play = useJsoup && root
        ? this.parseHtmlEpisodes(root, baseUrl, rule)
        : this.parseRegexEpisodes(payload, baseUrl, rule);
      const vod = parseVod({
        vod_id: id,
        vod_name: value("标题详情", "片名详情") || this.site.name,
        vod_pic: value("图片详情", "封面详情"),
        vod_remarks: value("状态详情", "更新详情"),
        vod_year: value("年代详情", "年份详情"),
        vod_area: value("地区详情"),
        vod_director: value("导演详情"),
        vod_actor: value("演员详情"),
        vod_content: value("简介详情"),
        vod_play_from: play.from,
        vod_play_url: play.urls,
      });
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
      return vod;
    });
  }

  player(flag: string, episodeUrl: string): PlayerResult {
    const rule = this.rule ?? {};
    const playUrl = this.site.playUrl ?? "";
    return {
      key: this.site.key,
      flag,
      url: episodeUrl,
      parse: DIRECT_MEDIA_PATTERN.test(episodeUrl) && playUrl === "" ? 0 : 1,
      playUrl,
      header: {
        ...parseHeaders(rule["直接播放直链视频请求头"] ?? rule["请求头参数"]),
        ...(this.site.header ?? {}),
      },
    };
  }

  async destroy(): Promise<void> {
    this.rule = undefined;
    this.rulePromise = undefined;
  }

  private async ensureRule(signal?: AbortSignal): Promise<XyqRule> {
    if (this.rule) return this.rule;
    if (this.rulePromise) return this.rulePromise;
    this.rulePromise = (async () => {
      const configured = this.site.ext?.trim() ?? "";
      const payload = /^https?:\/\//i.test(configured)
        ? await this.request(configured, { "User-Agent": DEFAULT_UA }, "GET", "", signal, {})
        : configured;
      const parsed = parseRulePayload(payload);
      this.rule = parsed;
      return parsed;
    })();
    try {
      return await this.rulePromise;
    } catch (error) {
      this.rulePromise = undefined;
      throw error;
    }
  }

  private parseList(
    payload: string,
    baseUrl: string,
    rule: XyqRule,
    names: ListRuleNames,
    fallback?: ListRuleNames,
  ): SourceResult {
    const mode = ruleText(rule, names.mode) || "1";
    const titleRule = ruleText(rule, names.title, ...(fallback ? [fallback.title] : []));
    const linkRule = ruleText(rule, names.link, ...(fallback ? [fallback.link] : []));
    const picRule = ruleText(rule, names.pic, ...(fallback ? [fallback.pic] : []));
    const remarksRule = ruleText(rule, names.remarks, ...(fallback ? [fallback.remarks] : []));
    const prefix = ruleText(rule, names.prefix, ...(fallback ? [fallback.prefix] : []));
    const suffix = ruleText(rule, names.suffix, ...(fallback ? [fallback.suffix] : []));
    const direct = text(rule["链接是否直接播放"]) === "1" || text(rule["链接是否直接播放"]) === "是";
    const rawItems: Array<Record<string, unknown>> = [];

    if (mode === "0") {
      let source = payload;
      const secondary = ruleText(rule, names.array === "分类列表数组规则" ? "分类Json数据二次截取" : names.array === "搜索列表数组规则" ? "搜索Json数据二次截取" : "首页Json数据二次截取");
      if (secondary) source = cutAll(payload, secondary)[0] ?? payload;
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch {
        parsed = parseLooseData(source);
      }
      const items = jsonPath(parsed, ruleText(rule, names.array) || "list");
      for (const item of Array.isArray(items) ? items : []) {
        const name = jsonField(item, titleRule);
        const link = normalizeUrl(jsonField(item, linkRule), baseUrl, prefix, suffix);
        if (!name || !link) continue;
        const pic = normalizeUrl(jsonField(item, picRule), baseUrl);
        const remarks = jsonField(item, remarksRule);
        rawItems.push(this.rawListItem(name, link, pic, remarks, direct));
      }
    } else {
      const root = parseHtml(payload);
      const outerRule = ruleText(rule, names.array);
      let nodes = outerRule ? selectRuleNodes(root, outerRule) : [];
      const nestedRule = names.nested ? ruleText(rule, names.nested) : "";
      if (nestedRule) nodes = nodes.flatMap((node) => selectRuleNodes(node, nestedRule));
      const useJsoup = jsoupMode(rule[names.jsoup]);
      if (useJsoup) {
        for (const node of nodes) {
          const name = extractHtmlValue(node, titleRule, baseUrl);
          const rawLink = extractHtmlValue(node, linkRule, baseUrl);
          const link = normalizeUrl(rawLink, baseUrl, prefix, suffix);
          if (!name || !link) continue;
          const pic = normalizeUrl(extractHtmlValue(node, picRule, baseUrl), baseUrl);
          const remarks = extractHtmlValue(node, remarksRule, baseUrl);
          rawItems.push(this.rawListItem(name, link, pic, remarks, direct));
        }
      } else {
        const blocks = cutAll(payload, outerRule);
        for (const block of blocks) {
          const name = cutFirst(block, titleRule);
          const link = normalizeUrl(cutFirst(block, linkRule), baseUrl, prefix, suffix);
          if (!name || !link) continue;
          const pic = normalizeUrl(cutFirst(block, picRule), baseUrl);
          const remarks = cutFirst(block, remarksRule);
          rawItems.push(this.rawListItem(name, link, pic, remarks, direct));
        }
      }
    }

    const result = parseSourceResult({ list: rawItems, pagecount: rawItems.length > 0 ? 1 : 0 });
    result.list.forEach((vod) => {
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
    });
    return result;
  }

  private rawListItem(name: string, link: string, pic: string, remarks: string, direct: boolean): Record<string, unknown> {
    if (!direct) return { vod_id: link, vod_name: name, vod_pic: pic, vod_remarks: remarks };
    const directPrefix = ruleText(this.rule ?? {}, "直接播放链接加前缀");
    const directSuffix = ruleText(this.rule ?? {}, "直接播放链接加后缀");
    const url = normalizePlaybackUrl(link, link, directPrefix, directSuffix);
    return {
      vod_id: directMarker({ url, name, pic, remarks }),
      vod_name: name,
      vod_pic: pic,
      vod_remarks: remarks,
    };
  }

  private directVod(id: string, payload: DirectPayload): Vod {
    const vod = parseVod({
      vod_id: id,
      vod_name: payload.name,
      vod_pic: payload.pic,
      vod_remarks: payload.remarks,
      vod_play_from: this.site.name || "默认线路",
      vod_play_url: `正片$${payload.url}`,
    });
    vod.siteKey = this.site.key;
    vod.siteName = this.site.name;
    return vod;
  }

  private parseHtmlEpisodes(root: HtmlElementNode, baseUrl: string, rule: XyqRule): { from: string; urls: string } {
    const lineRule = ruleText(rule, "线路列表数组规则");
    const lineTitleRule = ruleText(rule, "线路标题") || "Text";
    const lineNames = lineRule
      ? selectRuleNodes(root, lineRule).map((node) => extractHtmlValue(node, lineTitleRule, baseUrl)).filter(Boolean)
      : [];
    const playlistRule = ruleText(rule, "播放列表数组规则");
    const playlists = playlistRule ? selectRuleNodes(root, playlistRule) : [root];
    const episodeRule = ruleText(rule, "选集列表数组规则");
    const titleRule = ruleText(rule, "选集标题") || "Text";
    const linkRule = ruleText(rule, "选集链接") || "href";
    const prefix = ruleText(rule, "选集链接加前缀");
    const suffix = ruleText(rule, "选集链接加后缀");
    const reverse = truthy(rule["是否反转选集序列"]);
    const lines: Array<{ name: string; episodes: string }> = [];

    playlists.forEach((playlist, index) => {
      const episodeNodes = episodeRule ? selectRuleNodes(playlist, episodeRule) : [];
      let episodes = episodeNodes.map((node, episodeIndex) => {
        const link = normalizePlaybackUrl(extractHtmlValue(node, linkRule, baseUrl), baseUrl, prefix, suffix);
        if (!link) return "";
        const name = extractHtmlValue(node, titleRule, baseUrl) || String(episodeIndex + 1).padStart(2, "0");
        return `${name}$${link}`;
      }).filter(Boolean);
      if (reverse) episodes = episodes.reverse();
      if (!episodes.length) return;
      const name = lineNames[index] || (playlists.length === 1 ? this.site.name || "默认线路" : `线路${index + 1}`);
      lines.push({ name, episodes: episodes.join("#") });
    });

    return { from: lines.map((line) => line.name).join("$$$"), urls: lines.map((line) => line.episodes).join("$$$") };
  }

  private parseRegexEpisodes(payload: string, baseUrl: string, rule: XyqRule): { from: string; urls: string } {
    const lineBlocks = cutAll(payload, ruleText(rule, "线路列表数组规则"));
    const lineNames = lineBlocks.map((block) => cutFirst(block, ruleText(rule, "线路标题"))).filter(Boolean);
    const playlistRule = ruleText(rule, "播放列表数组规则");
    const playlists = cutAll(payload, playlistRule);
    const containers = playlists.length > 0 ? playlists : [payload];
    const episodeRule = ruleText(rule, "选集列表数组规则");
    const titleRule = ruleText(rule, "选集标题");
    const linkRule = ruleText(rule, "选集链接");
    const prefix = ruleText(rule, "选集链接加前缀");
    const suffix = ruleText(rule, "选集链接加后缀");
    const reverse = truthy(rule["是否反转选集序列"]);
    const lines: Array<{ name: string; episodes: string }> = [];

    containers.forEach((container, index) => {
      const blocks = episodeRule ? cutAll(container, episodeRule) : [];
      let episodes = blocks.map((block, episodeIndex) => {
        const link = normalizePlaybackUrl(cutFirst(block, linkRule), baseUrl, prefix, suffix);
        if (!link) return "";
        const name = cutFirst(block, titleRule) || String(episodeIndex + 1).padStart(2, "0");
        return `${name}$${link}`;
      }).filter(Boolean);
      if (reverse) episodes = episodes.reverse();
      if (!episodes.length) return;
      lines.push({
        name: lineNames[index] || (containers.length === 1 ? this.site.name || "默认线路" : `线路${index + 1}`),
        episodes: episodes.join("#"),
      });
    });

    return { from: lines.map((line) => line.name).join("$$$"), urls: lines.map((line) => line.episodes).join("$$$") };
  }

  private async request(
    url: string,
    headers: Record<string, string>,
    method: "GET" | "POST",
    body: string,
    signal: AbortSignal | undefined,
    rule: XyqRule,
  ): Promise<string> {
    const timeoutMs = Math.max(1, this.site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const response = await fetch(url, {
      method,
      headers: { ...headers, ...(this.site.header ?? {}) },
      ...(method === "POST" ? { body } : {}),
      redirect: "follow",
      signal: combineSourceSignal(timeoutMs, signal),
    });
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const encoding = ruleText(rule, "网页编码格式").toLowerCase();
    const decoder = encoding.includes("gb") ? new TextDecoder("gb18030") : new TextDecoder("utf-8");
    return decoder.decode(bytes);
  }
}
