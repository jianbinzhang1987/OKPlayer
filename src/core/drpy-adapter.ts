import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DrpyOperationRuntime, type DrpyOperationContext, type DrpyOperationResult } from "./drpy-operation-runtime.ts";
import {
  DrpyCookieJar,
  DrpyRuleRuntime,
  extractFirst,
  parseDrpyList,
  parseHtml,
  selectAll,
  type HtmlElementNode,
} from "./drpy-runtime.ts";
import type { HeadersMap, PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import {
  STANDARD_CAPABILITIES,
  combineSourceSignal,
  runSourceOperation,
  type SourceAdapter,
  type SourceCapabilities,
} from "./source-adapter.ts";
import { parseVod } from "./vod-parser.ts";

const DIRECT_MEDIA_PATTERN = /\.(?:m3u8|mp4|m4v|mkv|webm|mov|flv|mp3|aac|m4a|ts)(?:$|[?#])/i;
const DEFAULT_TIMEOUT_MS = 15_000;
const PC_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36";
const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36";

interface DrpyDetailRule {
  title?: string;
  img?: string;
  desc?: string;
  content?: string;
  tabs?: string;
  lists?: string;
  playFrom?: string;
  playUrl?: string;
  tab_text?: string;
  list_text?: string;
  list_url?: string;
}

export class DrpyAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "drpy" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = { ...STANDARD_CAPABILITIES };

  private readonly ruleRuntime: DrpyRuleRuntime;
  private readonly operationRuntime: DrpyOperationRuntime;
  private readonly cookieJar = new DrpyCookieJar();
  private initialized = false;
  private rule: Record<string, unknown> = {};
  private host = "";
  private headers: HeadersMap = {};
  private ruleSource = "";

  constructor(
    site: SiteConfig,
    runtime = new DrpyRuleRuntime({ timeoutMs: Math.max(1, site.timeout ?? 15) * 1000 }),
    operationRuntime?: DrpyOperationRuntime,
  ) {
    this.site = site;
    this.ruleRuntime = runtime;
    this.operationRuntime = operationRuntime ?? new DrpyOperationRuntime({
      timeoutMs: Math.max(1, site.timeout ?? 15) * 1000,
      requestTimeoutMs: Math.max(1, site.timeout ?? 15) * 1000,
      storage: runtime.storage,
      cookieJar: this.cookieJar,
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await runSourceOperation(this.site, "init", async () => {
      this.ruleSource = this.resolveRuleSource();
      this.rule = await this.ruleRuntime.load(await this.loadRuleScript(this.ruleSource));
      this.host = this.resolveHost();
      this.headers = normalizeHeaders({ ...(this.site.header ?? {}), ...stringRecord(this.rule.headers ?? this.rule.header) });
      const preprocess = stringValue(this.rule["预处理"]);
      if (isDynamicRule(preprocess)) {
        const result = await this.operationRuntime.execute(preprocess, this.dynamicContext(this.host));
        this.applyDynamicState(result);
      }
      this.initialized = true;
    });
  }

  async home(signal?: AbortSignal): Promise<SourceResult> {
    await this.init();
    return runSourceOperation(this.site, "home", async () => {
      const template = stringValue(this.rule.homeUrl) || this.host;
      const listRule = this.listRule("推荐") || this.listRule("一级");
      if (!template || !listRule) return emptyResult();
      const request = this.createRequest(template);
      const input = this.absoluteUrl(request.url);
      if (isDynamicRule(listRule)) return this.executeDynamicList(listRule, input, "1", {}, signal);
      const response = await this.requestText(input, request.options, signal);
      return this.parseListResult(response.text, listRule, response.url, "1");
    });
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}, signal?: AbortSignal): Promise<SourceResult> {
    await this.init();
    return runSourceOperation(this.site, "category", async () => {
      const template = stringValue(this.rule.url);
      const listRule = this.listRule("一级");
      if (!template || !listRule) return emptyResult("Drpy 规则未定义分类地址或一级规则");
      const filterQuery = this.renderTemplate(stringValue(this.rule.filter_url), {}, extend);
      const categoryTemplate = filterQuery && !template.includes("fyfilter")
        ? `${template}${template.includes("?") ? "&" : "?"}${filterQuery}`
        : template;
      const request = this.createRequest(categoryTemplate, { fyclass: tid, fypage: page, fyfilter: filterQuery }, extend);
      const input = this.absoluteUrl(request.url);
      if (isDynamicRule(listRule)) return this.executeDynamicList(listRule, input, page, extend, signal, tid);
      const response = await this.requestText(input, request.options, signal);
      return this.parseListResult(response.text, listRule, response.url, page);
    });
  }

  async search(keyword: string, page = "1", _quick = false, signal?: AbortSignal): Promise<SourceResult> {
    await this.init();
    return runSourceOperation(this.site, "search", async () => {
      const template = stringValue(this.rule.searchUrl);
      const listRule = this.listRule("搜索") || this.listRule("一级");
      if (!template || !listRule) return emptyResult("Drpy 规则未定义搜索地址或搜索规则");
      const request = this.createRequest(template, { "**": encodeURIComponent(keyword), fypage: page, wd: encodeURIComponent(keyword) });
      const input = this.absoluteUrl(request.url);
      const result = isDynamicRule(listRule)
        ? await this.executeDynamicList(listRule, input, page, {}, signal, "", keyword)
        : this.parseListResult((await this.requestText(input, request.options, signal)).text, listRule, input, page);
      for (const vod of result.list) {
        vod.siteKey = this.site.key;
        vod.siteName = this.site.name;
      }
      return result;
    });
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    await this.init();
    return runSourceOperation(this.site, "detail", async () => {
      const rawDetailRule = this.rule["二级"];
      const detailTemplate = stringValue(this.rule.detailUrl) || id;
      const request = this.createRequest(detailTemplate, { fyid: id });
      const input = this.absoluteUrl(request.url);
      const dynamicDetail = stringValue(rawDetailRule);
      if (isDynamicRule(dynamicDetail)) return this.executeDynamicDetail(dynamicDetail, id, input, signal);
      const detailRule = objectValue(rawDetailRule);
      const response = await this.requestText(input, request.options, signal);
      const root = parseHtml(response.text);
      const titleParts = splitExpressions(stringValue(detailRule.title));
      const descriptionParts = splitExpressions(stringValue(detailRule.desc));
      const title = valueFrom(root, titleParts[0], response.url) || id;
      const description = descriptionParts.map((expression) => valueFrom(root, expression, response.url)).filter(Boolean);
      const playlist = await this.resolvePlaylists(response.text, root, detailRule, response.url, signal);
      const vod = parseVod({
        vod_id: id,
        vod_name: title,
        vod_pic: this.replaceImageUrl(valueFrom(root, stringValue(detailRule.img), response.url)),
        vod_remarks: valueFrom(root, titleParts[1], response.url) || "",
        vod_actor: description[0] ?? "",
        vod_director: description[1] ?? "",
        vod_content: valueFrom(root, stringValue(detailRule.content), response.url) || description.join(" · "),
        vod_play_from: valueFrom(root, stringValue(detailRule.playFrom), response.url) || playlist.playFrom,
        vod_play_url: valueFrom(root, stringValue(detailRule.playUrl), response.url) || playlist.playUrl,
      });
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
      return vod;
    });
  }

  async player(flag: string, episodeUrl: string, _flags: string[] = [], signal?: AbortSignal): Promise<PlayerResult> {
    await this.init();
    const lazy = stringValue(this.rule.lazy);
    if (isDynamicRule(lazy)) {
      return runSourceOperation(this.site, "player", () => this.executeDynamicPlayer(lazy, flag, episodeUrl, signal));
    }
    const playUrl = this.site.playUrl ?? stringValue(this.rule.playUrl);
    return {
      key: this.site.key,
      flag,
      url: this.absoluteUrl(episodeUrl),
      parse: DIRECT_MEDIA_PATTERN.test(episodeUrl) && !playUrl ? 0 : 1,
      playUrl,
      header: { ...this.headers },
    };
  }

  async destroy(): Promise<void> {
    this.initialized = false;
    this.rule = {};
    this.headers = {};
    this.host = "";
  }

  private dynamicContext(input: unknown, overrides: Partial<DrpyOperationContext> = {}): DrpyOperationContext {
    return {
      rule: this.rule,
      host: this.host,
      baseUrl: typeof input === "string" ? input : this.host,
      input,
      myUrl: typeof input === "string" ? input : "",
      headers: this.headers,
      pcUserAgent: PC_USER_AGENT,
      mobileUserAgent: MOBILE_USER_AGENT,
      ...overrides,
    };
  }

  private applyDynamicState(result: DrpyOperationResult): void {
    if (Object.keys(result.rule).length > 0) this.rule = result.rule;
    const fetchHeaders = stringRecord(recordValue(result.fetchParams).headers);
    const ruleFetchHeaders = stringRecord(recordValue(result.ruleFetchParams).headers);
    this.headers = normalizeHeaders({
      ...(this.site.header ?? {}),
      ...stringRecord(this.rule.headers ?? this.rule.header),
      ...fetchHeaders,
      ...ruleFetchHeaders,
    });
  }

  private async executeDynamicList(
    script: string,
    input: string,
    page: string,
    filters: Record<string, string>,
    signal?: AbortSignal,
    category = "",
    keyword = "",
  ): Promise<SourceResult> {
    const result = await this.operationRuntime.execute(script, this.dynamicContext(input, {
      page,
      filters,
      category,
      keyword,
      type: keyword ? "search" : category ? "category" : "home",
    }), signal);
    this.applyDynamicState(result);
    const output = recordValue(result.output);
    const rawList = result.vods.length > 0
      ? result.vods
      : Array.isArray(result.output)
        ? result.output
        : Array.isArray(output.list)
          ? output.list
          : [];
    const list = rawList.map((item) => this.normalizeDynamicVod(item)).filter((vod) => vod.vodId && vod.vodName);
    const pageCount = numberValue(output.pagecount ?? output.pageCount)
      || (list.length > 0 ? Math.max(1, Number(page) || 1) : 0);
    return { list, pageCount, message: stringValue(output.msg ?? output.message) };
  }

  private normalizeDynamicVod(value: unknown): Vod {
    const raw = recordValue(value);
    const vod = parseVod({
      vod_id: firstValue(raw, ["vod_id", "url", "id"]),
      vod_name: firstValue(raw, ["vod_name", "title", "name"]),
      vod_pic: this.replaceImageUrl(firstValue(raw, ["vod_pic", "pic_url", "pic", "img"])),
      vod_remarks: firstValue(raw, ["vod_remarks", "desc", "note", "remarks"]),
      vod_year: firstValue(raw, ["vod_year", "year"]),
      vod_area: firstValue(raw, ["vod_area", "area"]),
      vod_director: firstValue(raw, ["vod_director", "director"]),
      vod_actor: firstValue(raw, ["vod_actor", "actor"]),
      vod_content: firstValue(raw, ["vod_content", "content"]),
      vod_play_from: firstValue(raw, ["vod_play_from", "play_from"]),
      vod_play_url: firstValue(raw, ["vod_play_url", "play_url"]),
    });
    vod.siteKey = this.site.key;
    vod.siteName = this.site.name;
    return vod;
  }

  private async executeDynamicDetail(script: string, id: string, input: string, signal?: AbortSignal): Promise<Vod> {
    const result = await this.operationRuntime.execute(script, this.dynamicContext(input, {
      myUrl: id,
      type: "detail",
    }), signal);
    this.applyDynamicState(result);
    const raw = Object.keys(result.vod).length > 0 ? result.vod : recordValue(result.output);
    const generatedEpisodes = result.vods.map((item, index) => {
      const episode = recordValue(item);
      const name = firstValue(episode, ["title", "name", "vod_name"]) || String(index + 1).padStart(2, "0");
      const url = firstValue(episode, ["url", "id", "vod_id"]);
      return url ? `${name}$${url}` : "";
    }).filter(Boolean).join("#");
    const playFrom = firstValue(raw, ["vod_play_from", "play_from"]) || (generatedEpisodes ? "默认线路" : "");
    const playUrl = firstValue(raw, ["vod_play_url", "play_url"]) || generatedEpisodes;
    const vod = parseVod({
      vod_id: id,
      vod_name: firstValue(raw, ["vod_name", "title", "name"]) || id,
      vod_pic: this.replaceImageUrl(firstValue(raw, ["vod_pic", "pic_url", "pic", "img"])),
      vod_remarks: firstValue(raw, ["vod_remarks", "desc", "note", "remarks"]),
      vod_year: firstValue(raw, ["vod_year", "year"]),
      vod_area: firstValue(raw, ["vod_area", "area"]),
      vod_director: firstValue(raw, ["vod_director", "director"]),
      vod_actor: firstValue(raw, ["vod_actor", "actor"]),
      vod_content: firstValue(raw, ["vod_content", "content"]),
      vod_play_from: playFrom,
      vod_play_url: playUrl,
    });
    vod.siteKey = this.site.key;
    vod.siteName = this.site.name;
    return vod;
  }

  private async executeDynamicPlayer(script: string, flag: string, episodeUrl: string, signal?: AbortSignal): Promise<PlayerResult> {
    const input = this.absoluteUrl(episodeUrl);
    const result = await this.operationRuntime.execute(script, this.dynamicContext(input, {
      myUrl: episodeUrl,
      type: "player",
      flag,
    }), signal);
    this.applyDynamicState(result);
    const raw = recordValue(result.input);
    const output = recordValue(result.output);
    const rawUrl = firstPlayableUrl(
      Object.keys(raw).length > 0 ? raw.url : typeof result.input === "string" ? result.input : output.url,
    ) || input;
    const url = this.absoluteUrl(rawUrl);
    const playUrl = firstValue(raw, ["playUrl", "play_url"])
      || firstValue(output, ["playUrl", "play_url"])
      || this.site.playUrl
      || stringValue(this.rule.playUrl);
    const configuredParse = optionalNumberValue(raw.parse ?? output.parse);
    const parse = configuredParse ?? (DIRECT_MEDIA_PATTERN.test(url) && !playUrl ? 0 : 1);
    return {
      key: this.site.key,
      flag,
      url,
      parse,
      playUrl,
      header: {
        ...this.headers,
        ...stringRecord(raw.header ?? raw.headers ?? output.header ?? output.headers),
      },
    };
  }

  private parseListResult(payload: string, listRule: string, baseUrl: string, page: string): SourceResult {
    if (/^js:/i.test(listRule)) return emptyResult("该 Drpy 动态列表规则尚未纳入 MVP 执行范围");
    const list = parseDrpyList(payload, listRule, baseUrl).map((item) => parseVod({
      vod_id: item.id,
      vod_name: item.name,
      vod_pic: this.replaceImageUrl(item.pic),
      vod_remarks: item.remarks,
    }));
    return { list, pageCount: list.length > 0 ? Math.max(1, Number(page) || 1) : 0, message: "" };
  }

  private async resolvePlaylists(
    html: string,
    root: HtmlElementNode,
    detailRule: DrpyDetailRule,
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<{ playFrom: string; playUrl: string }> {
    const dynamicScripts = [detailRule.tabs, detailRule.lists]
      .map((value) => stringValue(value))
      .filter(isDynamicRule);
    if (dynamicScripts.length === 0) return this.parsePlaylists(root, detailRule, baseUrl);

    const result = await this.operationRuntime.execute(
      dynamicScripts.map(stripDynamicPrefix).join("\n"),
      this.dynamicContext(baseUrl, {
        myUrl: baseUrl,
        type: "detail-playlist",
        html,
      }),
      signal,
    );
    this.applyDynamicState(result);
    if (result.lists.length === 0) return this.parsePlaylists(root, detailRule, baseUrl);

    const rawLines = result.lists.every(Array.isArray)
      ? result.lists as unknown[][]
      : [result.lists];
    const lines = rawLines.map((line) => line.map((item, index) => {
      if (typeof item === "string") return normalizeEpisodeEntry(item, index, baseUrl);
      const episode = recordValue(item);
      const name = firstValue(episode, ["name", "title", "vod_name"]) || String(index + 1).padStart(2, "0");
      const url = firstValue(episode, ["url", "id", "vod_id", "play_url"]);
      return url ? `${name}$${absoluteResourceUrl(url, baseUrl)}` : "";
    }).filter(Boolean).join("#"));
    const tabs = result.tabs.map((item) => String(item).trim()).filter(Boolean);
    while (tabs.length < lines.length) tabs.push(lines.length === 1 ? "默认线路" : `线路${tabs.length + 1}`);
    return { playFrom: tabs.slice(0, lines.length).join("$$$"), playUrl: lines.join("$$$") };
  }

  private parsePlaylists(root: HtmlElementNode, detailRule: DrpyDetailRule, baseUrl: string): { playFrom: string; playUrl: string } {
    const tabsExpression = stringValue(detailRule.tabs);
    const listsExpression = stringValue(detailRule.lists);
    if (!listsExpression) return { playFrom: "", playUrl: "" };
    const tabNames = (tabsExpression ? drpyNodes(root, tabsExpression) : [])
      .map((node, index) => extractRelative(node, stringValue(detailRule.tab_text), baseUrl, "Text") || `线路${index + 1}`);
    const lineCount = Math.max(1, tabNames.length);
    const lines: string[] = [];
    for (let index = 0; index < lineCount; index += 1) {
      const expression = listsExpression.replace(/#id/g, String(index));
      const episodes = drpyNodes(root, expression).map((node, episodeIndex) => {
        const name = extractRelative(node, stringValue(detailRule.list_text), baseUrl, "Text") || String(episodeIndex + 1).padStart(2, "0");
        const url = stringValue(detailRule.list_url)
          ? extractRelative(node, stringValue(detailRule.list_url), baseUrl, "href")
          : firstAttribute(node, ["href", "data-url", "data-play", "data-id", "value"], baseUrl);
        if (!url && name.includes("$")) return name;
        return url ? `${name}$${url}` : "";
      }).filter(Boolean);
      lines.push(episodes.join("#"));
    }
    return { playFrom: (tabNames.length ? tabNames : ["默认线路"]).join("$$$"), playUrl: lines.join("$$$") };
  }

  private listRule(key: "推荐" | "一级" | "搜索"): string {
    const value = stringValue(this.rule[key]);
    const base = stringValue(this.rule["一级"]);
    if (value === "*") return base;
    if (!value || key === "一级" || !value.includes("*")) return value;
    const baseParts = base.split(";");
    return value.split(";").map((part, index) => part.trim() === "*" ? (baseParts[index]?.trim() ?? "") : part.trim()).join(";");
  }

  private createRequest(
    template: string,
    replacements: Record<string, string> = {},
    extend: Record<string, string> = {},
  ): { url: string; options: RequestInit } {
    const rendered = this.renderTemplate(template, replacements, extend);
    const requestMatch = rendered.match(/^(.*)#([^#]*);(post|get)$/i);
    if (!requestMatch) return { url: rendered, options: {} };
    const url = requestMatch[1] ?? rendered;
    const parameters = requestMatch[2] ?? "";
    const method = (requestMatch[3] ?? "get").toUpperCase();
    if (method === "GET") {
      return { url: parameters ? `${url}${url.includes("?") ? "&" : "?"}${parameters}` : url, options: {} };
    }
    return {
      url,
      options: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: parameters,
      },
    };
  }

  private renderTemplate(template: string, replacements: Record<string, string>, extend: Record<string, string> = {}): string {
    let value = template;
    for (const [key, replacement] of Object.entries(replacements)) value = value.split(key).join(replacement);
    value = value.replace(/\{\{\s*fl\.([\w\u4e00-\u9fff]+)(?:\s+or\s+["']([^"']*)["'])?\s*\}\}/g, (_match, key: string, fallback: string | undefined) => {
      return encodeURIComponent(extend[key] ?? fallback ?? "");
    });
    value = value.replace(/\{\{\s*fl\s*\}\}/g, encodeURIComponent(JSON.stringify(extend)));
    for (const [key, replacement] of Object.entries(extend)) value = value.split(`fy${key}`).join(encodeURIComponent(replacement));
    return value;
  }

  private replaceImageUrl(value: string): string {
    const replacement = stringValue(this.rule["图片替换"]);
    const separator = replacement.indexOf("=>");
    if (!value || separator < 0) return value;
    const source = replacement.slice(0, separator).trim();
    const target = replacement.slice(separator + 2).trim();
    return source && value.startsWith(source) ? `${target}${value.slice(source.length)}` : value;
  }

  private absoluteUrl(value: string): string {
    try {
      return new URL(value, this.host || this.ruleSource || this.site.api).toString();
    } catch {
      return value;
    }
  }

  private resolveRuleSource(): string {
    const value = (this.site.ext || this.site.api).split(";md5;")[0]?.trim() ?? "";
    if (!value) throw new Error("Drpy 播放源缺少规则脚本地址");
    return value;
  }

  private resolveHost(): string {
    const configured = stringValue(this.rule.host);
    if (configured) {
      try {
        return new URL(configured, this.ruleSource).toString();
      } catch {
        return configured;
      }
    }
    for (const value of [this.ruleSource, this.site.api]) {
      try {
        return new URL(value).origin;
      } catch {
        // Continue.
      }
    }
    return "";
  }

  private async loadRuleScript(source: string): Promise<string> {
    if (/^(?:var|let|const)\s+rule\b|module\.exports|export\s+default|^\s*\{/m.test(source)) {
      return normalizeRuleScriptPayload(source);
    }
    const payload = source.startsWith("file:")
      ? await readFile(fileURLToPath(source), "utf8")
      : !/^https?:\/\//i.test(source)
        ? await readFile(source, "utf8")
        : (await this.requestText(source, { headers: this.site.header ?? {} })).text;
    return normalizeRuleScriptPayload(payload);
  }

  private async requestText(url: string, options: RequestInit = {}, signal?: AbortSignal): Promise<{ text: string; url: string }> {
    const timeoutMs = Math.max(1, this.site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const headers = new Headers(this.headers);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    const cookie = this.cookieJar.getCookieHeader(url);
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    const response = await fetch(url, {
      ...options,
      headers,
      signal: combineSourceSignal(timeoutMs, signal ?? options.signal ?? undefined),
      redirect: "follow",
    });
    this.cookieJar.store(response.url || url, response.headers);
    if (!response.ok) throw new Error(`Drpy 请求失败：HTTP ${response.status}`);
    return { text: await response.text(), url: response.url || url };
  }
}

function isDynamicRule(value: string): boolean {
  return /^js:/i.test(value.trim());
}

function stripDynamicPrefix(value: string): string {
  return value.replace(/^\s*js:\s*/i, "").trim();
}

function normalizeEpisodeEntry(value: string, index: number, baseUrl: string): string {
  const separator = value.indexOf("$");
  if (separator < 0) {
    const url = value.trim();
    return url ? `${String(index + 1).padStart(2, "0")}$${absoluteResourceUrl(url, baseUrl)}` : "";
  }
  const name = value.slice(0, separator).trim() || String(index + 1).padStart(2, "0");
  const url = value.slice(separator + 1).trim();
  return url ? `${name}$${absoluteResourceUrl(url, baseUrl)}` : "";
}

function absoluteResourceUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function normalizeRuleScriptPayload(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) return `const rule = ${trimmed}`;
  if (/^(?:var|let|const)\s+rule\b|module\.exports|export\s+default/m.test(trimmed)) return trimmed;

  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length >= 80 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf8").trim();
      if (/^(?:\/\/|\/\*)|(?:var|let|const)\s+rule\b|module\.exports|export\s+default/m.test(decoded)) return decoded;
    } catch {
      // Keep the original payload when it is not valid Base64 text.
    }
  }
  return trimmed;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstValue(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
    if (typeof item === "number" || typeof item === "boolean") return String(item);
  }
  return "";
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalNumberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function firstPlayableUrl(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && /^(?:https?:\/\/|\/)/i.test(item.trim())) return item.trim();
      const nested = firstPlayableUrl(item);
      if (nested) return nested;
    }
  }
  const record = recordValue(value);
  return firstValue(record, ["url", "src", "playUrl", "play_url"]);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): DrpyDetailRule {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as DrpyDetailRule : {};
}

function stringRecord(value: unknown): HeadersMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function normalizeHeaders(headers: HeadersMap): HeadersMap {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const token = value.trim().toUpperCase();
    if (token === "PC_UA") return [key, PC_USER_AGENT];
    if (token === "MOBILE_UA") return [key, MOBILE_USER_AGENT];
    if (token === "UA") return [key, "Mozilla/5.0"];
    return [key, value];
  }));
}

