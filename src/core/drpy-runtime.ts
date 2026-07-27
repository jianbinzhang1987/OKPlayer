import { Worker } from "node:worker_threads";

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");
const crypto = require("node:crypto");

function hash(algorithm, value) {
  return crypto.createHash(algorithm).update(String(value)).digest("hex");
}

function clean(value, seen = new WeakSet()) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof RegExp) return { source: value.source, flags: value.flags };
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => clean(item, seen)).filter((item) => item !== undefined);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = clean(item, seen);
    if (normalized !== undefined) output[key] = normalized;
  }
  return output;
}

parentPort.on("message", (message) => {
  const storage = new Map(message.storage || []);
  const localStorage = {
    get length() { return storage.size; },
    key(index) { return Array.from(storage.keys())[index] ?? null; },
    getItem(key) { return storage.has(String(key)) ? storage.get(String(key)) : null; },
    setItem(key, value) { storage.set(String(key), String(value)); },
    removeItem(key) { storage.delete(String(key)); },
    clear() { storage.clear(); },
  };
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    module: { exports: {} },
    exports: {},
    localStorage,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob(value) { return Buffer.from(String(value), "base64").toString("binary"); },
    btoa(value) { return Buffer.from(String(value), "binary").toString("base64"); },
    base64Encode(value) { return Buffer.from(String(value), "utf8").toString("base64"); },
    base64Decode(value) { return Buffer.from(String(value), "base64").toString("utf8"); },
    md5(value) { return hash("md5", value); },
    sha1(value) { return hash("sha1", value); },
    sha256(value) { return hash("sha256", value); },
    PC_UA: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
    MOBILE_UA: "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36",
    UA: "Mozilla/5.0",
    $js: {
      toString(value) {
        if (typeof value === "function") return "js:" + value.toString();
        return String(value ?? "");
      },
    },
  };
  sandbox.globalThis = sandbox;
  try {
    const source = String(message.script || "").replace(/^\s*export\s+default\s+/m, "const rule = ");
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const wrapped = "(() => {\n" + source + "\n; return typeof rule !== 'undefined' ? rule : (module.exports && Object.keys(module.exports).length ? module.exports : exports.default);\n})()";
    const rule = new vm.Script(wrapped, { filename: "drpy-rule.js" }).runInContext(context, { timeout: message.timeoutMs });
    if (!rule || typeof rule !== "object") throw new Error("规则脚本未导出 rule 对象");
    parentPort.postMessage({ ok: true, rule: clean(rule), storage: Array.from(storage.entries()) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

export class DrpyStorage {
  private readonly values = new Map<string, string>();

  constructor(initial: Iterable<readonly [string, string]> = []) {
    for (const [key, value] of initial) this.values.set(key, value);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }

  entries(): Array<[string, string]> {
    return [...this.values.entries()];
  }

  replace(entries: Iterable<readonly [string, string]>): void {
    this.values.clear();
    for (const [key, value] of entries) this.values.set(key, value);
  }
}

interface WorkerSuccess {
  ok: true;
  rule: Record<string, unknown>;
  storage: Array<[string, string]>;
}

interface WorkerFailure {
  ok: false;
  error: string;
}

type WorkerMessage = WorkerSuccess | WorkerFailure;

export class DrpyRuleRuntime {
  private readonly timeoutMs: number;
  readonly storage: DrpyStorage;

  constructor(options: { timeoutMs?: number; storage?: DrpyStorage } = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.storage = options.storage ?? new DrpyStorage();
  }

  async load(script: string): Promise<Record<string, unknown>> {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        callback();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`Drpy 规则初始化超时：${this.timeoutMs}ms`)));
      }, this.timeoutMs + 100);
      timer.unref();
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("message", (message: WorkerMessage) => {
        if (!message.ok) {
          finish(() => reject(new Error(`Drpy 规则执行失败：${message.error}`)));
          return;
        }
        this.storage.replace(message.storage);
        finish(() => resolve(message.rule));
      });
      worker.postMessage({ script, storage: this.storage.entries(), timeoutMs: this.timeoutMs });
    });
  }
}

export class DrpyCookieJar {
  private readonly cookies = new Map<string, Map<string, string>>();

