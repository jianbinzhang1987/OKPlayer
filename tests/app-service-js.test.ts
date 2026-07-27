import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AppService } from "../src/core/app-service.ts";

test("app service supports type=3 JavaScript spider search detail and player", async (t) => {
  const script = `
    function init(ext) { globalThis.extValue = ext; }
    function searchContent(key) {
      return JSON.stringify({list:[{vod_id:'v1',vod_name:key,vod_pic:'p'}]});
    }
    function detailContent(ids) {
      return JSON.stringify({list:[{vod_id:ids[0],vod_name:'详情',vod_play_from:'线路',vod_play_url:'第1集$token-1'}]});
    }
    function playerContent(flag,id) {
      return JSON.stringify({url:'https://cdn.example/'+id+'.m3u8',parse:0,flag});
    }
  `;

  const server = createServer((req, res) => {
    if (req.url === "/spider.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(script);
      return;
    }
    if (req.url === "/config.json") {
      const base = `http://127.0.0.1:${(server.address() as any).port}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ sites: [{ key: "js", name: "JS源", type: 3, api: `${base}/spider.js`, ext: "demo" }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = (server.address() as any).port;
  const service = new AppService(":memory:");
  t.after(() => service.close());
  await service.loadConfig(`http://127.0.0.1:${port}/config.json`);

  const search = await service.search("测试", "js");
  assert.equal(search[0]?.vodName, "测试");
  const detail = await service.detail("js", "v1");
  assert.equal(detail.flags[0]?.episodes[0]?.url, "token-1");
  const media = await service.resolve("js", "线路", "token-1");
  assert.equal(media.url, "https://cdn.example/token-1.m3u8");
});
