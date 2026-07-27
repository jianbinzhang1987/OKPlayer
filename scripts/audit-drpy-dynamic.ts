import { DrpyOperationRuntime } from "../src/core/drpy-operation-runtime.ts";
import { DrpyRuleRuntime } from "../src/core/drpy-runtime.ts";

interface PublicRule {
  name: string;
  path: string;
}

interface DynamicOperationAudit {
  rule: string;
  operation: string;
  supportedApis: string;
  missingApis: string;
  network: boolean;
  offlineExecuted: boolean;
  offlineResult: string;
}

const REPOSITORY_COMMIT = "0bf8c0cf53da0134c4a2f20e5e8295353760e39d";
const RAW_BASE = `https://cnb.cool/zhyadc/drpy-node/-/git/raw/${REPOSITORY_COMMIT}/spider/js_dr2`;
const DYNAMIC_FIELDS = ["预处理", "推荐", "一级", "搜索", "二级", "lazy", "class_parse", "hostJs"] as const;

const RULES: PublicRule[] = [
  { name: "03影院[优]", path: "03%E5%BD%B1%E9%99%A2%5B%E4%BC%98%5D.js" },
  { name: "可可影视[优]", path: "%E5%8F%AF%E5%8F%AF%E5%BD%B1%E8%A7%86%5B%E4%BC%98%5D.js" },
  { name: "百忙无果[官]", path: "%E7%99%BE%E5%BF%99%E6%97%A0%E6%9E%9C%5B%E5%AE%98%5D.js" },
  { name: "相声随身听[听]", path: "%E7%9B%B8%E5%A3%B0%E9%9A%8F%E8%BA%AB%E5%90%AC%5B%E5%90%AC%5D.js" },
  { name: "豆瓣[官]", path: "%E8%B1%86%E7%93%A3%5B%E5%AE%98%5D.js" },
];

const SUPPORTED_APIS = [
  "request", "fetch", "post", "pdfh", "pdfa", "pd", "jsp",
  "setResult", "setResult2", "getItem", "setItem", "clearItem",
  "base64Encode", "base64Decode", "md5", "sha1", "sha256",
  "buildUrl", "urljoin", "stringify", "log", "print", "localStorage",
] as const;

const UNSUPPORTED_API_CANDIDATES = [
  "batchFetch", "req", "fetchCookie", "getProxyUrl", "getCryptoJS", "getLib",
  "rsaX", "aes", "des", "ocr", "gzip", "ungzip", "encodeStr", "decodeStr",
  "urlDeal", "tellIsJx", "dealJson", "getParse", "forceOrder", "pq", "cheerio",
  "js2Proxy", "proxyUrl", "getRule", "getHome", "getProxy",
] as const;

function usesIdentifier(script: string, identifier: string): boolean {
  return new RegExp(`(^|[^\\w$])${escapeRegExp(identifier)}(?=[^\\w$]|$)`, "m").test(script);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDynamic(value: unknown): value is string {
  return typeof value === "string" && /^js:/i.test(value.trim());
}

function usesNetwork(script: string): boolean {
  return ["request", "fetch", "post", "batchFetch", "req"].some((api) => usesIdentifier(script, api));
}

async function downloadRule(rule: PublicRule): Promise<string> {
  const response = await fetch(`${RAW_BASE}/${rule.path}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function tryOfflineExecution(
  ruleName: string,
  operation: string,
  script: string,
  rule: Record<string, unknown>,
): Promise<{ executed: boolean; result: string }> {
  if (usesNetwork(script)) return { executed: false, result: "network-dependent" };
  const runtime = new DrpyOperationRuntime({ timeoutMs: 3_000, requestTimeoutMs: 1_000 });
  try {
    const result = await runtime.execute(script, {
      rule,
      host: "https://example.com/",
      baseUrl: "https://example.com/play/1",
      input: "https://example.com/play/1",
      myUrl: "https://example.com/play/1",
      category: "movie",
      page: 1,
      filters: {},
      keyword: "测试",
      flag: "默认线路",
      headers: {},
    });
    const output = operation === "lazy" ? result.input : result.output ?? result.vod ?? result.vods;
    return {
      executed: true,
      result: summarize(output),
    };
  } catch (error) {
    return {
      executed: false,
      result: `${ruleName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function summarize(value: unknown): string {
  const text = JSON.stringify(value);
  if (!text) return "undefined";
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

const results: DynamicOperationAudit[] = [];
const loadErrors: Array<{ rule: string; error: string }> = [];

for (const ruleInfo of RULES) {
  try {
    const source = await downloadRule(ruleInfo);
    const runtime = new DrpyRuleRuntime({ timeoutMs: 5_000 });
    const rule = await runtime.load(source);
    for (const field of DYNAMIC_FIELDS) {
      const script = rule[field];
      if (!isDynamic(script)) continue;
      const supported = SUPPORTED_APIS.filter((api) => usesIdentifier(script, api));
      const missing = UNSUPPORTED_API_CANDIDATES.filter((api) => usesIdentifier(script, api));
      const offline = missing.length === 0
        ? await tryOfflineExecution(ruleInfo.name, field, script, rule)
        : { executed: false, result: "missing-host-api" };
      results.push({
        rule: ruleInfo.name,
        operation: field,
        supportedApis: supported.join(", ") || "none",
        missingApis: missing.join(", ") || "none",
        network: usesNetwork(script),
        offlineExecuted: offline.executed,
        offlineResult: offline.result,
      });
    }
  } catch (error) {
    loadErrors.push({
      rule: ruleInfo.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(`Drpy dynamic host API audit\ncommit: ${REPOSITORY_COMMIT}`);
console.table(results);
if (loadErrors.length > 0) console.table(loadErrors);

const missingOperations = results.filter((item) => item.missingApis !== "none");
const offlinePasses = results.filter((item) => item.offlineExecuted);
console.log(`dynamic operations: ${results.length}`);
console.log(`operations with known missing APIs: ${missingOperations.length}`);
console.log(`offline operations executed successfully: ${offlinePasses.length}`);

if (loadErrors.length > 0) process.exitCode = 1;
