import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import { parseLooseData } from "./drpy-operation-runtime.ts";
import {
  combineSourceSignal,
  runSourceOperation,
  STANDARD_CAPABILITIES,
  type SourceAdapter,
  type SourceCapabilities,
} from "./source-adapter.ts";
import { parseVod } from "./vod-parser.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 30;

interface AlistSourceConfig {
  name?: string;
  server: string;
  startPage?: string;
  showAll?: boolean;
  search?: boolean;
  params?: string | Record<string, unknown>;
  headers?: string | Record<string, unknown>;
  username?: string;
  password?: string;
}

interface AlistSettings {
  title: string;
  v3: boolean;
  version: string;
  enableSearch: boolean;
  pageSize: number;
}

interface AlistEndpoints {
  list: string;
  file: string;
  search: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    try {
      const parsed = parseLooseData(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

function stringHeaders(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseObject(value))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function normalizeServer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizePath(value: string, folder = false): string {
  const path = `/${value}`.replace(/\/{2,}/g, "/");
  if (folder) return path === "/" ? "/" : `${path.replace(/\/+$/, "")}/`;
  return path === "/" ? "/" : path.replace(/\/+$/, "");
}

function joinPath(parent: string, name: string, folder: boolean): string {
  return normalizePath(`${normalizePath(parent, true)}${name}`, folder);
}

function normalizeUrl(value: string, base: string): string {
  if (!value) return "";
  try {
    return new URL(value, `${base}/`).toString();
  } catch {
    return value;
  }
}

function v2Files(data: Record<string, unknown>): unknown[] {
  const files = data.files;
  if (!Array.isArray(files)) return [];
  if (files.length === 1 && Array.isArray(files[0])) return files[0];
  return files;
}

function formatSize(value: unknown): string {
  let size = Number(value);
  if (!Number.isFinite(size) || size < 0) size = 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

export class AlistAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "alist" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = { ...STANDARD_CAPABILITIES };

  private initialized = false;
  private server = "";
  private startPage = "/";
  private showAll = false;
  private searchEnabled = true;
  private params: Record<string, unknown> = {};
  private headers: Record<string, string> = {};
  private user = { username: "", password: "" };
  private settings: AlistSettings = {
    title: "Alist",
    v3: true,
    version: "",
    enableSearch: true,
    pageSize: DEFAULT_PAGE_SIZE,
  };
  private endpoints: AlistEndpoints = {
    list: "/api/fs/list",
    file: "/api/fs/get",
    search: "/api/fs/search",
  };

  constructor(site: SiteConfig) {
    this.site = site;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await runSourceOperation(this.site, "init", async () => {
      const source = await this.loadSourceConfig();
      this.server = normalizeServer(source.server);
      if (!/^https?:\/\//i.test(this.server)) throw new Error("Alist server 必须是 HTTP/HTTPS 地址");
      this.startPage = normalizePath(source.startPage || "/", true);
      this.showAll = source.showAll === true;
      this.searchEnabled = source.search !== false;
      this.params = parseObject(source.params);
      this.headers = { ...stringHeaders(source.headers), ...(this.site.header ?? {}) };
      this.user = {
        username: text(source.username),
        password: text(source.password),
      };

      const response = await this.requestJson("/api/public/settings", { method: "GET" });
      const data = response.data;
      if (Array.isArray(data)) {
        const setting = (key: string) => data.find((item) => isRecord(item) && text(item.key) === key);
        this.settings = {
          title: text(setting("title")?.value) || text(source.name) || this.site.name,
          v3: false,
          version: text(setting("version")?.value),
          enableSearch: text(setting("enable search")?.value).toLowerCase() === "true",
          pageSize: Number(setting("default page size")?.value) || DEFAULT_PAGE_SIZE,
        };
        this.endpoints = {
          list: "/api/public/path",
          file: "/api/public/path",
          search: "/api/public/search",
        };
      } else {
        const raw = isRecord(data) ? data : {};
        this.settings = {
          title: text(raw.site_title) || text(source.name) || this.site.name,
          v3: true,
          version: text(raw.version),
          enableSearch: raw.enable_search === false ? false : true,
          pageSize: Number(raw.default_page_size) || DEFAULT_PAGE_SIZE,
        };
        this.endpoints = {
          list: "/api/fs/list",
          file: "/api/fs/get",
          search: "/api/fs/search",
        };
      }

      await this.login();
      this.initialized = true;
    });
  }

  async home(signal?: AbortSignal): Promise<SourceResult> {
    return this.category("default", "1", {}, signal);
  }

  async category(
    tid: string,
    page = "1",
    _extend: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      await this.init();
      const path = tid === "default" || !tid ? this.startPage : normalizePath(tid, true);
      const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
      const body = this.settings.v3
        ? {
            ...this.pathParams(path),
            page: currentPage,
            per_page: this.settings.pageSize,
            refresh: false,
          }
        : {
            ...this.pathParams(path),
            page_num: currentPage,
            page_size: this.settings.pageSize,
          };
      const response = await this.requestJson(this.endpoints.list, { method: "POST", body, signal });
      const data = isRecord(response.data) ? response.data : {};
      const rawList = this.settings.v3
        ? (Array.isArray(data.content) ? data.content : [])
        : v2Files(data);
      return this.listResult(rawList, path, currentPage, Number(data.total));
    });
  }

  async search(keyword: string, page = "1", _quick = false, signal?: AbortSignal): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      await this.init();
      const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
      if (!this.searchEnabled || !this.settings.enableSearch) {
        return { list: [], pageCount: 0, message: "Alist 搜索未启用" };
      }
      const body = this.settings.v3
        ? {
            ...this.pathParams(this.startPage),
            keywords: keyword,
            parent: this.startPage,
            page: currentPage,
            per_page: this.settings.pageSize,
            scope: 0,
          }
        : {
            ...this.pathParams(this.startPage),
            keywords: keyword,
            parent: this.startPage,
            page_num: currentPage,
            page_size: this.settings.pageSize,
          };
      const response = await this.requestJson(this.endpoints.search, { method: "POST", body, signal });
      const data = isRecord(response.data) ? response.data : {};
      const rawList = this.settings.v3
        ? (Array.isArray(data.content) ? data.content : [])
        : v2Files(data);
      return this.listResult(rawList, this.startPage, currentPage, Number(data.total), true);
    });
  }

  async detail(id: string, signal?: AbortSignal): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      await this.init();
      if (id.endsWith("/")) throw new Error("Alist 目录不能直接播放，请先进入目录选择文件");
      const path = normalizePath(id);
      const response = await this.requestJson(this.endpoints.file, {
        method: "POST",
        body: this.pathParams(path),
        signal,
      });
      const data = isRecord(response.data) ? response.data : {};
      const file = this.settings.v3
        ? data
        : (v2Files(data).find(isRecord) as Record<string, unknown> | undefined) ?? data;
      const name = text(file.name) || path.split("/").filter(Boolean).at(-1) || "文件";
      const rawUrl = text(file.raw_url ?? file.url);
      if (!rawUrl) throw new Error("Alist 未返回文件直链");
      const playUrl = normalizeUrl(rawUrl, this.server);
      const vod = parseVod({
        vod_id: path,
        vod_name: name,
        vod_tag: "file",
        vod_pic: this.picture(file),
        vod_remarks: formatSize(file.size),
        vod_play_from: this.settings.title,
        vod_play_url: `${name.replaceAll("$", "_").replaceAll("#", "_")}$${playUrl}`,
      });
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
      return vod;
    });
  }

  player(flag: string, episodeUrl: string): PlayerResult {
    return {
      key: this.site.key,
      flag,
      url: episodeUrl,
      parse: 0,
      playUrl: "",
      // Alist 登录 Token 仅用于调用 Alist API，不透传到可能位于第三方域名的媒体直链。
      header: { ...(this.site.header ?? {}) },
    };
  }

  async destroy(): Promise<void> {
    this.initialized = false;
    delete this.headers.Authorization;
  }

  private async loadSourceConfig(): Promise<AlistSourceConfig> {
    const ext = this.site.ext?.trim() ?? "";
    if (!ext) throw new Error("Alist 播放源缺少 ext 配置");
    if (/^https?:\/\//i.test(ext)) {
      const response = await fetch(ext, {
        headers: { ...(this.site.header ?? {}) },
        redirect: "follow",
        signal: combineSourceSignal(this.timeoutMs()),
      });
      if (!response.ok) throw new Error(`Alist 配置下载失败：HTTP ${response.status}`);
      const payload = (await response.text()).trim();
      const parsed = parseObject(payload);
      if (text(parsed.server)) return parsed as unknown as AlistSourceConfig;
      return { server: ext };
    }
    const parsed = parseObject(ext);
    const server = text(parsed.server);
    if (!server) throw new Error("Alist ext 必须包含 server 地址");
    return parsed as unknown as AlistSourceConfig;
  }

  private listResult(
    rawList: unknown[],
    parent: string,
    page: number,
    rawTotal: number,
    search = false,
  ): SourceResult {
    const items = rawList
      .filter(isRecord)
      .filter((item) => this.showAll || this.isFolder(item) || this.isVideo(item))
      .map((item) => {
        const name = text(item.name);
        if (!name) return undefined;
        const folder = this.isFolder(item);
        const rawParent = search ? text(item.parent) || parent : parent;
        const id = joinPath(rawParent, name, folder);
        return parseVod({
          vod_id: id,
          vod_name: name.replaceAll("$", "_").replaceAll("#", "_"),
          vod_tag: folder ? "folder" : "file",
          vod_pic: this.picture(item),
          vod_remarks: folder ? "文件夹" : formatSize(item.size),
        });
      })
      .filter((item): item is Vod => item !== undefined);

    items.forEach((vod) => {
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
    });
    const total = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : items.length;
    const pageCount = total > 0 ? Math.ceil(total / this.settings.pageSize) : 0;
    return { list: items, pageCount, message: "" };
  }

  private isFolder(item: Record<string, unknown>): boolean {
    return Number(item.type) === 1 || item.is_dir === true;
  }

  private isVideo(item: Record<string, unknown>): boolean {
    if (this.isFolder(item)) return false;
    const type = Number(item.type);
    if (this.settings.v3 && type === 2) return true;
    if (!this.settings.v3 && type === 3) return true;
    return /\.(?:mp4|mkv|m3u8|webm|mov|flv|avi|wmv|ts|m4v|mpg|mpeg|mp3|aac|m4a|flac|wav|ogg)$/i.test(text(item.name));
  }

  private picture(item: Record<string, unknown>): string {
    const value = text(this.settings.v3 ? item.thumb : item.thumbnail ?? item.thumb);
    return normalizeUrl(value, this.server);
  }

  private pathParams(path: string): Record<string, unknown> {
    const normalized = normalizePath(path, path.endsWith("/"));
    const key = normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
    const configured = this.params[key];
    if (typeof configured === "string") return { path: normalized, password: configured };
    if (isRecord(configured)) return { path: normalized, ...configured };
    return { path: normalized, password: "" };
  }

  private async login(): Promise<void> {
    if (!this.settings.v3 || !this.user.username || !this.user.password) return;
    const response = await this.requestJson("/api/auth/login", {
      method: "POST",
      body: this.user,
      includeAuthorization: false,
    });
    const data = isRecord(response.data) ? response.data : {};
    const token = text(data.token);
    if (token) this.headers.Authorization = token;
  }

  private async requestJson(
    endpoint: string,
    options: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
      signal?: AbortSignal;
      includeAuthorization?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const requestHeaders: Record<string, string> = {
      ...this.headers,
      ...(this.site.header ?? {}),
      ...(options.method === "POST" ? { "content-type": "application/json;charset=UTF-8" } : {}),
    };
    if (options.includeAuthorization === false) delete requestHeaders.Authorization;
    const response = await fetch(`${this.server}${endpoint}`, {
      method: options.method,
      headers: requestHeaders,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      redirect: "follow",
      signal: combineSourceSignal(this.timeoutMs(), options.signal),
    });
    if (!response.ok) throw new Error(`Alist 请求失败：HTTP ${response.status}`);
    const payload = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new Error(`Alist 返回的内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed)) throw new Error("Alist 响应不是 JSON 对象");
    const code = Number(parsed.code);
    if (Number.isFinite(code) && code !== 200) {
      throw new Error(text(parsed.message) || `Alist API 返回 code=${code}`);
    }
    return parsed;
  }

  private timeoutMs(): number {
    return Math.max(1, this.site.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
  }
}