  getCookieHeader(url: string): string {
    const host = new URL(url).hostname;
    const values = this.cookies.get(host);
    if (!values) return "";
    return [...values.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  store(url: string, headers: Headers): void {
    const host = new URL(url).hostname;
    const responseHeaders = headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = responseHeaders.getSetCookie?.() ?? splitSetCookieHeader(headers.get("set-cookie") ?? "");
    if (setCookies.length === 0) return;
    const values = this.cookies.get(host) ?? new Map<string, string>();
    for (const cookie of setCookies) {
      const pair = cookie.split(";", 1)[0]?.trim() ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (/max-age=0/i.test(cookie) || /expires=Thu, 01 Jan 1970/i.test(cookie)) values.delete(name);
      else values.set(name, value);
    }
    this.cookies.set(host, values);
  }
}

function splitSetCookieHeader(value: string): string[] {
  if (!value) return [];
  const output: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < value.length; index += 1) {
    const lower = value.slice(index, index + 8).toLowerCase();
    if (lower === "expires=") inExpires = true;
    const char = value[index];
    if (inExpires && char === ";") inExpires = false;
    if (!inExpires && char === ",") {
      output.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  output.push(value.slice(start).trim());
  return output.filter(Boolean);
}

export interface HtmlElementNode {
  type: "root" | "element";
  tagName: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlElementNode | undefined;
}

export interface HtmlTextNode {
  type: "text";
  text: string;
  parent: HtmlElementNode;
}

export type HtmlNode = HtmlElementNode | HtmlTextNode;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export function parseHtml(html: string): HtmlElementNode {
  const root: HtmlElementNode = { type: "root", tagName: "#root", attributes: {}, children: [], parent: undefined };
  const stack: HtmlElementNode[] = [root];
  const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    const parent = stack.at(-1) ?? root;
    if (!token.startsWith("<")) {
      parent.children.push({ type: "text", text: decodeHtml(token), parent });
      continue;
    }
    if (token.startsWith("</")) {
      const tagName = token.slice(2, -1).trim().toLowerCase();
      while (stack.length > 1) {
        const node = stack.pop();
        if (node?.tagName === tagName) break;
      }
      continue;
    }
    const tagMatch = token.match(/^<\s*([A-Za-z][\w:-]*)/);
    if (!tagMatch) continue;
    const tagName = tagMatch[1]?.toLowerCase() ?? "div";
    const attributes = parseAttributes(token.slice(tagMatch[0].length, token.endsWith("/>") ? -2 : -1));
    const element: HtmlElementNode = { type: "element", tagName, attributes, children: [], parent };
    parent.children.push(element);
    if (!token.endsWith("/>") && !VOID_TAGS.has(tagName)) stack.push(element);
  }
  return root;
}

function parseAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of input.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function nodeText(node: HtmlNode): string {
  if (node.type === "text") return node.text;
  return node.children.map(nodeText).join(" ").replace(/\s+/g, " ").trim();
}

function innerHtml(node: HtmlElementNode): string {
  return node.children.map(serializeNode).join("");
}

function serializeNode(node: HtmlNode): string {
  if (node.type === "text") return node.text;
  const attributes = Object.entries(node.attributes).map(([key, value]) => value ? ` ${key}="${value}"` : ` ${key}`).join("");
  if (VOID_TAGS.has(node.tagName)) return `<${node.tagName}${attributes}>`;
  return `<${node.tagName}${attributes}>${innerHtml(node)}</${node.tagName}>`;
}

interface SelectorPart {
  combinator: "descendant" | "child";
  selector: string;
}

function splitSelectorGroups(selector: string): string[] {
  const output: string[] = [];
  let start = 0;
  let square = 0;
  let round = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "," && square === 0 && round === 0) {
      output.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  output.push(selector.slice(start).trim());
  return output.filter(Boolean);
}

function parseSelectorChain(selector: string): SelectorPart[] {
  const parts: SelectorPart[] = [];
  let buffer = "";
  let square = 0;
  let round = 0;
  let combinator: SelectorPart["combinator"] = "descendant";
  const flush = () => {
    const value = buffer.trim();
    if (value) parts.push({ combinator, selector: value });
    buffer = "";
  };
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index] ?? "";
    if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    if (square === 0 && round === 0 && char === ">") {
      flush();
      combinator = "child";
      continue;
    }
    if (square === 0 && round === 0 && /\s/.test(char)) {
      if (buffer.trim()) {
        flush();
        combinator = "descendant";
      }
      continue;
    }
    buffer += char;
  }
  flush();
  return parts;
}

