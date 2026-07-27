import { DrpyAdapter } from "../src/core/drpy-adapter.ts";

interface LiveRuleCase {
  name: string;
  rulePath: string;
  category?: string;
  searchKeyword: string;
}

interface OperationStatus {
  ok: boolean;
  elapsedMs: number;
  detail: string;
}

interface LiveAuditResult {
  name: string;
  init: OperationStatus;
  home: OperationStatus;
  category: OperationStatus;
  search: OperationStatus;
  detail: OperationStatus;
  player: OperationStatus;
}

const REPOSITORY_COMMIT = "0bf8c0cf53da0134c4a2f20e5e8295353760e39d";
const RAW_BASE = `https://cnb.cool/zhyadc/drpy-node/-/git/raw/${REPOSITORY_COMMIT}/spider/js_dr2`;

const CASES: LiveRuleCase[] = [
  {
    name: "03影院[优]",
    rulePath: "03%E5%BD%B1%E9%99%A2%5B%E4%BC%98%5D.js",
    category: "1",
    searchKeyword: "三体",
  },
  {
    name: "可可影视[优]",
    rulePath: "%E5%8F%AF%E5%8F%AF%E5%BD%B1%E8%A7%86%5B%E4%BC%98%5D.js",
    category: "1",
    searchKeyword: "三体",
  },
  {
    name: "相声随身听[听]",
    rulePath: "%E7%9B%B8%E5%A3%B0%E9%9A%8F%E8%BA%AB%E5%90%AC%5B%E5%90%AC%5D.js",
    searchKeyword: "郭德纲",
  },
];

function notRun(detail = "not-run"): OperationStatus {
  return { ok: false, elapsedMs: 0, detail };
}

async function capture<T>(task: () => Promise<T>, summarize: (value: T) => string): Promise<{ status: OperationStatus; value?: T }> {
  const startedAt = Date.now();
  try {
    const value = await task();
    return {
      status: { ok: true, elapsedMs: Date.now() - startedAt, detail: summarize(value) },
      value,
    };
  } catch (error) {
    return {
      status: {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

const results: LiveAuditResult[] = [];

for (const testCase of CASES) {
  const adapter = new DrpyAdapter({
    key: `live-${results.length + 1}`,
    name: testCase.name,
    type: 3,
    api: "csp_drpy2",
    ext: `${RAW_BASE}/${testCase.rulePath}`,
    timeout: 12,
  });

  const result: LiveAuditResult = {
    name: testCase.name,
    init: notRun(),
    home: notRun(),
    category: notRun(testCase.category ? "not-run" : "no-category-sample"),
    search: notRun(),
    detail: notRun(),
    player: notRun(),
  };

  try {
    const initialized = await capture(() => adapter.init(), () => "initialized");
    result.init = initialized.status;
    if (!initialized.status.ok) {
      results.push(result);
      continue;
    }

    const home = await capture(() => adapter.home(), (value) => `items=${value.list.length}`);
    result.home = home.status;

    let firstVod = home.value?.list[0];
    if (testCase.category) {
      const category = await capture(
        () => adapter.category(testCase.category!, "1"),
        (value) => `items=${value.list.length}`,
      );
      result.category = category.status;
      firstVod ??= category.value?.list[0];
    }

    const search = await capture(
      () => adapter.search(testCase.searchKeyword, "1"),
      (value) => `items=${value.list.length}`,
    );
    result.search = search.status;
    firstVod ??= search.value?.list[0];

    if (!firstVod) {
      result.detail = notRun("no-vod-result");
      result.player = notRun("no-vod-result");
      results.push(result);
      continue;
    }

    const detail = await capture(
      () => adapter.detail(firstVod.vodId),
      (value) => `name=${value.vodName}; flags=${value.flags.length}; episodes=${value.flags.reduce((count, flag) => count + flag.episodes.length, 0)}`,
    );
    result.detail = detail.status;

    const episode = detail.value?.flags.flatMap((flag) => flag.episodes.map((item) => ({ flag: flag.flag, episode: item })))[0];
    if (!episode) {
      result.player = notRun("no-episode");
      results.push(result);
      continue;
    }

    const player = await capture(
      () => adapter.player(episode.flag, episode.episode.url),
      (value) => `parse=${value.parse}; url=${shorten(value.url)}`,
    );
    result.player = player.status;
    results.push(result);
  } finally {
    await adapter.destroy();
  }
}

const rows = results.flatMap((result) => [
  ["init", result.init],
  ["home", result.home],
  ["category", result.category],
  ["search", result.search],
  ["detail", result.detail],
  ["player", result.player],
].map(([operation, status]) => ({
  rule: result.name,
  operation,
  ok: (status as OperationStatus).ok,
  elapsedMs: (status as OperationStatus).elapsedMs,
  detail: (status as OperationStatus).detail,
})));

console.log(`Drpy live compatibility audit\ncommit: ${REPOSITORY_COMMIT}`);
console.table(rows);
const completed = rows.filter((row) => row.detail !== "not-run" && !row.detail.startsWith("no-") && row.detail !== "no-category-sample");
const passed = completed.filter((row) => row.ok).length;
console.log(`completed operations: ${completed.length}; passed: ${passed}; failed: ${completed.length - passed}`);
console.log("Live source failures are reported but do not fail the project build because upstream sites can change independently.");

function shorten(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
