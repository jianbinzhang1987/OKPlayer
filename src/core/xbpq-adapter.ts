import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import { parseLooseData } from "./drpy-operation-runtime.ts";
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

type XbpqRule = Record<string, unknown>;

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

function ruleText(rule: XbpqRule, ...keys: string[]): string {
  for (const key of keys) {
    const value = text(rule[key]);
    if (value) return value;
  }
  return "";
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

function parseRulePayload(source: string): XbpqRule {
  const clean = stripComments(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    parsed = parseLooseData(clean);
  }
  if (!isRecord(parsed)) throw new Error("XBPQ 规则不是有效对象");
  return parsed;
}

function resolveUa(value: string): string {
  const raw = value.trim();
  if (/^(?:手机|MOBILE_UA)$/i.test(raw)) return MOBILE_UA;
  if (/^(?:电脑|PC_UA)$/i.test(raw)) return PC_UA;
  return raw;
}

function parseHeaders(value: unknown): Record<string, string> {
  const raw = text(value);
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const entry of raw.split("#").map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf("$");
    if (separator < 0) {
      if (/^(?:手机|电脑|MOBILE_UA|PC_UA)$/i.test(entry)) headers["User-Agent"] = resolveUa(entry);
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    if (!key) continue;
    headers[key] = key.toLowerCase() === "user-agent" ? resolveUa(rawValue) : rawValue;
  }
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

function cutAll(source: string, rawRule: string): string[] {
  const modifiers = parseModifiers(rawRule);
  const separator = modifiers.base.indexOf("&&");
  if (separator < 0) return [];
  const prefix = modifiers.base.slice(0, separator);
  const suffix = modifiers.base.slice(separator + 2);
  const output: string[] = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const start = prefix ? source.indexOf(prefix, cursor) : cursor;
    if (start < 0) break;
    const contentStart = start + prefix.length;
    const end = suffix ? source.indexOf(suffix, contentStart) : source.length;
    if (end < 0) break;
    const full = source.slice(start, end + suffix.length);
    const content = applyModifiers(source.slice(contentStart, end), modifiers);
    if (content && applyModifiers(full, modifiers)) output.push(content);
    cursor = Math.max(end + Math.max(1, suffix.length), contentStart + 1);
    if (!prefix && !suffix) break;
  }
  return output;
}

function cleanText(value: string): string {
  return value
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\\//g, "/")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cutFirst(source: string, rule: string): string {
  return cleanText(cutAll(source, rule)[0] ?? "");
}

function evaluateExpression(source: string, expression: string): string {
  if (!expression) return "";
  const parts = expression.split("+");
  if (parts.length > 1 && parts.some((part) => part.includes("&&"))) {
    return parts.map((part) => part.includes("&&") ? cutFirst(source, part) : part).join("").trim();
  }
  return cutFirst(source, expression);
}

function firstExtract(source: string, rules: string[]): string {
  for (const rule of rules) {
    if (!rule) continue;
    const value = evaluateExpression(source, rule) || evaluateExpression(`${source}<`, rule);
    if (value) return value;
  }
  return "";
}

function normalizeUrl(value: string, baseUrl: string, prefix = "", suffix = ""): string {
  if (!value) return "";
  const decorated = `${prefix}${value}${suffix}`.replace(/#isVideo=(?:true|false)#/gi, "");
  try {
    return new URL(decorated, baseUrl).toString();
  } catch {
    return decorated;
  }
}

function replacePlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => values[key] ?? values[key.toLowerCase()] ?? match);
}

function chooseArrayRule(payload: string, explicit: string, candidates: string[]): string {
  if (explicit) return explicit;
  return candidates.find((rule) => cutAll(payload, rule).length > 0) ?? "";
}