function childElements(node: HtmlElementNode): HtmlElementNode[] {
  return node.children.filter((child): child is HtmlElementNode => child.type !== "text");
}

function descendants(node: HtmlElementNode): HtmlElementNode[] {
  const output: HtmlElementNode[] = [];
  for (const child of childElements(node)) {
    output.push(child, ...descendants(child));
  }
  return output;
}

function matchesSimple(node: HtmlElementNode, rawSelector: string): boolean {
  let selector = rawSelector;
  const contains = selector.match(/:contains\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/i);
  if (contains) {
    const value = contains[1] ?? contains[2] ?? contains[3] ?? "";
    if (!nodeText(node).includes(value)) return false;
    selector = selector.replace(contains[0], "");
  }
  const notHas = selector.match(/:not\(\s*:has\(([^()]*)\)\s*\)/i);
  if (notHas) {
    if (selectAll(node, notHas[1] ?? "").length > 0) return false;
    selector = selector.replace(notHas[0], "");
  }
  const has = selector.match(/:has\(([^()]*)\)/i);
  if (has) {
    if (selectAll(node, has[1] ?? "").length === 0) return false;
    selector = selector.replace(has[0], "");
  }
  const not = selector.match(/:not\(([^()]*)\)/i);
  if (not) {
    if (matchesSimple(node, not[1] ?? "")) return false;
    selector = selector.replace(not[0], "");
  }
  selector = selector.replace(/:(?:eq\(-?\d+\)|lt\(-?\d+\)|gt\(-?\d+\)|first|last)/gi, "");
  const attributeSelectors = [...selector.matchAll(/\[([^\]=~^$*|\s]+)\s*(?:([~^$*|]?=)\s*["']?([^\]"']*)["']?)?\]/g)];
  selector = selector.replace(/\[[^\]]*\]/g, "");
  const tag = selector.match(/^([A-Za-z][\w:-]*|\*)/)?.[1]?.toLowerCase();
  if (tag && tag !== "*" && node.tagName !== tag) return false;
  const id = selector.match(/#([\w-]+)/)?.[1];
  if (id && node.attributes.id !== id) return false;
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1] ?? "");
  const nodeClasses = new Set((node.attributes.class ?? "").split(/\s+/).filter(Boolean));
  if (classes.some((value) => !nodeClasses.has(value))) return false;
  for (const match of attributeSelectors) {
    const name = match[1]?.toLowerCase() ?? "";
    const operator = match[2];
    const expected = match[3] ?? "";
    const actual = node.attributes[name];
    if (actual === undefined) return false;
    if (!operator) continue;
    if (operator === "=" && actual !== expected) return false;
    if (operator === "~=" && !actual.split(/\s+/).includes(expected)) return false;
    if (operator === "^=" && !actual.startsWith(expected)) return false;
    if (operator === "$=" && !actual.endsWith(expected)) return false;
    if (operator === "*=" && !actual.includes(expected)) return false;
    if (operator === "|=" && actual !== expected && !actual.startsWith(`${expected}-`)) return false;
  }
  return true;
}

function applyPosition(nodes: HtmlElementNode[], selector: string): HtmlElementNode[] {
  const eq = selector.match(/:eq\((-?\d+)\)/i);
  if (eq) {
    const raw = Number(eq[1]);
    const index = raw < 0 ? nodes.length + raw : raw;
    return nodes[index] ? [nodes[index]] : [];
  }
  const lt = selector.match(/:lt\((-?\d+)\)/i);
  if (lt) {
    const raw = Number(lt[1]);
    const end = raw < 0 ? nodes.length + raw : raw;
    return nodes.slice(0, Math.max(0, end));
  }
  const gt = selector.match(/:gt\((-?\d+)\)/i);
  if (gt) {
    const raw = Number(gt[1]);
    const start = raw < 0 ? nodes.length + raw + 1 : raw + 1;
    return nodes.slice(Math.max(0, start));
  }
  if (/:first/i.test(selector)) return nodes[0] ? [nodes[0]] : [];
  if (/:last/i.test(selector)) return nodes.at(-1) ? [nodes.at(-1)!] : [];
  return nodes;
}

