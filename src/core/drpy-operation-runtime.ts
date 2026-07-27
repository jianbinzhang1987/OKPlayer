import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Worker } from "node:worker_threads";
import {
  DrpyCookieJar,
  DrpyStorage,
  extractAll,
  extractFirst,
  parseHtml,
} from "./drpy-runtime.ts";
import type { HeadersMap } from "./models.ts";
import { isNonPublicAddress, isUnsafeResolvedAddress } from "./network-address.ts";

const CONTROL_BYTES = 16;
const DEFAULT_RPC_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_REQUESTS = 12;
const DEFAULT_MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

const OPERATION_WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const vm = require('node:vm');
const crypto = require('node:crypto');

function hash(algorithm, value) {
  return crypto.createHash(algorithm).update(String(value)).digest('hex');
}

function clean(value, seen = new WeakSet()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'bigint') return String(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof RegExp) return { source: value.source, flags: value.flags };
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => clean(item, seen)).filter((item) => item !== undefined);
    seen.delete(value);
    return output;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = clean(item, seen);
    if (normalized !== undefined) output[key] = normalized;
  }
  seen.delete(value);
  return output;
}

function rpc(method, args) {
  const shared = new SharedArrayBuffer(16 + messageContext.rpcBufferBytes);
  const control = new Int32Array(shared, 0, 4);
  parentPort.postMessage({ type: 'rpc', method, args: clean(args), shared });
  const state = Atomics.wait(control, 0, 0, messageContext.requestTimeoutMs);
  if (state === 'timed-out') throw new Error('Drpy 宿主调用超时：' + method);
  const length = Atomics.load(control, 1);
  const failed = Atomics.load(control, 2) === 1;
  const bytes = new Uint8Array(shared, 16, Math.max(0, length));
  const text = new TextDecoder().decode(bytes);
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (failed) throw new Error(payload && payload.error ? payload.error : String(payload || '宿主调用失败'));
  return payload;
}

function buildUrl(base, query) {
  const url = new URL(String(base));
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function urljoin(base, value) {
  try { return new URL(String(value), String(base)).toString(); }
  catch { return String(value); }
}

function normalizeScript(source) {
  const code = String(source || '').replace(/^\s*js:\s*/i, '').trim();
  if (!code) return '';
  if (/^(?:async\s+)?function\b/.test(code) || /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code)) {
    return '(' + code + ')()';
  }
  return code;
}

