import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { SourceAdapterFactory } from "../src/core/source-adapter-factory.ts";

test("type=3 remote ES module providers use the isolated module runtime", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/provider.js") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "text/javascript;charset=utf-8");
    response.end(`
      import { local } from 'assets://js/lib/cat.js';
      const provider = {
        async init(config) { local.set('token', config.ext.token); },
        async homeVod() { return { list: [{ vod_id: 'home', vod_name: '模块首页', vod_remarks: local.get('token') }] }; },
        async category(tid, page) { return { list: [{ vod_id: tid + page, vod_name: '模块分类' }] }; },
        async search(keyword) { return { list: [{ vod_id: 'search', vod_name: keyword }] }; },
        async detail(id) { return { list: [{ vod_id: id, vod_name: '模块详情', vod_play_from: '直连', vod_play_url: '第1集$https://media.example/demo.m3u8' }] }; },
        async play(flag, url) { return { flag, url, parse: 0 }; }
      };
      export default provider;
    `);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");

  const adapter = new SourceAdapterFactory().create({
    key: "module-js",
    name: "模块 JS",
    type: 3,
    api: `http://127.0.0.1:${address.port}/provider.js`,
    ext: "{ token: 'configured' }",
  });

  try {
    const home = await adapter.home();
    assert.equal(home.list[0]?.vodName, "模块首页");
    assert.equal(home.list[0]?.vodRemarks, "configured");
    const search = await adapter.search("寒战");
    assert.equal(search.list[0]?.vodName, "寒战");
    const detail = await adapter.detail("search");
    assert.equal(detail.flags[0]?.episodes[0]?.url, "https://media.example/demo.m3u8");
    const player = await adapter.player("直连", "https://media.example/demo.m3u8");
    assert.equal(player.parse, 0);
  } finally {
    await adapter.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
