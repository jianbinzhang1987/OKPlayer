import { DrpyRuleRuntime } from "../src/core/drpy-runtime.ts";

interface PublicRule {
  name: string;
  path: string;
}

interface AuditResult {
  name: string;
  loaded: boolean;
  home?: string;
  category?: string;
  search?: string;
  detail?: string;
  lazy?: string;
  jsonRule?: boolean;
  postRule?: boolean;
  dollarJs?: boolean;
  error?: string;
}

const REPOSITORY_COMMIT = "0bf8c0cf53da0134c4a2f20e5e8295353760e39d";
const RAW_BASE = `https://cnb.cool/zhyadc/drpy-node/-/git/raw/${REPOSITORY_COMMIT}/spider/js_dr2`;

const RULES: PublicRule[] = [
  { name: "03影院[优]", path: "03%E5%BD%B1%E9%99%A2%5B%E4%BC%98%5D.js" },
  { name: "可可影视[优]", path: "%E5%8F%AF%E5%8F%AF%E5%BD%B1%E8%A7%86%5B%E4%BC%98%5D.js" },
  { name: "百忙无果[官]", path: "%E7%99%BE%E5%BF%99%E6%97%A0%E6%9E%9C%5B%E5%AE%98%5D.js" },
  { name: "相声随身听[听]", path: "%E7%9B%B8%E5%A3%B0%E9%9A%8F%E8%BA%AB%E5%90%AC%5B%E5%90%AC%5D.js" },
  { name: "豆瓣[官]", path: "%E8%B1%86%E7%93%A3%5B%E5%AE%98%5D.js" },
];

function ruleMode(value: unknown): string {
  if (typeof value === "object" && value !== null) return "declarative-object";
  if (typeof value !== "string" || !value.trim()) return "none";
  if (/^js:/i.test(value.trim())) return "dynamic-js";
  return "declarative";
}

async function downloadRule(ruleInfo: PublicRule): Promise<string> {
  const response = await fetch(`${RAW_BASE}/${ruleInfo.path}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function auditRule(ruleInfo: PublicRule): Promise<AuditResult> {
  const source = await downloadRule(ruleInfo);
  const runtime = new DrpyRuleRuntime({ timeoutMs: 5_000 });
  const rule = await runtime.load(source);
  return {
    name: ruleInfo.name,
    loaded: true,
    home: ruleMode(rule["推荐"]),
    category: ruleMode(rule["一级"]),
    search: ruleMode(rule["搜索"]),
    detail: ruleMode(rule["二级"]),
    lazy: ruleMode(rule.lazy),
    jsonRule: /(?:^|;)json:/m.test(source),
    postRule: /#[^\n'";]*;post/i.test(source),
    dollarJs: source.includes("$js.toString"),
  };
}

const results: AuditResult[] = [];
for (const ruleInfo of RULES) {
  try {
    results.push(await auditRule(ruleInfo));
  } catch (error) {
    results.push({
      name: ruleInfo.name,
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(`Drpy public rule syntax audit\ncommit: ${REPOSITORY_COMMIT}`);
console.table(results);

const failures = results.filter((item) => !item.loaded);
const dynamicOperations = results.reduce((count, item) => {
  return count + [item.home, item.category, item.search, item.detail, item.lazy]
    .filter((mode) => mode === "dynamic-js").length;
}, 0);
console.log(`loaded: ${results.length - failures.length}/${results.length}`);
console.log(`dynamic operations found: ${dynamicOperations}`);

if (failures.length > 0) {
  console.error(`${failures.length} rule(s) failed to download or initialize.`);
  process.exitCode = 1;
}
