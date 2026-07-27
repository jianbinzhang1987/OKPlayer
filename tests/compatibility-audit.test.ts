import assert from "node:assert/strict";
import test from "node:test";
import { auditVodConfig, formatCompatibilityAudit } from "../src/core/compatibility-audit.ts";
import type { VodConfig } from "../src/core/models.ts";

test("compatibility audit reports runtime distribution support rate and Android-only sites", () => {
  const config: VodConfig = {
    sourceUrl: "file:///demo.json",
    sites: [
      { key: "http", name: "HTTP", type: 1, api: "https://example.com/api" },
      { key: "alist", name: "Alist", type: 13, api: "csp_Alist", ext: "{\"server\":\"https://example.com\"}" },
      { key: "xyq", name: "XYQ", type: 10, api: "csp_XYQHiker", ext: "{}" },
      { key: "dex", name: "Android源", type: 3, api: "csp_NewDemoGuard" },
      { key: "unknown", name: "未知", type: 99, api: "" },
    ],
    parses: [],
    flags: [],
    headers: [],
    proxy: [],
    rules: [],
    hosts: [],
    ads: [],
  };

  const report = auditVodConfig(config);
  assert.equal(report.total, 5);
  assert.equal(report.supported, 3);
  assert.equal(report.unsupported, 2);
  assert.equal(report.supportRate, 60);
  assert.equal(report.runtimeDistribution.http, 1);
  assert.equal(report.runtimeDistribution.alist, 1);
  assert.equal(report.runtimeDistribution.xyq, 1);
  assert.equal(report.runtimeDistribution["android-dex"], 1);
  assert.equal(report.runtimeDistribution.unknown, 1);
  assert.equal(report.androidOnly[0]?.api, "csp_NewDemoGuard");

  const text = formatCompatibilityAudit(report);
  assert.match(text, /兼容率：60%/);
  assert.match(text, /Android源 \(csp_NewDemoGuard\)/);
  assert.match(text, /未知：暂不支持 type=99/);
});
