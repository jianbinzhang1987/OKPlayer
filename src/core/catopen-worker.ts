import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import vm from "node:vm";
import { extractFirst, parseHtml, selectAll, type HtmlElementNode } from "./drpy-runtime.ts";
import { isNonPublicAddress, isUnsafeResolvedAddress } from "./network-address.ts";

interface WorkerRequest {
  id: number;
  method: string;
  args?: unknown[];
}

interface InitPayload {
  code: string;
  config: Record<string, unknown>;
  timeoutMs?: number;
}

interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: { message: string; stack?: string };
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const storage = new Map<string, string>();
let sandbox: vm.Context | undefined;
let moduleValue: Record<string, unknown> | undefined;
let timeoutMs = DEFAULT_TIMEOUT_MS;

function send(message: WorkerResponse): void {
  process.send?.(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`CatOpen 仅允许 HTTP/HTTPS：${url.protocol}`);
  const hostname = url.hostname.toLowerCase();
  if (["localhost", "localhost.localdomain"].includes(hostname) || hostname.endsWith(".local")) throw new Error("CatOpen 已阻止本地网络地址");
  if (isIP(hostname)) {
    if (isNonPublicAddress(hostname)) throw new Error("CatOpen 已阻止私有网络地址");
    return url;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isUnsafeResolvedAddress(entry.address))) {
    throw new Error("CatOpen DNS 解析包含私有网络地址");
  }
  return url;
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const current = await reader.read();
      if (current.done) break;
      total += current.value.length;
      if (total > MAX_RESPONSE_BYTES) throw new Error(`CatOpen 响应超过 ${MAX_RESPONSE_BYTES} bytes 限制`);
      chunks.push(current.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(output);
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

async function req(rawUrl: string, rawOptions: Record<string, unknown> = {}): Promise<{ code: number; content: string; headers: Record<string, string> }> {
  const url = await assertPublicUrl(String(rawUrl));
  const headers = normalizeHeaders(rawOptions.headers);
  const method = String(rawOptions.method ?? (rawOptions.data || rawOptions.body ? "POST" : "GET")).toUpperCase();
  let body: BodyInit | undefined;
  const data = rawOptions.data ?? rawOptions.body;
  if (data !== undefined && data !== null) {
    if (typeof data === "string") body = data;
    else if (data instanceof Uint8Array) body = Buffer.from(data) as unknown as BodyInit;
    else if (rawOptions.postType === "form") {
      body = new URLSearchParams(Object.entries(data as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
      headers["Content-Type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
    } else {
      body = JSON.stringify(data);
      headers["Content-Type"] ??= "application/json;charset=UTF-8";
    }
  }
  const signal = AbortSignal.timeout(Math.max(1, Number(rawOptions.timeout ?? timeoutMs)));
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: rawOptions.redirect === false ? "manual" : "follow",
    signal,
  });
  const content = await readLimited(response);
  return {
    code: response.status,
    content,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function batchFetch(items: unknown[]): Promise<unknown[]> {
  return Promise.all(items.map(async (entry) => {
    if (typeof entry === "string") return req(entry);
    if (!isRecord(entry)) return { code: 500, content: "", headers: {} };
    return req(String(entry.url ?? ""), isRecord(entry.options) ? entry.options : entry);
  }));
}

class HtmlCollection {
  readonly nodes: HtmlElementNode[];
  readonly baseUrl: string;

  constructor(nodes: HtmlElementNode[], baseUrl = "") {
    this.nodes = nodes;
    this.baseUrl = baseUrl;
  }

  get length(): number { return this.nodes.length; }
  find(selector: string): HtmlCollection { return new HtmlCollection(this.nodes.flatMap((node) => selectAll(node, selector)), this.baseUrl); }
  eq(index: number): HtmlCollection {
    const actual = index < 0 ? this.nodes.length + index : index;
    return new HtmlCollection(this.nodes[actual] ? [this.nodes[actual]!] : [], this.baseUrl);
  }
  first(): HtmlCollection { return this.eq(0); }
  text(): string { return this.nodes.map((node) => extractFirst(node, "&&Text", this.baseUrl)).join(" ").trim(); }
  html(): string { return this.nodes.map((node) => extractFirst(node, "&&Html", this.baseUrl)).join(""); }
  attr(name: string): string { return this.nodes[0] ? extractFirst(this.nodes[0], `&&${name}`, this.baseUrl) : ""; }
  toArray(): HtmlElementNode[] { return [...this.nodes]; }
  each(callback: (index: number, node: HtmlElementNode) => unknown): HtmlCollection {
    this.nodes.forEach((node, index) => callback(index, node));
    return this;
  }
  map(callback: (index: number, node: HtmlElementNode) => unknown): unknown[] {
    return this.nodes.map((node, index) => callback(index, node));
  }
}

function htmlNode(value: unknown): HtmlElementNode {
  return value && typeof value === "object" && "type" in value
    ? value as HtmlElementNode
    : parseHtml(String(value ?? ""));
}

function pdfa(value: unknown, rule: string): HtmlElementNode[] {
  return selectAll(htmlNode(value), String(rule ?? ""));
}

function pdfh(value: unknown, rule: string, baseUrl = ""): string {
  return extractFirst(htmlNode(value), String(rule ?? ""), baseUrl);
}

function pd(value: unknown, rule: string, baseUrl = ""): string {
  return extractFirst(htmlNode(value), String(rule ?? ""), baseUrl);
}

function load(html: string, baseUrl = "") {
  const root = parseHtml(String(html));
  const query = (selectorOrNode?: string | HtmlElementNode): HtmlCollection => {
    if (typeof selectorOrNode === "string") return new HtmlCollection(selectAll(root, selectorOrNode), baseUrl);
    if (selectorOrNode && typeof selectorOrNode === "object") return new HtmlCollection([selectorOrNode], baseUrl);
    return new HtmlCollection([root], baseUrl);
  };
  return query;
}

class BaseSpider {
  private readonly config: Record<string, unknown>;
  constructor(config: Record<string, unknown> = {}) { this.config = config; }
  getConfig(): Record<string, unknown> { return this.config; }
}

const local = {
  get(key: string, fallback = ""): string { return storage.get(String(key)) ?? String(fallback); },
  set(key: string, value: unknown): void { storage.set(String(key), typeof value === "string" ? value : JSON.stringify(value)); },
  delete(key: string): void { storage.delete(String(key)); },
  clear(): void { storage.clear(); },
};

const lodashLite = {
  get(value: unknown, path: string, fallback?: unknown): unknown {
    let current = value;
    for (const key of String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
      if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
      else if (isRecord(current)) current = current[key];
      else return fallback;
    }
    return current ?? fallback;
  },
  map<T, R>(items: T[] | Record<string, T>, callback: (value: T, key: number | string) => R): R[] {
    return Array.isArray(items) ? items.map(callback) : Object.entries(items).map(([key, value]) => callback(value, key));
  },
  each<T>(items: T[] | Record<string, T>, callback: (value: T, key: number | string) => unknown): void {
    if (Array.isArray(items)) items.forEach(callback);
    else Object.entries(items).forEach(([key, value]) => callback(value, key));
  },
  uniqBy<T>(items: T[], callback: (value: T) => unknown): T[] {
    const seen = new Set<unknown>();
    return items.filter((item) => {
      const key = callback(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
  isArray: Array.isArray,
  isObject: isRecord,
};

function md5X(value: unknown): string {
  return createHash("md5").update(String(value)).digest("hex");
}

class CryptoWordArray {
  readonly buffer: Buffer;
  constructor(value: Buffer | Uint8Array | string = Buffer.alloc(0), encoding: BufferEncoding = "utf8") {
    this.buffer = Buffer.isBuffer(value)
      ? value
      : typeof value === "string"
        ? Buffer.from(value, encoding)
        : Buffer.from(value);
  }
  toString(encoder?: { stringify?: (value: CryptoWordArray) => string }): string {
    return encoder?.stringify ? encoder.stringify(this) : this.buffer.toString("hex");
  }
}

function wordBuffer(value: unknown, defaultEncoding: BufferEncoding = "utf8"): Buffer {
  if (value instanceof CryptoWordArray) return value.buffer;
  if (value && typeof value === "object" && "ciphertext" in value) return wordBuffer((value as { ciphertext: unknown }).ciphertext);
  return Buffer.from(String(value ?? ""), defaultEncoding);
}

const cryptoEnc = {
  Utf8: {
    parse(value: unknown): CryptoWordArray { return new CryptoWordArray(String(value ?? ""), "utf8"); },
    stringify(value: CryptoWordArray): string { return wordBuffer(value).toString("utf8"); },
  },
  Hex: {
    parse(value: unknown): CryptoWordArray { return new CryptoWordArray(String(value ?? ""), "hex"); },
    stringify(value: CryptoWordArray): string { return wordBuffer(value).toString("hex"); },
  },
  Base64: {
    parse(value: unknown): CryptoWordArray { return new CryptoWordArray(String(value ?? ""), "base64"); },
    stringify(value: CryptoWordArray): string { return wordBuffer(value).toString("base64"); },
  },
  Latin1: {
    parse(value: unknown): CryptoWordArray { return new CryptoWordArray(String(value ?? ""), "latin1"); },
    stringify(value: CryptoWordArray): string { return wordBuffer(value).toString("latin1"); },
  },
};

function cryptoHash(algorithm: string, value: unknown): CryptoWordArray {
  return new CryptoWordArray(createHash(algorithm).update(wordBuffer(value)).digest());
}

function cryptoHmac(algorithm: string, value: unknown, key: unknown): CryptoWordArray {
  return new CryptoWordArray(createHmac(algorithm, wordBuffer(key)).update(wordBuffer(value)).digest());
}

function cryptoCipher(algorithm: "aes", encrypt: boolean, input: unknown, keyValue: unknown, options: Record<string, unknown> = {}) {
  const keySource = wordBuffer(keyValue);
  const bits = keySource.length >= 32 ? 256 : keySource.length >= 24 ? 192 : 128;
  const key = Buffer.alloc(bits / 8);
  keySource.copy(key, 0, 0, key.length);
  const modeValue = String((options.mode as { name?: string } | undefined)?.name ?? options.mode ?? "cbc").toLowerCase();
  const mode = modeValue.includes("ecb") ? "ecb" : "cbc";
  const ivSource = wordBuffer(options.iv ?? Buffer.alloc(16));
  const iv = mode === "ecb" ? null : Buffer.concat([ivSource, Buffer.alloc(16)]).subarray(0, 16);
  const cipherName = `${algorithm}-${bits}-${mode}`;
  const cipher = encrypt ? createCipheriv(cipherName, key, iv) : createDecipheriv(cipherName, key, iv);
  const paddingName = String((options.padding as { name?: string } | undefined)?.name ?? options.padding ?? "pkcs7").toLowerCase();
  if (paddingName.includes("nopadding")) cipher.setAutoPadding(false);
  const inputBuffer = encrypt
    ? wordBuffer(input)
    : typeof input === "string" ? Buffer.from(input, "base64") : wordBuffer(input);
  const output = Buffer.concat([cipher.update(inputBuffer), cipher.final()]);
  const word = new CryptoWordArray(output);
  return encrypt
    ? { ciphertext: word, toString: () => output.toString("base64") }
    : word;
}

const CryptoJS = {
  enc: cryptoEnc,
  lib: { WordArray: { create: (value?: Buffer | Uint8Array | string) => new CryptoWordArray(value) } },
  mode: { CBC: { name: "cbc" }, ECB: { name: "ecb" } },
  pad: { Pkcs7: { name: "pkcs7" }, NoPadding: { name: "nopadding" }, ZeroPadding: { name: "zeropadding" } },
  MD5: (value: unknown) => cryptoHash("md5", value),
  SHA1: (value: unknown) => cryptoHash("sha1", value),
  SHA256: (value: unknown) => cryptoHash("sha256", value),
  HmacMD5: (value: unknown, key: unknown) => cryptoHmac("md5", value, key),
  HmacSHA1: (value: unknown, key: unknown) => cryptoHmac("sha1", value, key),
  HmacSHA256: (value: unknown, key: unknown) => cryptoHmac("sha256", value, key),
  AES: {
    encrypt: (input: unknown, key: unknown, options?: Record<string, unknown>) => cryptoCipher("aes", true, input, key, options),
    decrypt: (input: unknown, key: unknown, options?: Record<string, unknown>) => cryptoCipher("aes", false, input, key, options),
  },
};

function aesX(mode: string, encrypt: boolean, input: string, inBase64: boolean, key: string, iv: string, outBase64: boolean): string {
  const modeName = String(mode).toLowerCase().includes("ecb") ? "ecb" : "cbc";
  const keyBuffer = Buffer.from(key, "utf8");
  const bits = keyBuffer.length >= 32 ? 256 : keyBuffer.length >= 24 ? 192 : 128;
  const normalizedKey = Buffer.alloc(bits / 8);
  keyBuffer.copy(normalizedKey, 0, 0, normalizedKey.length);
  const algorithm = `aes-${bits}-${modeName}`;
  const ivBuffer = modeName === "ecb" ? null : Buffer.from(iv || "", "utf8").subarray(0, 16);
  const fn = encrypt ? createCipheriv(algorithm, normalizedKey, ivBuffer) : createDecipheriv(algorithm, normalizedKey, ivBuffer);
  const source = Buffer.from(input, inBase64 ? "base64" : "utf8");
  const output = Buffer.concat([fn.update(source), fn.final()]);
  return output.toString(outBase64 ? "base64" : "utf8");
}

function joinUrl(base: string, value: string): string {
  try { return new URL(value, base).toString(); } catch { return value; }
}

function transformImports(code: string): string {
  let transformed = code.replace(/import\s*([^;\n]+?)\s*from\s*['"]([^'"]+)['"]\s*;?/g, (_match, clause: string, source: string) => {
    if (!source.startsWith("assets://js/lib/")) throw new Error(`CatOpen 不允许导入外部模块：${source}`);
    const value = clause.trim();
    if (value.startsWith("{")) {
      const entries = value.slice(1, -1).split(",").map((entry) => entry.trim()).filter(Boolean)
        .map((entry) => entry.replace(/\s+as\s+/i, ": ")).join(", ");
      return `const { ${entries} } = globalThis.__catLibs;`;
    }
    if (value.startsWith("* as ")) return `const ${value.slice(5).trim()} = globalThis.__catLibs;`;
    const comma = value.indexOf(",");
    if (comma >= 0) {
      const defaultName = value.slice(0, comma).trim();
      const named = value.slice(comma + 1).trim().replace(/\s+as\s+/gi, ": ");
      return `const ${defaultName} = globalThis.__catLibs; const ${named} = globalThis.__catLibs;`;
    }
    return `const ${value} = globalThis.__catLibs;`;
  });
  transformed = transformed.replace(/import\s*['"]([^'"]+)['"]\s*;?/g, (_match, source: string) => {
    if (!source.startsWith("assets://js/lib/")) throw new Error(`CatOpen 不允许导入外部模块：${source}`);
    return "";
  });
  return transformed;
}

function transformModule(code: string): string {
  let transformed = transformImports(code);
  transformed = transformed
    .replace(/\bexport\s+default\s+/g, "const __catDefault = ")
    .replace(/\bexport\s+(async\s+function|function|class|const|let|var)\s+/g, "$1 ")
    .replace(/\bexport\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}\s*;?/g, "const __catDefault = $1;")
    .replace(/\bexport\s*\{[^}]*\}\s*;?/g, "");
  return `${transformed}\n;globalThis.__catopenModule = typeof __jsEvalReturn === 'function' ? __jsEvalReturn() : (typeof __catDefault !== 'undefined' ? __catDefault : (typeof spider !== 'undefined' ? spider : (typeof rule !== 'undefined' ? rule : {})));`;
}

function hostConsole(): Console {
  const output = Object.create(console) as Console;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    output[level] = (...args: unknown[]) => process.send?.({ type: "log", level, args });
  }
  return output;
}

async function initialize(payload: InitPayload): Promise<string[]> {
  timeoutMs = Math.max(100, payload.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  storage.clear();
  const base64 = {
    encode(value: unknown): string { return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64"); },
    decode(value: string): string { return Buffer.from(String(value), "base64").toString("utf8"); },
  };
  const libraries = {
    BaseSpider,
    Spider: BaseSpider,
    req,
    batchFetch,
    local,
    load,
    pdfa,
    pdfh,
    pd,
    pq: load,
    CryptoJS,
    _: lodashLite,
    md5X,
    aesX,
    joinUrl,
    base64,
    getProxy: () => "",
  };
  const contextValue: Record<string, unknown> = {
    console: hostConsole(),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    log: (...args: unknown[]) => process.send?.({ type: "log", level: "log", args }),
    ...libraries,
    __catLibs: libraries,
  };
  sandbox = vm.createContext(contextValue, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(transformModule(payload.code), { filename: "catopen-provider.js" }).runInContext(sandbox, { timeout: timeoutMs });
  const exported = (sandbox as Record<string, unknown>).__catopenModule;
  const candidate = typeof exported === "function" ? await withTimeout(Promise.resolve(exported(payload.config)), "factory") : exported;
  if (!isRecord(candidate)) throw new Error("CatOpen 脚本未导出有效 Spider 对象");
  moduleValue = candidate;
  if (typeof candidate.init === "function") await withTimeout(Promise.resolve(candidate.init(payload.config)), "init");
  const known = ["home", "homeVod", "category", "detail", "detailContent", "search", "play", "action", "proxy", "destroy"];
  return known.filter((method) => typeof candidate[method] === "function");
}

async function withTimeout<T>(task: Promise<T>, method: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`CatOpen 方法超时：${method}`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invoke(method: string, args: unknown[]): Promise<unknown> {
  if (!moduleValue) throw new Error("CatOpen 尚未初始化");
  const fn = moduleValue[method];
  if (typeof fn !== "function") throw new Error(`CatOpen 未实现方法：${method}`);
  return withTimeout(Promise.resolve(fn.apply(moduleValue, args)), method);
}

let queue = Promise.resolve();
process.on("message", (raw: unknown) => {
  if (!isRecord(raw) || typeof raw.id !== "number" || typeof raw.method !== "string") return;
  const message = raw as unknown as WorkerRequest;
  queue = queue.then(async () => {
    try {
      const result = message.method === "__init"
        ? await initialize((message.args?.[0] ?? {}) as InitPayload)
        : await invoke(message.method, message.args ?? []);
      send({ id: message.id, result });
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      send({ id: message.id, error: { message: value.message, ...(value.stack ? { stack: value.stack } : {}) } });
    }
  });
});

process.on("disconnect", async () => {
  if (moduleValue && typeof moduleValue.destroy === "function") await Promise.resolve(moduleValue.destroy()).catch(() => undefined);
  process.exit(0);
});
