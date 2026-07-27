import assert from "node:assert/strict";
import test from "node:test";
import { resolveSearchEmptyState } from "../src/desktop/renderer/search-empty-state.ts";

test("search empty state distinguishes current source first batch timeout and all-source empty results", () => {
  assert.deepEqual(resolveSearchEmptyState({
    keyword: "庆余年",
    scope: "current",
    expandedToAllSources: false,
    statuses: [{ state: "success" }],
  }), {
    title: "当前来源没有找到",
    description: "当前来源已正常返回，但没有匹配内容。可以切换智能搜索或更换关键词。",
  });

  assert.deepEqual(resolveSearchEmptyState({
    keyword: "庆余年",
    scope: "current",
    expandedToAllSources: false,
    statuses: [{ state: "error" }],
  }), {
    title: "当前来源暂时无法搜索",
    description: "当前来源搜索异常或超时，可以切换智能搜索、检查内容来源或稍后重试。",
  });

  assert.deepEqual(resolveSearchEmptyState({
    keyword: "庆余年",
    scope: "smart",
    expandedToAllSources: false,
    statuses: Array.from({ length: 6 }, () => ({ state: "success" as const })),
  }), {
    title: "首批来源没有找到",
    description: "可以继续搜索其余可用来源，或者更换关键词。",
  });

  assert.deepEqual(resolveSearchEmptyState({
    keyword: "庆余年",
    scope: "smart",
    expandedToAllSources: true,
    statuses: [{ state: "success" }, { state: "success" }, { state: "error" }],
  }), {
    title: "没有找到匹配内容",
    description: "已完成 3 个来源，其中 2 个正常返回，1 个异常或超时。可以更换关键词后重试。",
  });
});