let messageContext;
parentPort.on('message', (message) => {
  if (!message || message.type !== 'execute') return;
  messageContext = message;
  const storage = new Map(message.storage || []);
  const localStorage = {
    get length() { return storage.size; },
    key(index) { return Array.from(storage.keys())[index] ?? null; },
    getItem(key) { return storage.has(String(key)) ? storage.get(String(key)) : null; },
    setItem(key, value) { storage.set(String(key), String(value)); },
    removeItem(key) { storage.delete(String(key)); },
    clear() { storage.clear(); },
  };

  const context = message.context || {};
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    localStorage,
    rule: context.rule || {},
    HOST: context.host || '',
    input: context.input,
    MY_URL: context.myUrl || context.input || '',
    MY_CATE: context.category || '',
    MY_PAGE: Number(context.page || 1),
    MY_FL: context.filters || {},
    TYPE: context.type || '',
    KEY: context.keyword || '',
    WD: context.keyword || '',
    flag: context.flag || '',
    play_url: context.playUrl || '',
    fetch_params: { headers: { ...(context.headers || {}) } },
    rule_fetch_params: { headers: { ...(context.headers || {}) } },
    oheaders: { ...(context.headers || {}) },
    VODS: [],
    VOD: {},
    TABS: [],
    LISTS: [],
    html: context.html || '',
    output: undefined,
    PC_UA: context.pcUserAgent || 'Mozilla/5.0',
    MOBILE_UA: context.mobileUserAgent || 'Mozilla/5.0',
    UA: 'Mozilla/5.0',
    atob(value) { return Buffer.from(String(value), 'base64').toString('binary'); },
    btoa(value) { return Buffer.from(String(value), 'binary').toString('base64'); },
    base64Encode(value) { return Buffer.from(String(value), 'utf8').toString('base64'); },
    base64Decode(value) { return Buffer.from(String(value), 'base64').toString('utf8'); },
    md5(value) { return hash('md5', value); },
    sha1(value) { return hash('sha1', value); },
    sha256(value) { return hash('sha256', value); },
    stringify(value) { return JSON.stringify(value); },
    eval(value) { return rpc('parseLoose', { source: String(value || '') }); },
    urljoin,
    buildUrl,
    urlencode(value) { return encodeURIComponent(String(value ?? '')); },
    encodeUrl(value) { return encodeURIComponent(String(value ?? '')); },
    decodeUrl(value) { return decodeURIComponent(String(value ?? '')); },
    log() {},
    print() {},
    setResult(value) {
      sandbox.output = value;
      if (Array.isArray(value)) sandbox.VODS = value;
      else if (value && typeof value === 'object' && Array.isArray(value.list)) sandbox.VODS = value.list;
      return value;
    },
    setResult2(value) {
      sandbox.output = value;
      if (value && typeof value === 'object' && Array.isArray(value.list)) sandbox.VODS = value.list;
      return value;
    },
    getItem(key, fallback = '') {
      return localStorage.getItem(key) ?? fallback;
    },
    setItem(key, value) {
      localStorage.setItem(key, value);
      return value;
    },
    clearItem(key) {
      localStorage.removeItem(key);
    },
    request(url, options = {}) {
      const mergedOptions = {
        ...options,
        headers: { ...(sandbox.fetch_params.headers || {}), ...(options.headers || {}) },
      };
      return rpc('request', { url: urljoin(context.baseUrl || context.host || '', url), options: mergedOptions });
    },
    fetch(url, options = {}) {
      const mergedOptions = {
        ...options,
        headers: { ...(sandbox.fetch_params.headers || {}), ...(options.headers || {}) },
      };
      return rpc('request', { url: urljoin(context.baseUrl || context.host || '', url), options: mergedOptions });
    },
    post(url, options = {}) {
      const mergedOptions = {
        ...options,
        method: 'POST',
        headers: { ...(sandbox.fetch_params.headers || {}), ...(options.headers || {}) },
      };
      return rpc('request', { url: urljoin(context.baseUrl || context.host || '', url), options: mergedOptions });
    },
    pdfh(html, expression) {
      return rpc('pdfh', { html: String(html || ''), expression: String(expression || ''), baseUrl: context.baseUrl || context.host || '' });
    },
    pdfa(html, expression) {
      return rpc('pdfa', { html: String(html || ''), expression: String(expression || ''), baseUrl: context.baseUrl || context.host || '' });
    },
    pd(html, expression) {
      return rpc('pd', { html: String(html || ''), expression: String(expression || ''), baseUrl: context.baseUrl || context.host || '' });
    },
  };
  sandbox.jsp = { pdfh: sandbox.pdfh, pdfa: sandbox.pdfa, pd: sandbox.pd };
  sandbox.globalThis = sandbox;

  try {
    const vmContext = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script('Array.prototype.append = Array.prototype.push; String.prototype.strip = String.prototype.trim;', { filename: 'drpy-prelude.js' })
      .runInContext(vmContext, { timeout: message.timeoutMs });
    const code = normalizeScript(message.script);
    if (!code) throw new Error('动态规则为空');
    new vm.Script(code, { filename: 'drpy-operation.js' }).runInContext(vmContext, { timeout: message.timeoutMs });
    parentPort.postMessage({
      type: 'result',
      ok: true,
      result: clean({
        output: sandbox.output,
        vods: sandbox.VODS,
        vod: sandbox.VOD,
        tabs: sandbox.TABS,
        lists: sandbox.LISTS,
        input: sandbox.input,
        rule: sandbox.rule,
        fetchParams: sandbox.fetch_params,
        ruleFetchParams: sandbox.rule_fetch_params,
      }),
      storage: Array.from(storage.entries()),
    });
  } catch (error) {
    parentPort.postMessage({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

export interface DrpyOperationContext {
  rule: Record<string, unknown>;
  host: string;
  baseUrl?: string;
  input?: unknown;
  myUrl?: string;
  category?: string;
  page?: string | number;
  filters?: Record<string, string>;
  type?: string;
  keyword?: string;
  flag?: string;
  playUrl?: string;
  html?: string;
  headers?: HeadersMap;
  pcUserAgent?: string;
  mobileUserAgent?: string;
}

export interface DrpyOperationResult {
  output?: unknown;
  vods: unknown[];
  vod: Record<string, unknown>;
  tabs: unknown[];
  lists: unknown[];
  input?: unknown;
  rule: Record<string, unknown>;
  fetchParams: Record<string, unknown>;
  ruleFetchParams: Record<string, unknown>;
}

export interface DrpyOperationRuntimeOptions {
  timeoutMs?: number;
  requestTimeoutMs?: number;
  maxRequests?: number;
  maxResponseBytes?: number;
  rpcBufferBytes?: number;
  allowPrivateNetwork?: boolean;
  storage?: DrpyStorage;
  cookieJar?: DrpyCookieJar;
}

interface WorkerRpcMessage {
  type: "rpc";
  method: "request" | "pdfh" | "pdfa" | "pd" | "parseLoose";
  args: Record<string, unknown>;
  shared: SharedArrayBuffer;
}

interface WorkerResultMessage {
  type: "result";
  ok: boolean;
  result?: DrpyOperationResult;
  storage?: Array<[string, string]>;
  error?: string;
}

type WorkerMessage = WorkerRpcMessage | WorkerResultMessage;

export class DrpyOperationRuntime {
  readonly storage: DrpyStorage;
  readonly cookieJar: DrpyCookieJar;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRequests: number;
  private readonly maxResponseBytes: number;
  private readonly rpcBufferBytes: number;
  private readonly allowPrivateNetwork: boolean;

  constructor(options: DrpyOperationRuntimeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.rpcBufferBytes = options.rpcBufferBytes ?? DEFAULT_RPC_BUFFER_BYTES;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.storage = options.storage ?? new DrpyStorage();
    this.cookieJar = options.cookieJar ?? new DrpyCookieJar();
  }

  async execute(script: string, context: DrpyOperationContext, signal?: AbortSignal): Promise<DrpyOperationResult> {
    const worker = new Worker(OPERATION_WORKER_SOURCE, { eval: true });
    let requestCount = 0;

    return new Promise<DrpyOperationResult>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        void worker.terminate();
        callback();
      };
      const cancel = () => finish(() => reject(new Error("Drpy 动态规则已取消")));
      const timer = setTimeout(() => finish(() => reject(new Error(`Drpy 动态规则执行超时：${this.timeoutMs}ms`))), this.timeoutMs + 250);
      timer.unref();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }

      worker.once("error", (error) => finish(() => reject(error)));
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "rpc") {
          requestCount += message.method === "request" ? 1 : 0;
          void this.handleRpc(message, requestCount, signal);
          return;
        }
        if (!message.ok || !message.result) {
          finish(() => reject(new Error(`Drpy 动态规则执行失败：${message.error ?? "未知错误"}`)));
          return;
        }
        this.storage.replace(message.storage ?? []);
        finish(() => resolve(message.result!));
      });

      worker.postMessage({
        type: "execute",
        script,
        context,
        storage: this.storage.entries(),
        timeoutMs: this.timeoutMs,
        requestTimeoutMs: this.requestTimeoutMs,
        rpcBufferBytes: this.rpcBufferBytes,
      });
    });
  }

  private async handleRpc(message: WorkerRpcMessage, requestCount: number, signal?: AbortSignal): Promise<void> {
    try {
      let result: unknown;
      if (message.method === "request") {
        if (requestCount > this.maxRequests) throw new Error(`Drpy 单次操作最多允许 ${this.maxRequests} 次网络请求`);
        result = await this.handleRequest(message.args, signal);
      } else if (message.method === "parseLoose") {
        result = parseLooseData(String(message.args.source ?? ""));
      } else {
        result = this.handleParser(message.method, message.args);
      }
      writeSharedResult(message.shared, { ok: true, value: result });
    } catch (error) {
      writeSharedResult(message.shared, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleRequest(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const url = new URL(String(args.url ?? ""));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Drpy request 仅允许 HTTP/HTTPS");
    if (!this.allowPrivateNetwork) await assertPublicAddress(url.hostname);

    const rawOptions = isRecord(args.options) ? args.options : {};
    const headers = new Headers(stringRecord(rawOptions.headers));
    const cookie = this.cookieJar.getCookieHeader(url.toString());
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    const method = String(rawOptions.method ?? (rawOptions.body === undefined ? "GET" : "POST")).toUpperCase();
    const body = normalizeRequestBody(rawOptions.body, headers);
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: rawOptions.redirect === false ? "manual" : "follow",
      signal: requestSignal,
    });
    this.cookieJar.store(response.url || url.toString(), response.headers);
    const text = await readTextLimited(response.body, this.maxResponseBytes);
    if (!response.ok && !(rawOptions.redirect === false && response.status >= 300 && response.status < 400)) {
      throw new Error(`Drpy request 请求失败：HTTP ${response.status}`);
    }
    if (rawOptions.withHeaders === true) {
      const responseHeaders = Object.fromEntries(response.headers.entries());
      return JSON.stringify({
        ...responseHeaders,
        status: response.status,
        url: response.url || url.toString(),
        body: text,
        content: text,
      });
    }
    return text;
  }

  private handleParser(method: "pdfh" | "pdfa" | "pd", args: Record<string, unknown>): unknown {
    const html = String(args.html ?? "");
    const expression = String(args.expression ?? "");
    const baseUrl = String(args.baseUrl ?? "");
    const root = parseHtml(html);
    if (method === "pdfa") return extractAll(root, `${expression}&&OuterHtml`, baseUrl);
    return extractFirst(root, expression, baseUrl);
  }
}

