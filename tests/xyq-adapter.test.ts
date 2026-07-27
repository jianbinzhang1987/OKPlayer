import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { XyqAdapter } from "../src/core/xyq-adapter.ts";

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("XYQ adapter supports commented rules HTML lists JSON search detail lines and episodes", async () => {
  let baseUrl = "";
  const requests: string[] = [];
  const fixture = await listen((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);

    if (url.pathname === "/rule.json") {
      response.setHeader("content-type", "application/json;charset=utf-8");
      response.end(`{
        // XYQ allows comments and trailing commas in many public rules.
        "规则名": "本地测试",
        "请求头参数": "PC_UA",
        "网页编码格式": "UTF-8",
        "是否开启获取首页数据": "1",
        "首页推荐链接": "${baseUrl}/home",
        "首页列表数组规则": "body&&.home-groups",
        "首页片单列表数组规则": ".card:lt(2)",
        "首页片单是否Jsoup写法": "1",
        "首页片单标题": "a&&title",
        "首页片单链接": "a&&href",
        "首页片单图片": "img&&data-src",
        "首页片单副标题": ".remark&&Text",
        "分类起始页码": "1",
        "分类链接": "${baseUrl}/category/{cateId}/{catePg}[firstPage=${baseUrl}/category/{cateId}]",
        "分类截取模式": "1",
        "分类列表数组规则": ".cards&&.card:has(a)",
        "分类片单是否Jsoup写法": "是",
        "分类片单标题": "a&&title",
        "分类片单链接": "a&&href",
        "分类片单图片": "img&&src",
        "分类片单副标题": ".remark&&Text",
        "搜索链接": "${baseUrl}/search?wd={wd}&pg={SearchPg}",
        "搜索截取模式": "0",
        "搜索列表数组规则": "data.list",
        "搜索片单标题": "name",
        "搜索片单链接": "url",
        "搜索片单图片": "pic",
        "搜索片单副标题": "note",
        "详情是否Jsoup写法": "1",
        "标题详情": "h1&&Text",
        "图片详情": ".poster&&src",
        "年代详情": ".year&&Text",
        "地区详情": ".area&&Text",
        "导演详情": ".director&&Text",
        "演员详情": ".actor&&Text",
        "简介详情": ".summary&&Text",
        "线路列表数组规则": ".tabs&&li",
        "线路标题": "Text",
        "播放列表数组规则": ".playlists&&ul",
        "选集列表数组规则": "li&&a:not(:has(img))",
        "选集标题链接是否Jsoup写法": "1",
        "选集标题": "Text",
        "选集链接": "href",
        "是否反转选集序列": "0",
      }`);
      return;
    }

    if (url.pathname === "/home") {
      response.end(`<!doctype html><body><section class="home-groups">
        <article class="card"><a title="首页一" href="/detail/1"><img data-src="/img/1.jpg"></a><span class="remark">更新至1</span></article>
        <article class="card"><a title="首页二" href="/detail/2"><img data-src="/img/2.jpg"></a><span class="remark">完结</span></article>
        <article class="card"><a title="首页三" href="/detail/3"><img data-src="/img/3.jpg"></a></article>
      </section></body>`);
      return;
    }

    if (url.pathname === "/category/movie" || url.pathname === "/category/movie/2") {
      const suffix = url.pathname.endsWith("/2") ? "二" : "一";
      response.end(`<div class="cards">
        <article class="card"><a title="分类${suffix}" href="/detail/${suffix}"><img src="/img/c${suffix}.jpg"></a><span class="remark">分类备注</span></article>
        <article class="card empty">无链接</article>
      </div>`);
      return;
    }

    if (url.pathname === "/search") {
      response.setHeader("content-type", "application/json;charset=utf-8");
      response.end(JSON.stringify({
        data: {
          list: [{ name: `搜索-${url.searchParams.get("wd")}`, url: "/detail/search", pic: "/img/search.jpg", note: `第${url.searchParams.get("pg")}页` }],
        },
      }));
      return;
    }

    if (url.pathname.startsWith("/detail/")) {
      response.end(`<main>
        <h1>测试影片</h1><img class="poster" src="/img/poster.jpg">
        <span class="year">2026</span><span class="area">中国</span>
        <span class="director">导演甲</span><span class="actor">演员甲</span>
        <p class="summary">详情简介</p>
        <ul class="tabs"><li>线路A</li><li>线路B</li></ul>
        <div class="playlists">
          <ul><li><a href="/play/a1">第1集</a></li><li><a href="/play/a2">第2集</a></li><li><a href="/ad"><img src="/ad.jpg"></a></li></ul>
          <ul><li><a href="/play/b1">正片</a></li></ul>
        </div>
      </main>`);
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });
  baseUrl = fixture.baseUrl;

  const adapter = new XyqAdapter({
    key: "xyq",
    name: "XYQ测试",
    type: 10,
    api: "csp_XYQHiker",
    ext: `${baseUrl}/rule.json`,
  });

  try {
    const home = await adapter.home();
    assert.equal(home.list.length, 2);
    assert.equal(home.list[0]?.vodName, "首页一");
    assert.equal(home.list[0]?.vodPic, `${baseUrl}/img/1.jpg`);

    const category1 = await adapter.category("movie", "1");
    assert.equal(category1.list[0]?.vodName, "分类一");
    const category2 = await adapter.category("movie", "2");
    assert.equal(category2.list[0]?.vodName, "分类二");
    assert.ok(requests.includes("GET /category/movie"));
    assert.ok(requests.includes("GET /category/movie/2"));

    const search = await adapter.search("测试 片", "3");
    assert.equal(search.list[0]?.vodName, "搜索-测试 片");
    assert.equal(search.list[0]?.vodRemarks, "第3页");
    assert.equal(search.list[0]?.vodId, `${baseUrl}/detail/search`);

    const detail = await adapter.detail(`${baseUrl}/detail/1`);
    assert.equal(detail.vodName, "测试影片");
    assert.equal(detail.vodYear, "2026");
    assert.equal(detail.vodArea, "中国");
    assert.equal(detail.flags.length, 2);
    assert.deepEqual(detail.flags[0]?.episodes.map((episode) => episode.name), ["第1集", "第2集"]);
    assert.equal(detail.flags[0]?.episodes[0]?.url, `${baseUrl}/play/a1`);
    assert.equal(detail.flags[1]?.flag, "线路B");

    const player = adapter.player("线路A", `${baseUrl}/play/a1`);
    assert.equal(player.parse, 1);
    assert.match(player.header["User-Agent"] ?? "", /Macintosh/);
  } finally {
    await adapter.destroy();
    await fixture.close();
  }
});

test("XYQ adapter supports inline direct-play rules", async () => {
  const adapter = new XyqAdapter({
    key: "xyq-direct",
    name: "XYQ直链",
    type: 3,
    api: "csp_XYQ",
    ext: `{
      "分类链接": "https://example.com/list/{cateId}/{catePg}",
      "分类截取模式": "0",
      "分类列表数组规则": "list",
      "分类片单标题": "name",
      "分类片单链接": "url",
      "链接是否直接播放": "1",
      "直接播放链接加后缀": "#isVideo=true#"
    }`,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ list: [{ name: "直链影片", url: "https://media.example/video.m3u8" }] }));
  try {
    const category = await adapter.category("movie", "1");
    assert.equal(category.list.length, 1);
    const detail = await adapter.detail(category.list[0]!.vodId);
    assert.equal(detail.flags[0]?.episodes[0]?.name, "正片");
    assert.equal(detail.flags[0]?.episodes[0]?.url, "https://media.example/video.m3u8");
  } finally {
    globalThis.fetch = originalFetch;
    await adapter.destroy();
  }
});
