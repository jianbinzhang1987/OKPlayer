import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { T4Adapter } from "../src/core/t4-adapter.ts";

async function withT4Server(run: (origin: string, requests: URL[]) => Promise<void>) {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    res.setHeader("content-type", "application/json");
    if (req.headers["x-token"] !== "demo") {
      res.statusCode = 401;
      res.end(JSON.stringify({ msg: "missing token" }));
      return;
    }
    if (url.searchParams.has("flag") && url.searchParams.has("play")) {
      res.end(JSON.stringify({
        url: ["高清", "https://media.example/demo.m3u8"],
        parse: 0,
        header: { Referer: "https://media.example/" },
      }));
      return;
    }
    if (url.searchParams.get("ac") === "detail") {
      res.end(JSON.stringify({
        list: [{
          vod_id: url.searchParams.get("ids"),
          vod_name: "T4 详情",
          vod_play_from: "线路A",
          vod_play_url: "第1集$episode-1",
        }],
      }));
      return;
    }
    if (url.searchParams.get("ac") === "videolist") {
      res.end(JSON.stringify({ list: [{ vod_id: "category-1", vod_name: "分类结果" }], pagecount: 2 }));
      return;
    }
    if (url.searchParams.has("wd")) {
      res.end(JSON.stringify({ list: [{ vod_id: "search-1", vod_name: "搜索结果" }], pagecount: 1 }));
      return;
    }
    res.end(JSON.stringify({ list: [{ vod_id: "home-1", vod_name: "首页结果" }], pagecount: 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  try {
    await run(`http://127.0.0.1:${address.port}/t4`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("FongMi type=4 T4 uses official params remote extend and POST fallback", async () => {
  const longExtend = JSON.stringify({ rules: "x".repeat(1_200) });
  const calls: Array<{ method: string; params: URLSearchParams }> = [];
  let extendFetches = 0;
  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${address.port}`);
    if (url.pathname === "/extend.json") {
      extendFetches += 1;
      response.end(longExtend);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const params = request.method === "POST"
        ? new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
        : url.searchParams;
      calls.push({ method: request.method ?? "GET", params });
      response.setHeader("content-type", "application/json");
      if (params.has("flag") && params.has("play")) {
        response.end(JSON.stringify({ url: "https://media.example/fongmi.m3u8", jx: 0 }));
      } else if (params.get("ac") === "detail" && params.has("ids")) {
        response.end(JSON.stringify({ list: [{ vod_id: params.get("ids"), vod_name: "FongMi 详情", vod_play_from: "主线", vod_play_url: "第一集$play-1" }] }));
      } else if (params.get("ac") === "detail" && params.has("t")) {
        response.end(JSON.stringify({ list: [{ vod_id: "cate-1", vod_name: "FongMi 分类" }], pagecount: 3 }));
      } else if (params.has("wd")) {
        response.end(JSON.stringify({ list: [{ vod_id: "search-1", vod_name: "FongMi 搜索" }] }));
      } else {
        response.end(JSON.stringify({ list: [{ vod_id: "home-1", vod_name: "FongMi 首页" }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const adapter = new T4Adapter({
      key: "fongmi-t4",
      name: "FongMi T4",
      type: 4,
      api: `${origin}/vod`,
      ext: `${origin}/extend.json`,
    });

    assert.equal((await adapter.home()).list[0]?.vodName, "FongMi 首页");
    assert.equal((await adapter.category("movie", "2", { area: "CN" })).pageCount, 3);
    assert.equal((await adapter.search("测试", "1", true)).list[0]?.vodName, "FongMi 搜索");
    const detail = await adapter.detail("vod-4");
    assert.equal(detail.flags[0]?.episodes[0]?.url, "play-1");
    assert.equal((await adapter.player("主线", "play-1")).url, "https://media.example/fongmi.m3u8");

    assert.equal(extendFetches, 1);
    assert.ok(calls.every((call) => call.method === "POST"));
    assert.ok(calls.every((call) => call.params.get("extend") === longExtend));

    const category = calls.find((call) => call.params.has("t"));
    assert.equal(category?.params.get("ac"), "detail");
    assert.deepEqual(
      JSON.parse(Buffer.from(category?.params.get("ext") ?? "", "base64url").toString("utf8")),
      { area: "CN" },
    );

    const search = calls.find((call) => call.params.has("wd"));
    assert.equal(search?.params.get("quick"), "true");
    assert.equal(search?.params.has("pg"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("T4 adapter supports home category search detail player headers and health", async () => {
  await withT4Server(async (origin, requests) => {
    const adapter = new T4Adapter({
      key: "t4-demo",
      name: "T4 Demo",
      type: 6,
      api: origin,
      ext: "rule-demo",
      header: { "X-Token": "demo" },
    });

    const home = await adapter.home();
    assert.equal(home.list[0]?.siteKey, "t4-demo");

    const category = await adapter.category("movie", "2", { area: "CN" });
    assert.equal(category.pageCount, 2);
    const categoryRequest = requests.find((item) => item.searchParams.get("ac") === "videolist");
    assert.ok(categoryRequest);
    const decoded = JSON.parse(Buffer.from(categoryRequest.searchParams.get("ext") ?? "", "base64").toString("utf8"));
    assert.deepEqual(decoded, { src: JSON.stringify({ area: "CN" }) });
    assert.equal(categoryRequest.searchParams.get("extend"), "rule-demo");

    const search = await adapter.search("测试", "3");
    assert.equal(search.list[0]?.vodName, "搜索结果");
    const searchRequest = requests.find((item) => item.searchParams.has("wd"));
    assert.equal(searchRequest?.searchParams.get("pg"), "3");

    const detail = await adapter.detail("vod-1");
    assert.equal(detail.flags[0]?.episodes[0]?.url, "episode-1");

    const player = await adapter.player("线路A", "episode-1");
    assert.equal(player.url, "https://media.example/demo.m3u8");
    assert.equal(player.header.Referer, "https://media.example/");
    assert.equal(player.header["X-Token"], "demo");

    const health = await adapter.healthCheck();
    assert.equal(health.ok, true);
    assert.match(health.message, /可用/);
  });
});
