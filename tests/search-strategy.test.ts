import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveContinuationSearchBackend,
  resolveInitialSearchBackend,
  searchResultIdentity,
} from "../src/desktop/renderer/search-strategy.ts";

test("smart search starts from the active source and expands only on demand", () => {
  assert.equal(resolveInitialSearchBackend("smart", "catvod:nodejs_zhizhen"), "current-site");
  assert.equal(resolveInitialSearchBackend("smart", ""), "all-configs");
  assert.equal(resolveInitialSearchBackend("current", "catvod:nodejs_zhizhen"), "current-site");
  assert.equal(resolveContinuationSearchBackend(false), "current-site");
  assert.equal(resolveContinuationSearchBackend(true), "all-configs");
});

test("search result identity removes the current-source duplicate returned by expanded search", () => {
  const current = searchResultIdentity({
    vodId: "1",
    vodName: "庆余年 第一季",
    vodYear: "2019",
    siteName: "至臻",
    configName: "CatVod 服务",
  });
  const expanded = searchResultIdentity({
    vodId: "1",
    vodName: " 庆余年 第一季 ",
    vodYear: "2019",
    siteName: "至臻",
    configName: "catvod 服务",
  });
  const anotherConfig = searchResultIdentity({
    vodId: "1",
    vodName: "庆余年 第一季",
    vodYear: "2019",
    siteName: "至臻",
    configName: "家庭配置",
  });

  assert.equal(current, expanded);
  assert.notEqual(current, anotherConfig);
});
