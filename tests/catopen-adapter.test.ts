import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { CatOpenAdapter } from "../src/core/catopen-adapter.ts";

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

test("CatOpen adapter runs a provider in an isolated child process", async () => {
  let baseUrl = "";
  const fixture = await listen((request, response) => {
    if (request.url !== "/spider.js") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "text/javascript;charset=utf-8");
    response.end(`
      import { BaseSpider, local, load, md5X } from 'assets://js/lib/cat.js';
      const spider = {
        async init(cfg) {
          local.set('token', cfg.ext.token || 'missing');
          local.set('base-class', typeof BaseSpider);
        },
        async home() {
          return JSON.stringify({ class: [{ type_id: 'movie', type_name: '电影' }] });
        },
        async homeVod() {
          const $ = load('<div class="card"><a data-id="home-1" title="首页影片"></a></div>');
          return JSON.stringify({ list: [{
            vod_id: $('.card').find('a').attr('data-id'),
            vod_name: $('.card').find('a').attr('title'),
            vod_remarks: local.get('token') + ':' + typeof process,
          }] });
        },
        async category(tid, page) {
          return { list: [{ vod_id: tid + '-' + page, vod_name: '分类影片' }] };
        },
        async search(wd, quick, page) {
          return JSON.stringify({ list: [{ vod_id: 'search-' + page, vod_name: wd, vod_remarks: md5X(wd) }] });
        },
        async detail(id) {
          return { list: [{
            vod_id: id,
            vod_name: '详情影片',
            vod_play_from: '主线路',
            vod_play_url: '正片$https://media.example/video.m3u8',
          }] };
        },
        async play(flag, id) {
          return { flag, url: id, parse: 0, header: { Referer: 'https://provider.example/' } };
        },
        async proxy(params) {
          return [200, 'text/plain', params.value || ''];
        }
      };
      export function __jsEvalReturn() { return spider; }
    `);
  });
  baseUrl = fixture.baseUrl;

  const adapter = new CatOpenAdapter({
    key: "catopen",
    name: "CatOpen测试",
    type: 14,
    api: `${baseUrl}/spider.js`,
    ext: "{ token: 'configured' }",
  });

  try {
    const home = await adapter.home();
    assert.equal(home.list[0]?.vodId, "home-1");
    assert.equal(home.list[0]?.vodName, "首页影片");
    assert.equal(home.list[0]?.vodRemarks, "configured:undefined");

    const category = await adapter.category("movie", "2");
    assert.equal(category.list[0]?.vodId, "movie-2");

    const search = await adapter.search("测试", "3");
    assert.equal(search.list[0]?.vodName, "测试");
    assert.equal(search.list[0]?.vodRemarks, createHash("md5").update("测试").digest("hex"));

    const detail = await adapter.detail("detail-1");
    assert.equal(detail.vodName, "详情影片");
    assert.equal(detail.flags[0]?.episodes[0]?.url, "https://media.example/video.m3u8");

    const player = await adapter.player("主线路", "https://media.example/video.m3u8");
    assert.equal(player.parse, 0);
    assert.equal(player.header.Referer, "https://provider.example/");

    const proxy = await adapter.proxy({ value: "ok" });
    assert.deepEqual(proxy, [200, "text/plain", "ok"]);
  } finally {
    await adapter.destroy();
    await fixture.close();
  }
});
