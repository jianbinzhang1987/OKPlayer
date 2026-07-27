import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { loadVodConfig } from "../src/core/config-loader.ts";
import { XbpqAdapter } from "../src/core/xbpq-adapter.ts";

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

test("XBPQ adapter supports object ext home category POST search detail and playback lists", async () => {
  let baseUrl = "";
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const fixture = await listen((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method ?? "GET", path: `${url.pathname}${url.search}`, body });

      if (url.pathname === "/config.json") {
        response.setHeader("content-type", "application/json;charset=utf-8");
        response.end(JSON.stringify({
          sites: [{
            key: "xbpq",
            name: "XBPQ测试",
            type: 3,
            api: "csp_XBPQ",
            ext: {
              站名: "本地测试",
              主页url: `${baseUrl}/home`,
              请求头: `电脑#Referer$${baseUrl}/`,
              数组: `<article class="card"&&</article>[不包含:data-ad]`,
              标题: `title="&&"`,
              链接: `href="&&"`,
              图片: `data-src="&&"`,
              副标题: `<span class="remark">&&</span>`,
              分类url: `${baseUrl}/category/{cateId}/{catePg};;a`,
              搜索url: `${baseUrl}/search;post;wd={wd}&pg={pg}`,
              搜索二次截取: `"list":[&&]`,
              搜索数组: `{&&}`,
              搜索标题: `"name":"&&"`,
              搜索图片: `"pic":"&&"`,
              搜索链接: `${baseUrl}/detail/+"id":"&&"`,
              搜索副标题: `"note":"&&"`,
              详情标题: `<h1>&&</h1>`,
              详情图片: `<img class="poster" src="&&"`,
              影片年代: `<span class="year">&&</span>`,
              影片地区: `<span class="area">&&</span>`,
              导演: `<span class="director">&&</span>`,
              主演: `<span class="actor">&&</span>`,
              简介: `<p class="summary">&&</p>`,
              线路数组: `<button class="line"&&</button>`,
              线路标题: `>&&<[替换:原线路A>>线路A#原线路B>>线路B]`,
              播放数组: `<ul class="playlist"&&</ul>`,
              播放列表: `<a&&</a>`,
              播放标题: `>&&<`,
              播放链接: `href="&&"`,
            },
          }],
        }));
        return;
      }

      if (url.pathname === "/home") {
        response.end(`<section>
          <article class="card"><a title="首页一" href="/detail/1"><img data-src="/img/1.jpg"></a><span class="remark">更新至1</span></article>
          <article class="card" data-ad="1"><a title="广告" href="/detail/ad"></a></article>
          <article class="card"><a title="首页二" href="/detail/2"><img data-src="/img/2.jpg"></a><span class="remark">完结</span></article>
        </section>`);
        return;
      }

      if (url.pathname === "/category/movie/2") {
        response.end(`<article class="card"><a title="分类二" href="/detail/c2"><img data-src="/img/c2.jpg"></a><span class="remark">分类结果</span></article>`);
        return;
      }

      if (url.pathname === "/search") {
        const params = new URLSearchParams(body);
        response.setHeader("content-type", "application/json;charset=utf-8");
        response.end(JSON.stringify({
          list: [{ id: "s1", name: `搜索-${params.get("wd")}`, pic: "/img/search.jpg", note: `第${params.get("pg")}页` }],
        }));
        return;
      }

      if (url.pathname.startsWith("/detail/")) {
        response.end(`<main>
          <h1>详情影片</h1><img class="poster" src="/img/poster.jpg">
          <span class="year">2026</span><span class="area">中国</span>
          <span class="director">导演甲</span><span class="actor">演员甲</span><p class="summary">详情简介</p>
          <button class="line">原线路A</button><button class="line">原线路B</button>
          <ul class="playlist"><li><a href="/play/a1">第1集</a></li><li><a href="/play/a2">第2集</a></li></ul>
          <ul class="playlist"><li><a href="/play/b1">正片</a></li></ul>
        </main>`);
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });
  });
  baseUrl = fixture.baseUrl;

  try {
    const config = await loadVodConfig(`${baseUrl}/config.json`);
    const site = config.sites[0];
    assert.ok(site?.ext?.startsWith("{"));
    assert.match(site?.ext ?? "", /"主页url"/);

    const adapter = new XbpqAdapter(site!);
    const home = await adapter.home();
    assert.equal(home.list.length, 2);
    assert.equal(home.list[0]?.vodName, "首页一");
    assert.equal(home.list[0]?.vodPic, `${baseUrl}/img/1.jpg`);

    const category = await adapter.category("movie", "2");
    assert.equal(category.list[0]?.vodName, "分类二");
    assert.equal(category.list[0]?.vodId, `${baseUrl}/detail/c2`);

    const search = await adapter.search("测试 片", "3");
    assert.equal(search.list[0]?.vodName, "搜索-测试 片");
    assert.equal(search.list[0]?.vodRemarks, "第3页");
    assert.equal(search.list[0]?.vodId, `${baseUrl}/detail/s1`);
    const searchRequest = requests.find((entry) => entry.path === "/search");
    assert.equal(searchRequest?.method, "POST");
    assert.equal(new URLSearchParams(searchRequest?.body).get("wd"), "测试 片");

    const detail = await adapter.detail(`${baseUrl}/detail/1`);
    assert.equal(detail.vodName, "详情影片");
    assert.equal(detail.vodYear, "2026");
    assert.equal(detail.vodArea, "中国");
    assert.equal(detail.flags.length, 2);
    assert.equal(detail.flags[0]?.flag, "线路A");
    assert.deepEqual(detail.flags[0]?.episodes.map((episode) => episode.name), ["第1集", "第2集"]);
    assert.equal(detail.flags[1]?.episodes[0]?.url, `${baseUrl}/play/b1`);

    const player = adapter.player("线路A", `${baseUrl}/play/a1`);
    assert.equal(player.parse, 1);
    assert.match(player.header["User-Agent"] ?? "", /Macintosh/);
    assert.equal(player.header.Referer, `${baseUrl}/`);
    await adapter.destroy();
  } finally {
    await fixture.close();
  }
});