export function selectAll(root: HtmlElementNode, selector: string): HtmlElementNode[] {
  const combined: HtmlElementNode[] = [];
  const normalizedSelector = selector.replace(/&&/g, " ").replace(/\s+/g, " ").trim();
  for (const group of splitSelectorGroups(normalizedSelector)) {
    let current: HtmlElementNode[] = [root];
    for (const part of parseSelectorChain(group)) {
      const candidates = current.flatMap((node) => part.combinator === "child" ? childElements(node) : descendants(node));
      const matched = applyPosition(candidates.filter((node) => matchesSimple(node, part.selector)), part.selector);
      current = [...new Set(matched)];
    }
    combined.push(...current);
  }
  return [...new Set(combined)];
}

interface ExpressionParts {
  selector: string;
  directive: string;
}

function parseExpression(expression: string): ExpressionParts {
  const parts = expression.split("&&").map((item) => item.trim());
  if (parts.length === 1) return { selector: parts[0] ?? "", directive: "Text" };
  const tail = parts.at(-1) ?? "";
  if (isExtractionDirective(tail)) {
    return {
      selector: parts.slice(0, -1).join(" ").trim(),
      directive: tail || "Text",
    };
  }
  return {
    selector: parts.join(" ").trim(),
    directive: "Text",
  };
}

function isExtractionDirective(value: string): boolean {
  return /^(?:Text|Html|OuterHtml|href|src|data-[\w-]+|title|alt|value|style|content|class|id|name|poster)$/i.test(value);
}

function extractNode(node: HtmlElementNode, directive: string, baseUrl?: string): string {
  if (/^text$/i.test(directive)) return nodeText(node);
  if (/^html$/i.test(directive)) return innerHtml(node).trim();
  if (/^outerhtml$/i.test(directive)) return serializeNode(node).trim();
  const attribute = directive.toLowerCase();
  const value = node.attributes[attribute] ?? "";
  if (!value || !baseUrl || !["href", "src", "data-src", "data-original", "data-url"].includes(attribute)) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

export function extractAll(root: HtmlElementNode, expression: string, baseUrl?: string): string[] {
  const { selector, directive } = parseExpression(expression);
  const nodes = selector ? selectAll(root, selector) : [root];
  return nodes.map((node) => extractNode(node, directive, baseUrl)).filter(Boolean);
}

export function extractFirst(root: HtmlElementNode, expression: string, baseUrl?: string): string {
  return extractAll(root, expression, baseUrl)[0] ?? "";
}

export interface DrpyListItem {
  id: string;
  name: string;
  pic: string;
  remarks: string;
}

export function parseDrpyList(payload: string, listRule: string, baseUrl: string): DrpyListItem[] {
  const [itemSelector = "", titleExpression = "Text", picExpression = "", remarksExpression = "", urlExpression = "href"] = listRule.split(";").map((item) => item.trim());
  if (!itemSelector) return [];

  if (itemSelector.startsWith("json:")) {
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch (error) {
      throw new Error(`Drpy JSON 规则收到无效 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    const items = jsonPath(value, itemSelector.slice(5));
    if (!Array.isArray(items)) return [];
    return items.map((item) => ({
      id: jsonField(item, urlExpression),
      name: jsonField(item, titleExpression),
      pic: normalizeExtractedUrl(jsonField(item, picExpression), baseUrl),
      remarks: jsonField(item, remarksExpression),
    })).filter((item) => item.id && item.name);
  }

  const root = parseHtml(payload);
  return selectAll(root, itemSelector).map((item) => ({
    id: extractFirst(item, urlExpression, baseUrl),
    name: extractFirst(item, titleExpression, baseUrl),
    pic: picExpression ? extractFirst(item, picExpression, baseUrl) : "",
    remarks: remarksExpression ? extractFirst(item, remarksExpression, baseUrl) : "",
  })).filter((item) => item.id && item.name);
}

function jsonPath(value: unknown, path: string): unknown {
  if (!path.trim()) return value;
  let current = value;
  for (const segment of path.split(".").map((item) => item.trim()).filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function jsonField(value: unknown, expression: string): string {
  if (!expression || expression === "*") return "";
  for (const candidate of expression.split("||").map((item) => item.trim()).filter(Boolean)) {
    const result = jsonPath(value, candidate);
    if (result === null || result === undefined) continue;
    if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
      const text = String(result).trim();
      if (text) return text;
    }
  }
  return "";
}

function normalizeExtractedUrl(value: string, baseUrl: string): string {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}