function emptyResult(message = ""): SourceResult {
  return { list: [], pageCount: 0, message };
}

function splitExpressions(value: string): string[] {
  return value ? value.split(";").map((item) => item.trim()).filter(Boolean) : [];
}

function valueFrom(root: HtmlElementNode, expression: string | undefined, baseUrl: string): string {
  return expression ? extractFirst(root, expression, baseUrl) : "";
}

function drpyNodes(root: HtmlElementNode, expression: string): HtmlElementNode[] {
  const separator = expression.lastIndexOf("&&");
  if (separator < 0) return selectAll(root, expression);
  const parentSelector = expression.slice(0, separator).trim();
  const tail = expression.slice(separator + 2).trim();
  const parents = parentSelector ? selectAll(root, parentSelector) : [root];
  if (!tail || /^(?:Text|Html|OuterHtml|href|src|data-[\w-]+|value)$/i.test(tail)) return parents;
  return parents.flatMap((parent) => selectAll(parent, tail));
}

function extractRelative(node: HtmlElementNode, expression: string, baseUrl: string, fallbackDirective: string): string {
  let normalized = expression.trim();
  if (/^body&&/i.test(normalized)) normalized = `&&${normalized.slice(normalized.indexOf("&&") + 2)}`;
  if (!normalized) normalized = `&&${fallbackDirective}`;
  const value = extractFirst(node, normalized, baseUrl);
  if (value) return value;
  const separator = normalized.lastIndexOf("&&");
  const directive = separator >= 0 ? normalized.slice(separator + 2).trim() : fallbackDirective;
  return extractFirst(node, `&&${directive || fallbackDirective}`, baseUrl);
}

function firstAttribute(node: HtmlElementNode, attributes: string[], baseUrl: string): string {
  for (const attribute of attributes) {
    const raw = node.attributes[attribute];
    if (!raw) continue;
    if (!["href", "src", "data-url", "data-play"].includes(attribute)) return raw;
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return raw;
    }
  }
  return "";
}
