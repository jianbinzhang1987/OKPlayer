import vm from "node:vm";
import type { PlayerResult, SiteConfig, SourceResult, Vod } from "./models.ts";
import { runSourceOperation, STANDARD_CAPABILITIES, type SourceAdapter, type SourceCapabilities } from "./source-adapter.ts";
import { parseJsonSourceResult, parseVod } from "./vod-parser.ts";

export interface SpiderContext {
  request(url: string, options?: RequestInit): Promise<string>;
}

export interface JsRuntimeOptions {
  timeoutMs?: number;
}

export class JsSpiderRuntime {
  private readonly context: SpiderContext;
  private readonly timeoutMs: number;
  private sandbox?: vm.Context;
  private scriptSource = "";

  constructor(context: SpiderContext, options: JsRuntimeOptions = {}) {
    this.context = context;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async init(script: string, extend = ""): Promise<void> {
    this.scriptSource = script;
    const sandbox: Record<string, unknown> = {
      console,
      request: this.context.request.bind(this.context),
      fetchText: this.context.request.bind(this.context),
      setTimeout,
      clearTimeout,
      URL,
      URLSearchParams,
      JSON,
      result: undefined,
    };
    this.sandbox = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    new vm.Script(script, { filename: "spider.js" }).runInContext(this.sandbox, { timeout: this.timeoutMs });
    if (this.hasMethod("init")) await this.call("init", [extend]);
  }

  hasMethod(method: string): boolean {
    if (!this.sandbox) return false;
    return new vm.Script(`typeof ${method} === 'function'`).runInContext(this.sandbox, { timeout: 500 }) === true;
  }

  async call(method: string, args: unknown[] = []): Promise<unknown> {
    if (!this.sandbox) throw new Error("JS Spider 尚未初始化");
    if (!this.hasMethod(method)) throw new Error(`JS Spider 未实现方法：${method}`);
    this.sandbox.__spiderArgs = args;
    const value = new vm.Script(`${method}(...__spiderArgs)`, { filename: `spider:${method}` })
      .runInContext(this.sandbox, { timeout: this.timeoutMs });
    return this.withTimeout(Promise.resolve(value), method);
  }

  async execute(script: string, method: string, args: unknown[] = []): Promise<unknown> {
    await this.init(script);
    try {
      return await this.call(method, args);
    } finally {
      await this.destroy();
    }
  }

  request(url: string, options?: RequestInit) {
    return this.context.request(url, options);
  }

  async destroy(): Promise<void> {
    if (this.sandbox && this.hasMethod("destroy")) {
      await this.withTimeout(Promise.resolve(new vm.Script("destroy()")
        .runInContext(this.sandbox, { timeout: this.timeoutMs })), "destroy").catch(() => undefined);
    }
    this.sandbox = undefined;
    this.scriptSource = "";
  }

  private async withTimeout<T>(task: Promise<T>, method: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`JS Spider 方法超时：${method}`)), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class JsSiteAdapter implements SourceAdapter {
  readonly site: SiteConfig;
  readonly runtime = "javascript" as const;
  readonly supported = true;
  readonly capabilities: SourceCapabilities = { ...STANDARD_CAPABILITIES };
  private readonly spiderRuntime: JsSpiderRuntime;
  private script?: string;
  private initialized = false;

  constructor(site: SiteConfig, runtime: JsSpiderRuntime) {
    this.site = site;
    this.spiderRuntime = runtime;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await runSourceOperation(this.site, "init", async () => {
      this.script = await this.loadScript();
      await this.spiderRuntime.init(this.script, this.site.ext ?? "");
      this.initialized = true;
    });
  }

  async home(): Promise<SourceResult> {
    return runSourceOperation(this.site, "home", async () => {
      await this.init();
      return this.sourceResult(await this.spiderRuntime.call("homeContent", [true]));
    });
  }

  async category(tid: string, page = "1", extend: Record<string, string> = {}): Promise<SourceResult> {
    return runSourceOperation(this.site, "category", async () => {
      await this.init();
      return this.sourceResult(await this.spiderRuntime.call("categoryContent", [tid, page, true, extend]));
    });
  }

  async search(keyword: string, page = "1"): Promise<SourceResult> {
    return runSourceOperation(this.site, "search", async () => {
      await this.init();
      const args = page === "1" ? [keyword, false] : [keyword, false, page];
      const result = this.sourceResult(await this.spiderRuntime.call("searchContent", args));
      result.list.forEach((vod) => {
        vod.siteKey = this.site.key;
        vod.siteName = this.site.name;
      });
      return result;
    });
  }

  async detail(id: string): Promise<Vod> {
    return runSourceOperation(this.site, "detail", async () => {
      await this.init();
      const raw = await this.spiderRuntime.call("detailContent", [[id]]);
      const result = this.sourceResult(raw);
      const vod = result.list[0] ?? parseVod(raw);
      vod.siteKey = this.site.key;
      vod.siteName = this.site.name;
      return vod;
    });
  }

  async player(flag: string, id: string, flags: string[] = []): Promise<PlayerResult> {
    return runSourceOperation(this.site, "player", async () => {
      await this.init();
      const raw = await this.spiderRuntime.call("playerContent", [flag, id, flags]);
      const value = typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>;
      return {
        key: this.site.key,
        flag: typeof value.flag === "string" && value.flag ? value.flag : flag,
        url: typeof value.url === "string" ? value.url : id,
        parse: Number(value.parse ?? value.jx ?? 0),
        playUrl: typeof value.playUrl === "string" ? value.playUrl : "",
        header: typeof value.header === "object" && value.header !== null ? value.header as Record<string, string> : { ...(this.site.header ?? {}) },
        ...(typeof value.format === "string" ? { format: value.format } : {}),
      };
    });
  }

  async destroy(): Promise<void> {
    await runSourceOperation(this.site, "destroy", async () => {
      await this.spiderRuntime.destroy();
      this.initialized = false;
    }).catch(() => undefined);
  }

  private sourceResult(raw: unknown): SourceResult {
    if (typeof raw === "string") return parseJsonSourceResult(raw);
    if (typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).list)) {
      const value = raw as Record<string, unknown>;
      return {
        list: (value.list as unknown[]).map(parseVod),
        pageCount: Number(value.pagecount ?? value.pageCount ?? 0),
        message: typeof value.msg === "string" ? value.msg : "",
      };
    }
    return { list: [], pageCount: 0, message: "" };
  }

  private async loadScript(): Promise<string> {
    if (!this.site.api.startsWith("http://") && !this.site.api.startsWith("https://")) return this.site.api;
    return this.spiderRuntime.request(this.site.api, { headers: this.site.header });
  }
}
