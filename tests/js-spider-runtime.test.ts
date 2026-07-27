import assert from "node:assert/strict";
import test from "node:test";
import { JsSpiderRuntime } from "../src/core/js-spider-runtime.ts";

test("JS Spider运行时可以执行搜索接口", async () => {
  const script = `
    function searchContent(word, quick, page){
      return {list:[{vodName:word, siteKey:'js'}], pageCount:1, message:''};
    }
  `;

  const runtime = new JsSpiderRuntime({
    request: async () => "{}",
  });

  const result = await runtime.execute(script, "searchContent", ["测试", false, "1"]);
  assert.equal((result as any).list[0].vodName, "测试");
});

test("JS Spider宿主请求接口可调用", async () => {
  const runtime = new JsSpiderRuntime({
    request: async (url) => `response:${url}`,
  });

  const result = await runtime.execute(`
    async function load(){ return await request('https://example.com'); }
  `, "load");

  assert.equal(result, "response:https://example.com");
});
