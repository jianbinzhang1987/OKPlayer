import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCompatibilityReports, formatCompatibilityBatch } from "../src/core/compatibility-batch-audit.ts";
import { auditVodConfig } from "../src/core/compatibility-audit.ts";
import type { VodConfig } from "../src/core/models.ts";

function config(sourceUrl: string, sites: VodConfig["sites"]): VodConfig {
  return { sourceUrl, sites, parses: [], flags: [], headers: [], proxy: [], rules: [], hosts: [], ads: [] };
}

test("batch audit ranks repeated Android-only APIs across configs", () => {
  const reports = [
    auditVodConfig(config("memory://one", [
      { key: "a", name: "豆瓣一", type: 3, api: "csp_NewDouBanGuard" },
      { key: "b", name: "玩偶一", type: 3, api: "csp_NewWoggGuard" },
      { key: "http", name: "接口", type: 1, api: "https://example.com/api" },
    ])),
    auditVodConfig(config("memory://two", [
      { key: "a2", name: "豆瓣二", type: 3, api: "csp_NewDouBanGuard" },
      { key: "a3", name: "豆瓣三", type: 3, api: "CSP_NEWDOUBANGUARD" },
      { key: "xyq", name: "规则", type: 10, api: "csp_XYQHiker", ext: "{}" },
    ])),
  ];
  const batch = aggregateCompatibilityReports(reports, [{ source: "broken.json", message: "配置不是有效 JSON" }]);

  assert.equal(batch.totalConfigs, 3);
  assert.equal(batch.succeededConfigs, 2);
  assert.equal(batch.failedConfigs, 1);
  assert.equal(batch.totalSites, 6);
  assert.equal(batch.supportedSites, 2);
  assert.equal(batch.androidApiRanking[0]?.api, "csp_NewDouBanGuard");
  assert.equal(batch.androidApiRanking[0]?.occurrences, 3);
  assert.equal(batch.androidApiRanking[0]?.configCount, 2);
  assert.deepEqual(batch.androidApiRanking[0]?.siteNames, ["豆瓣二", "豆瓣三", "豆瓣一"]);
  assert.equal(batch.androidApiRanking[1]?.api, "csp_NewWoggGuard");

  const output = formatCompatibilityBatch(batch, 10);
  assert.match(output, /csp_NewDouBanGuard：3 次 \/ 2 份配置/);
  assert.match(output, /配置加载失败/);
});