export class XbpqAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "xbpq" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = { ...STANDARD_CAPABILITIES };

  private rule: XbpqRule | undefined;
  private rulePromise: Promise<XbpqRule> | undefined;

  constructor(site: SiteConfig) {
    this.site = site;
    if (!site.ext?.trim()) throw new Error("XBPQ 播放源缺少 ext 规则");
  }

  async init(): Promise<void> {
    await this.ensureRule();
  }

  async home(signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "home", async () => {
      const rule = await this.ensureRule(signal);
      const url = ruleText(rule, "主页url", "主页URL", "首页url");
      if (!url) return { list: [], pageCount: 0, message: "" };
      const payload = await this.request(url, "GET", "", signal, rule);
      return this.parseList(payload, url, rule, false);
    });
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      const rule = await this.ensureRule(signal);
      const rawTemplate = ruleText(rule, "分类url", "分类URL").split(";;")[0] ?? "";
      if (!rawTemplate) throw new Error("XBPQ 规则缺少分类url");
      const values = {
        cateId: extend.cateId || tid,
        cateid: extend.cateId || tid,
        catePg: page,
        catepg: page,
        pg: page,
        page,
        area: extend.area ?? "",
        by: extend.by ?? "",
        class: extend.class ?? "",
        lang: extend.lang ?? "",
        year: extend.year ?? "",
        letter: extend.letter ?? "",
      };
      const base = ruleText(rule, "主页url", "主页URL");
      const url = normalizeUrl(replacePlaceholders(rawTemplate, values), base || rawTemplate);
      const payload = await this.request(url, "GET", "", signal, rule);
      return this.parseList(payload, url, rule, false);
    });
  }

  async search(keyword: string, page = "1", _quick = false, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      const rule = await this.ensureRule(signal);
      const raw = ruleText(rule, "搜索url", "搜索URL");
      if (!raw) throw new Error("XBPQ 规则缺少搜索url");
      const segments = raw.split(";post;");
      const post = segments.length > 1;
      const values = { wd: encodeURIComponent(keyword), pg: page, page };
      const base = ruleText(rule, "主页url", "主页URL");
      const url = normalizeUrl(replacePlaceholders(segments[0] ?? raw, values), base || raw);
      const body = post ? replacePlaceholders(segments.slice(1).join(";post;"), values) : "";
      const payload = await this.request(url, post ? "POST" : "GET", body, signal, rule);
      const secondary = ruleText(rule, "搜索二次截取");
      const source = secondary ? (cutAll(payload, secondary)[0] ?? payload) : payload;
      return this.parseList(source, url, rule, true);
    });
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      const rule = await this.ensureRule(signal);
      const payload = await this.request(id, "GET", "", signal, rule);
      const play = this.parseEpisodes(payload, id, rule);
      const vod = parseVod({
        vod_id: id,
        vod_name: firstExtract(payload, [ruleText(rule, "详情标题", "影片标题"), ruleText(rule, "标题")]) || this.site.name,
        vod_pic: normalizeUrl(firstExtract(payload, [ruleText(rule, "详情图片", "影片图片"), ruleText(rule, "图片")]), id),
        vod_remarks: firstExtract(payload, [ruleText(rule, "影片状态", "状态")]),
        vod_year: firstExtract(payload, [ruleText(rule, "影片年代", "年份", "年代")]),
        vod_area: firstExtract(payload, [ruleText(rule, "影片地区", "地区")]),
        vod_director: firstExtract(payload, [ruleText(rule, "导演")]),
        vod_actor: firstExtract(payload, [ruleText(rule, "主演", "演员")]),
        vod_content: firstExtract(payload, [ruleText(rule, "简介", "详情简介")]),
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
      header: { ...parseHeaders(rule["请求头"]), ...(this.site.header ?? {}) },
    };
  }

  async destroy(): Promise<void> {
    this.rule = undefined;
    this.rulePromise = undefined;
  }

  private async ensureRule(signal?: AbortSignal): Promise<XbpqRule> {
    if (this.rule) return this.rule;
    if (this.rulePromise) return this.rulePromise;
    this.rulePromise = (async () => {
      const configured = this.site.ext?.trim() ?? "";
      const payload = /^https?:\/\//i.test(configured)
        ? await this.requestRaw(configured, { "User-Agent": MOBILE_UA }, "GET", "", signal, {})
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

  private parseList(payload: string, baseUrl: string, rule: XbpqRule, search: boolean): SourceResult {
    const arrayRule = chooseArrayRule(payload, ruleText(rule, search ? "搜索数组" : "数组"), search
      ? ["{&&}", "<li&&</li>", "<article&&</article>", "<a&&</a>"]
      : ["<li&&</li>", "<article&&</article>", "class=\"stui-vodlist__box\"&&</a", "<a&&</a>"]);
    if (!arrayRule) return { list: [], pageCount: 0, message: "" };
    const blocks = cutAll(payload, arrayRule);
    const titleRule = ruleText(rule, search ? "搜索标题" : "标题");
    const picRule = ruleText(rule, search ? "搜索图片" : "图片");
    const linkRule = ruleText(rule, search ? "搜索链接" : "链接");
    const remarksRule = ruleText(rule, search ? "搜索副标题" : "副标题");
    const linkPrefix = ruleText(rule, search ? "搜索前缀" : "链接前缀");
    const linkSuffix = ruleText(rule, search ? "搜索后缀" : "链接后缀");

    const items: Array<Record<string, unknown>> = [];
    for (const block of blocks) {
      const name = firstExtract(block, [titleRule, "title=\"&&\"", "alt=\"&&\""]);
      const rawLink = firstExtract(block, [linkRule, "href=\"&&\""]);
      if (!name || !rawLink) continue;
      const pic = normalizeUrl(firstExtract(block, [picRule, "data-original=\"&&\"", "data-src=\"&&\"", "src=\"&&\""]), baseUrl);
      const link = normalizeUrl(rawLink, baseUrl, linkPrefix, linkSuffix);
      const remarks = firstExtract(block, [remarksRule]);
      items.push({ vod_id: link, vod_name: name, vod_pic: pic, vod_remarks: remarks });
    }

    const result = parseSourceResult({ list: items, pagecount: items.length > 0 ? 1 : 0 });
    result.list.forEach((vod) => {
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
    });
    return result;
  }

  private parseEpisodes(payload: string, baseUrl: string, rule: XbpqRule): { from: string; urls: string } {
    const lineRule = ruleText(rule, "线路数组");
    const lineTitleRule = ruleText(rule, "线路标题");
    const lineNames = lineRule
      ? cutAll(payload, lineRule).map((block) => firstExtract(block, [lineTitleRule, ">&&<"])).filter(Boolean)
      : [];

    const playlistRule = chooseArrayRule(payload, ruleText(rule, "播放数组"), [
      "<ul class=\"stui-content__playlist&&</ul>",
      "<ul class=\"myui-play__list&&</ul>",
      "class=\"module-play-list&&</div>",
    ]);
    const containers = playlistRule ? cutAll(payload, playlistRule) : [payload];
    const episodeRule = ruleText(rule, "播放列表") || "<a&&</a>";
    const titleRule = ruleText(rule, "播放标题") || ">&&<";
    const linkRule = ruleText(rule, "播放链接") || "href=\"&&\"";
    const prefix = ruleText(rule, "播放链接前缀", "选集前缀");
    const suffix = ruleText(rule, "播放链接后缀", "选集后缀");
    const lines: Array<{ name: string; episodes: string }> = [];

    containers.forEach((container, index) => {
      const episodes = cutAll(container, episodeRule).map((block, episodeIndex) => {
        const rawLink = firstExtract(block, [linkRule, "href=\"&&\""]);
        const link = normalizeUrl(rawLink, baseUrl, prefix, suffix);
        if (!link) return "";
        const name = firstExtract(block, [titleRule]) || String(episodeIndex + 1).padStart(2, "0");
        return `${name}$${link}`;
      }).filter(Boolean);
      if (!episodes.length) return;
      lines.push({
        name: lineNames[index] || (containers.length === 1 ? this.site.name || "默认线路" : `线路${index + 1}`),
        episodes: episodes.join("#"),
      });
    });

    return { from: lines.map((line) => line.name).join("$$$"), urls: lines.map((line) => line.episodes).join("$$$") };
  }

  private async request(url: string, method: "GET" | "POST", body: string, signal: AbortSignal | undefined, rule: XbpqRule): Promise<string> {
    return this.requestRaw(url, parseHeaders(rule["请求头"]), method, body, signal, rule);
  }

  private async requestRaw(
    url: string,
    headers: Record<string, string>,
    method: "GET" | "POST",
    body: string,
    signal: AbortSignal | undefined,
    rule: XbpqRule,
  ): Promise<string> {
    const timeoutMs = Math.max(1, this.site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const requestHeaders = { ...headers, ...(this.site.header ?? {}) };
    if (method === "POST" && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type")) {
      requestHeaders["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    }
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      ...(method === "POST" ? { body } : {}),
      redirect: "follow",
      signal: combineSourceSignal(timeoutMs, signal),
    });
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const encoding = ruleText(rule, "编码", "网页编码格式").toLowerCase();
    return new TextDecoder(encoding.includes("gb") ? "gb18030" : "utf-8").decode(bytes);
  }
}