function writeSharedResult(shared: SharedArrayBuffer, payload: { ok: true; value: unknown } | { ok: false; error: string }): void {
  const control = new Int32Array(shared, 0, 4);
  const output = new Uint8Array(shared, CONTROL_BYTES);
  const encoded = new TextEncoder().encode(JSON.stringify(payload.ok ? payload.value : { error: payload.error }));
  if (encoded.length > output.length) {
    const fallback = new TextEncoder().encode(JSON.stringify({ error: `宿主响应超过共享缓冲区上限：${output.length} bytes` }));
    output.set(fallback.subarray(0, output.length));
    Atomics.store(control, 1, Math.min(fallback.length, output.length));
    Atomics.store(control, 2, 1);
  } else {
    output.set(encoded);
    Atomics.store(control, 1, encoded.length);
    Atomics.store(control, 2, payload.ok ? 0 : 1);
  }
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

async function assertPublicAddress(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || (isIP(normalized) && isNonPublicAddress(normalized))) {
    throw new Error(`Drpy 动态规则禁止访问本地或内网地址：${hostname}`);
  }
  if (isIP(normalized)) return;
  const addresses = await lookup(normalized, { all: true });
  if (addresses.some((entry) => isUnsafeResolvedAddress(entry.address))) {
    throw new Error(`Drpy 动态规则域名解析到本地或内网地址：${hostname}`);
  }
}

