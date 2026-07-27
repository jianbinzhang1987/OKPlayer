import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { DrpyAdapter } from "../src/core/drpy-adapter.ts";
import { DrpyOperationRuntime } from "../src/core/drpy-operation-runtime.ts";
import { DrpyRuleRuntime } from "../src/core/drpy-runtime.ts";

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => route(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function route(request: IncomingMessage, response: ServerResponse): void {
  const serverAddress = request.socket.address();
  if (typeof serverAddress === "string") throw new Error("无法获取测试服务端口");
  const origin = `http://127.0.0.1:${serverAddress.port}`;
  const url = new URL(request.url ?? "/", origin);

  if (url.pathname === "/base64-rule.js") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(Buffer.from(`var rule = { title: "Base64 Drpy", host: "${origin}", homeUrl: "/home", 推荐: "*", 一级: ".item;.name&&Text;img&&data-src;.remark&&Text;a&&href" };`).toString("base64"));
    return;
  }

  if (url.pathname === "/rule.js") {
    response.setHeader("content-type", "application/javascript; charset=utf-8");
    response.end(`
      localStorage.setItem("initialized", "true");
      var rule = {
        title: "Drpy MVP",
        host: "${origin}",
        homeUrl: "/home",
        url: "/category/fyclass/fypage",
        searchUrl: "/search/**/fypage",
        headers: { "User-Agent": "DrpyMVP/1.0" },
        推荐: "*",
        一级: ".item;.name&&Text;img&&data-src;.remark&&Text;a&&href",
        搜索: "*",
        二级: {
          title: "h1&&Text;.remark&&Text",
          img: "img.cover&&data-src",
          desc: ".actor&&Text;.director&&Text",
          content: ".content&&Text",
          tabs: ".tabs&&a",
          lists: ".playlist:eq(#id)&&a"
        }
      };
    `);
    return;
  }

  if (url.pathname === "/mixed-rule.js") {
    response.setHeader("content-type", "application/javascript; charset=utf-8");
    response.end(`
      var rule = {
        title: "Drpy 混合动态线路",
        host: "${origin}",
        headers: { "User-Agent": "MixedDrpy/1.0" },
        lazy: "js:input={parse:0,url:input}",
        二级: {
          title: "h1&&Text;.remark&&Text",
          img: "img.cover&&src",
          content: ".content&&Text",
          lists: "js:const data=eval(html.split('audio: ')[1].split('</script>')[0].trim());TABS=['安全音频'];LISTS=[data.map((item)=>item.name.strip()+'$https:'+item.url)];"
        }
      };
    `);
    return;
  }

  if (url.pathname === "/mixed-detail/1") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`
      <main>
        <h1>混合动态详情</h1><span class="remark">共2集</span>
        <img class="cover" src="/mixed-cover.jpg">
        <div class="content">安全数据字面量线路</div>
        <script>audio: [{name:"第一集",url:"//media.example.com/one.mp3"},{name:"第二集",url:"//media.example.com/two.mp3"}]</script>
      </main>
    `);
    return;
  }

  if (url.pathname === "/compat-rule.js") {
    response.setHeader("content-type", "application/javascript; charset=utf-8");
    response.end(`
      var rule = {
        title: "Drpy 真实语法兼容",
        host: "${origin}",
        homeUrl: "/compat-home",
        url: "/compat-category/fyclass/fypage?fyfilter",
        filter_url: "year={{fl.year or 'all'}}&sort={{fl.sort or 'hot'}}",
        searchUrl: "/compat-search#keywords=**&page=fypage;post",
        detailUrl: "/compat-detail/fyid",
        headers: { "User-Agent": "MOBILE_UA" },
        图片替换: "${origin}=>https://img.cdn.test",
        lazy: $js.toString(() => { input = { parse: 1, url: input }; }),
        推荐: ".featured;*;*;*;*",
        一级: ".item;.name&&Text;img&&src;.remark&&Text;&&data-id",
        搜索: "*",
        二级: {
          title: "h1&&Text;.remark&&Text",
          img: "img.cover&&src",
          tabs: ".tabs&&li",
          tab_text: "body&&Text",
          lists: ".playlist:eq(#id)&&li",
          list_text: "a&&Text",
          list_url: "a&&href"
        }
      };
    `);
    return;
  }

  if (url.pathname === "/dynamic-rule.js") {
    response.setHeader("content-type", "application/javascript; charset=utf-8");
    response.end(`
      var rule = {
        title: "Drpy 动态规则",
        host: "${origin}",
        homeUrl: "/dynamic-home",
        url: "/dynamic-category/fyclass/fypage",
        searchUrl: "/dynamic-search?wd=**&pg=fypage",
        headers: { "User-Agent": "DynamicDrpy/1.0" },
        预处理: $js.toString(() => {
          rule.headers["X-Dynamic"] = "ready";
          rule_fetch_params.headers = Object.assign({}, rule.headers);
        }),
        推荐: $js.toString(() => {
          const data = JSON.parse(request(input));
          setResult(data.items.map((item) => ({ title: item.name, url: item.id, pic_url: item.pic, desc: item.note })));
        }),
        一级: $js.toString(() => {
          const data = JSON.parse(request(input));
          setResult(data.items.map((item) => ({ title: item.name, url: item.id, pic_url: item.pic, desc: item.note })));
        }),
        搜索: $js.toString(() => {
          const data = JSON.parse(request(input));
          setResult(data.items.map((item) => ({ title: item.name + "-" + KEY, url: item.id, pic_url: item.pic, desc: item.note })));
        }),
        二级: $js.toString(() => {
          const html = request(input);
          const episodes = pdfa(html, ".episodes&&a");
          VOD = {
            vod_name: pdfh(html, "h1&&Text"),
            vod_pic: pd(html, "img.cover&&src"),
            vod_content: pdfh(html, ".content&&Text"),
            vod_play_from: "动态线路",
            vod_play_url: episodes.map((item) => pdfh(item, "a&&Text") + "$" + pd(item, "a&&href")).join("#")
          };
        }),
        lazy: $js.toString(() => {
          const data = JSON.parse(request(input));
          input = { parse: 0, url: data.url, header: { Referer: HOST } };
        })
      };
    `);
    return;
  }

  if (url.pathname.startsWith("/dynamic-")) {
    if (request.headers["x-dynamic"] !== "ready") {
      response.statusCode = 401;
      response.end("missing dynamic preprocess header");
      return;
    }
    if (url.pathname === "/dynamic-home") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [{ id: "/dynamic-detail/1", name: "动态首页", pic: `${origin}/dynamic-home.jpg`, note: "推荐" }] }));
      return;
    }
    if (url.pathname === "/dynamic-category/movie/2") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [{ id: "/dynamic-detail/1", name: "动态分类", pic: `${origin}/dynamic-category.jpg`, note: "第2页" }] }));
      return;
    }
    if (url.pathname === "/dynamic-search") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [{ id: "/dynamic-detail/1", name: "动态搜索", pic: `${origin}/dynamic-search.jpg`, note: url.searchParams.get("wd") ?? "" }] }));
      return;
    }
    if (url.pathname === "/dynamic-detail/1") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`
        <main>
          <h1>动态详情</h1>
          <img class="cover" src="/dynamic-detail.jpg">
          <div class="content">动态详情内容</div>
          <div class="episodes"><a href="/dynamic-play/1">第一集</a><a href="/dynamic-play/2">第二集</a></div>
        </main>
      `);
      return;
    }
    if (url.pathname === "/dynamic-play/1" || url.pathname === "/dynamic-play/2") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ url: `${origin}/media/${url.pathname.endsWith("/1") ? "one" : "two"}.m3u8` }));
      return;
    }
  }

  if (url.pathname === "/compat-home") {
    response.end(`<article class="featured" data-id="abc"><span class="name">兼容首页</span><img src="${origin}/home.jpg"><span class="remark">推荐</span></article>`);
    return;
  }

  if (url.pathname === "/compat-category/movie/2") {
    if (url.searchParams.get("year") !== "2024" || url.searchParams.get("sort") !== "hot") {
      response.statusCode = 400;
      response.end("bad filter");
      return;
    }
    response.end(`<article class="item" data-id="abc"><span class="name">兼容分类</span><img src="${origin}/category.jpg"><span class="remark">第2页</span></article>`);
    return;
  }

  if (url.pathname === "/compat-search") {
    void readRequestBody(request).then((body) => {
      if (request.method !== "POST" || body !== "keywords=%E6%B5%8B%E8%AF%95&page=1" || !String(request.headers["user-agent"] ?? "").includes("Android")) {
        response.statusCode = 400;
        response.end("bad post request");
        return;
      }
      response.end(`<article class="item" data-id="abc"><span class="name">兼容搜索</span><img src="${origin}/search.jpg"><span class="remark">命中</span></article>`);
    });
    return;
  }

  if (url.pathname === "/compat-detail/abc") {
    response.end(`
      <main>
        <h1>兼容详情</h1><span class="remark">完结</span>
        <img class="cover" src="${origin}/detail.jpg">
        <ul class="tabs"><li>超清</li><li>备用</li></ul>
        <ul class="playlist"><li><a href="/media/one.m3u8">第一集</a></li></ul>
        <ul class="playlist"><li><a href="/media/two.mp4">第二集</a></li></ul>
      </main>
    `);
    return;
  }

  if (url.pathname === "/home") {
    response.setHeader("set-cookie", "session=ready; Path=/; HttpOnly");
    response.end(listHtml("首页影片", "/detail/1", "/poster-home.jpg", "首页推荐"));
    return;
  }

  if (url.pathname === "/category/movie/2") {
    if (!String(request.headers.cookie ?? "").includes("session=ready")) {
      response.statusCode = 401;
      response.end("missing cookie");
      return;
    }
    response.end(listHtml("分类影片", "/detail/1", "/poster-category.jpg", "第 2 页"));
    return;
  }

  if (url.pathname.startsWith("/search/") && url.pathname.endsWith("/1")) {
    response.end(listHtml("搜索影片", "/detail/1", "/poster-search.jpg", "搜索命中"));
    return;
  }

  if (url.pathname === "/detail/1") {
    response.end(`
      <main>
        <h1>测试影片</h1>
        <div class="remark">全 2 集</div>
        <img class="cover" data-src="/poster-detail.jpg">
        <span class="actor">演员甲</span>
        <span class="director">导演乙</span>
        <div class="content">这是 Drpy MVP 详情。</div>
        <div class="tabs"><a>线路一</a><a>线路二</a></div>
        <div class="playlist"><a href="/video/ep1.m3u8">第 1 集</a></div>
        <div class="playlist"><a data-url="/video/ep2.mp4">第 2 集</a></div>
      </main>
    `);
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function listHtml(name: string, href: string, picture: string, remark: string): string {
  return `<article class="item"><a href="${href}"><span class="name">${name}</span><img data-src="${picture}"><span class="remark">${remark}</span></a></article>`;
}

test("Drpy adapter supports representative real-rule syntax", async () => {
  await withServer(async (origin) => {
    const adapter = new DrpyAdapter({
      key: "drpy-real-syntax",
      name: "Drpy 真实语法",
      type: 3,
      api: `${origin}/drpy2.min.js`,
      ext: `${origin}/compat-rule.js`,
      timeout: 3,
    });

    const home = await adapter.home();
    assert.equal(home.list[0]?.vodName, "兼容首页");
    assert.equal(home.list[0]?.vodPic, "https://img.cdn.test/home.jpg");

    const category = await adapter.category("movie", "2", { year: "2024" });
    assert.equal(category.list[0]?.vodName, "兼容分类");

    const search = await adapter.search("测试");
    assert.equal(search.list[0]?.vodId, "abc");
    assert.equal(search.list[0]?.vodName, "兼容搜索");
    assert.equal(search.list[0]?.vodPic, "https://img.cdn.test/search.jpg");

    const detail = await adapter.detail("abc");
    assert.equal(detail.vodName, "兼容详情");
    assert.equal(detail.vodPic, "https://img.cdn.test/detail.jpg");
    assert.deepEqual(detail.flags.map((flag) => flag.flag), ["超清", "备用"]);
    assert.equal(detail.flags[0]?.episodes[0]?.name, "第一集");
    assert.equal(detail.flags[0]?.episodes[0]?.url, `${origin}/media/one.m3u8`);
    assert.equal(detail.flags[1]?.episodes[0]?.url, `${origin}/media/two.mp4`);

    const player = await adapter.player("超清", detail.flags[0]!.episodes[0]!.url);
    assert.equal(player.parse, 1);
    assert.match(player.header["User-Agent"] ?? "", /Android/);

    await adapter.destroy();
  });
});

test("Drpy adapter supports object detail rules with safe dynamic TABS and LISTS", async () => {
  await withServer(async (origin) => {
    const adapter = new DrpyAdapter({
      key: "drpy-mixed-playlist",
      name: "Drpy 混合线路测试源",
      type: 3,
      api: `${origin}/drpy2.min.js`,
      ext: `${origin}/mixed-rule.js`,
      timeout: 5,
    });

    const detail = await adapter.detail(`${origin}/mixed-detail/1`);
    assert.equal(detail.vodName, "混合动态详情");
    assert.equal(detail.vodPic, `${origin}/mixed-cover.jpg`);
    assert.equal(detail.flags.length, 1);
    assert.equal(detail.flags[0]?.flag, "安全音频");
    assert.equal(detail.flags[0]?.episodes.length, 2);
    assert.equal(detail.flags[0]?.episodes[0]?.name, "第一集");
    assert.equal(detail.flags[0]?.episodes[0]?.url, "https://media.example.com/one.mp3");

    const player = await adapter.player(
      detail.flags[0]!.flag,
      detail.flags[0]!.episodes[0]!.url,
    );
    assert.equal(player.parse, 0);
    assert.equal(player.url, "https://media.example.com/one.mp3");

    await adapter.destroy();
  });
});

test("Drpy adapter runs dynamic preprocess list detail and lazy player flow", async () => {
  await withServer(async (origin) => {
    const ruleRuntime = new DrpyRuleRuntime({ timeoutMs: 5_000 });
    const operationRuntime = new DrpyOperationRuntime({
      allowPrivateNetwork: true,
      timeoutMs: 5_000,
      requestTimeoutMs: 3_000,
      storage: ruleRuntime.storage,
    });
    const adapter = new DrpyAdapter({
      key: "drpy-dynamic",
      name: "Drpy 动态规则测试源",
      type: 3,
      api: `${origin}/drpy2.min.js`,
      ext: `${origin}/dynamic-rule.js`,
      timeout: 5,
    }, ruleRuntime, operationRuntime);

    const home = await adapter.home();
    assert.equal(home.list[0]?.vodName, "动态首页");
    assert.equal(home.list[0]?.vodRemarks, "推荐");

    const category = await adapter.category("movie", "2");
    assert.equal(category.list[0]?.vodName, "动态分类");
    assert.equal(category.list[0]?.vodRemarks, "第2页");

    const search = await adapter.search("测试", "1");
    assert.equal(search.list[0]?.vodName, "动态搜索-测试");
    assert.equal(search.list[0]?.vodId, "/dynamic-detail/1");
    assert.equal(search.list[0]?.siteKey, "drpy-dynamic");

    const detail = await adapter.detail(search.list[0]!.vodId);
    assert.equal(detail.vodName, "动态详情");
    assert.equal(detail.vodPic, `${origin}/dynamic-detail.jpg`);
    assert.equal(detail.vodContent, "动态详情内容");
    assert.equal(detail.flags.length, 1);
    assert.equal(detail.flags[0]?.flag, "动态线路");
    assert.equal(detail.flags[0]?.episodes.length, 2);
    assert.equal(detail.flags[0]?.episodes[0]?.name, "第一集");
    assert.equal(detail.flags[0]?.episodes[0]?.url, `${origin}/dynamic-play/1`);

    const player = await adapter.player(
      detail.flags[0]!.flag,
      detail.flags[0]!.episodes[0]!.url,
    );
    assert.equal(player.parse, 0);
    assert.equal(player.url, `${origin}/media/one.m3u8`);
    assert.equal(player.header.Referer, `${origin}/`);
    assert.equal(player.header["X-Dynamic"], "ready");

    await adapter.destroy();
  });
});

test("Drpy adapter decodes Base64 encoded remote rule scripts", async () => {
  await withServer(async (origin) => {
    const adapter = new DrpyAdapter({
      key: "base64-drpy",
      name: "Base64 Drpy",
      type: 3,
      api: `${origin}/generic-engine.js`,
      ext: `${origin}/base64-rule.js`,
      timeout: 3,
    });
    const home = await adapter.home();
    assert.equal(home.list[0]?.vodName, "首页影片");
    await adapter.destroy();
  });
});

test("Drpy adapter runs declarative search detail player flow with cookies", async () => {
  await withServer(async (origin) => {
    const adapter = new DrpyAdapter({
      key: "drpy",
      name: "Drpy 测试源",
      type: 3,
      api: `${origin}/drpy2.min.js`,
      ext: `${origin}/rule.js`,
      timeout: 3,
    });

    const home = await adapter.home();
    assert.equal(home.list[0]?.vodName, "首页影片");

    const category = await adapter.category("movie", "2");
    assert.equal(category.list[0]?.vodRemarks, "第 2 页");

    const search = await adapter.search("测试", "1");
    assert.equal(search.list[0]?.vodName, "搜索影片");
    assert.equal(search.list[0]?.siteKey, "drpy");

    const detail = await adapter.detail(search.list[0]!.vodId);
    assert.equal(detail.vodName, "测试影片");
    assert.equal(detail.vodActor, "演员甲");
    assert.equal(detail.flags.length, 2);
    assert.equal(detail.flags[0]?.episodes[0]?.url, `${origin}/video/ep1.m3u8`);
    assert.equal(detail.flags[1]?.episodes[0]?.url, `${origin}/video/ep2.mp4`);

    const player = await adapter.player(detail.flags[0]!.flag, detail.flags[0]!.episodes[0]!.url);
    assert.equal(player.parse, 0);
    assert.equal(player.header["User-Agent"], "DrpyMVP/1.0");

    await adapter.destroy();
  });
});