function normalizeRequestBody(value: unknown, headers: Headers): BodyInit | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || value instanceof URLSearchParams) return value;
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
  }
  if (isRecord(value)) {
    const contentType = headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) return new URLSearchParams(stringRecord(value)).toString();
    if (!headers.has("content-type")) headers.set("content-type", "application/json;charset=UTF-8");
    return JSON.stringify(value);
  }
  return String(value);
}

async function readTextLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = maxBytes - total;
      const chunk = result.value.length > remaining ? result.value.subarray(0, remaining) : result.value;
      chunks.push(chunk);
      total += chunk.length;
      if (result.value.length > remaining) throw new Error(`Drpy 响应超过 ${maxBytes} bytes 限制`);
    }
    if (total >= maxBytes) {
      const extra = await reader.read();
      if (!extra.done) throw new Error(`Drpy 响应超过 ${maxBytes} bytes 限制`);
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

export function parseLooseData(source: string): unknown {
  return new LooseDataParser(source).parse();
}

class LooseDataParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      throw new Error(`宽松数据字面量包含不允许的尾部内容：${this.source.slice(this.index, this.index + 24)}`);
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"' || char === "'") return this.parseString();
    if (char === "-" || /\d/.test(char ?? "")) return this.parseNumber();
    const identifier = this.parseIdentifier();
    if (identifier === "true") return true;
    if (identifier === "false") return false;
    if (identifier === "null") return null;
    if (identifier === "undefined") return null;
    throw new Error(`宽松数据字面量不支持值：${identifier || char || "EOF"}`);
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    const output: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.peek("}")) {
      this.index += 1;
      return output;
    }
    while (this.index < this.source.length) {
      this.skipWhitespace();
      const key = this.source[this.index] === '"' || this.source[this.index] === "'"
        ? this.parseString()
        : this.parseObjectKey();
      this.skipWhitespace();
      this.expect(":");
      output[key] = this.parseValue();
      this.skipWhitespace();
      if (this.peek("}")) {
        this.index += 1;
        return output;
      }
      this.expect(",");
      this.skipWhitespace();
      if (this.peek("}")) {
        this.index += 1;
        return output;
      }
    }
    throw new Error("宽松对象字面量缺少结束符 }");
  }

  private parseArray(): unknown[] {
    this.expect("[");
    const output: unknown[] = [];
    this.skipWhitespace();
    if (this.peek("]")) {
      this.index += 1;
      return output;
    }
    while (this.index < this.source.length) {
      output.push(this.parseValue());
      this.skipWhitespace();
      if (this.peek("]")) {
        this.index += 1;
        return output;
      }
      this.expect(",");
      this.skipWhitespace();
      if (this.peek("]")) {
        this.index += 1;
        return output;
      }
    }
    throw new Error("宽松数组字面量缺少结束符 ]");
  }

  private parseString(): string {
    const quote = this.source[this.index];
    this.index += 1;
    let output = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index] ?? "";
      this.index += 1;
      if (char === quote) return output;
      if (char !== "\\") {
        output += char;
        continue;
      }
      const escaped = this.source[this.index] ?? "";
      this.index += 1;
      if (escaped === "n") output += "\n";
      else if (escaped === "r") output += "\r";
      else if (escaped === "t") output += "\t";
      else if (escaped === "b") output += "\b";
      else if (escaped === "f") output += "\f";
      else if (escaped === "v") output += "\v";
      else if (escaped === "0") output += "\0";
      else if (escaped === "u") output += this.parseHexEscape(4);
      else if (escaped === "x") output += this.parseHexEscape(2);
      else if (escaped === "\n") continue;
      else output += escaped;
    }
    throw new Error("宽松字符串字面量缺少结束引号");
  }

  private parseHexEscape(length: number): string {
    const value = this.source.slice(this.index, this.index + length);
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)) throw new Error("宽松字符串包含无效十六进制转义");
    this.index += length;
    return String.fromCodePoint(Number.parseInt(value, 16));
  }

  private parseNumber(): number {
    const match = this.source.slice(this.index).match(/^-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error("宽松数据包含无效数字");
    this.index += match[0].length;
    const value = /^-?0[xX]/.test(match[0])
      ? Number.parseInt(match[0].replace(/^(-?)0[xX]/, "$1"), 16)
      : Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("宽松数据包含非有限数字");
    return value;
  }

  private parseIdentifier(): string {
    this.skipWhitespace();
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/);
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }

  private parseObjectKey(): string {
    const start = this.index;
    while (this.index < this.source.length && this.source[this.index] !== ":") {
      const char = this.source[this.index] ?? "";
      if (char === "{" || char === "}" || char === "[" || char === "]" || char === ",") break;
      this.index += 1;
    }
    const key = this.source.slice(start, this.index).trim();
    if (!key || !/^[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(key)) {
      throw new Error(`宽松对象包含无效键名：${key || "空"}`);
    }
    return key;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private expect(value: string): void {
    if (!this.peek(value)) throw new Error(`宽松数据字面量期望 ${value}，位置 ${this.index}`);
    this.index += value.length;
  }

  private peek(value: string): boolean {
    return this.source.startsWith(value, this.index);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): HeadersMap {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
