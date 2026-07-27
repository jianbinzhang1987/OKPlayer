import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AppYsV2Adapter } from "../src/core/appysv2-adapter.ts";

function json(response: import("node:http").ServerResponse, payload: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

test("AppYsV2 adapter completes home search detail and player flow", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/app/index_video") {
      return json(response, {
        list: [{ vlist: [{ vod_id: "home-1", vod_name: "首页影片", vod_pic: "https://img/home.jpg" }] }],
      });
    }
    if (url.pathname === "/app/search") {
      assert.equal(url.searchParams.get("text"), "测试");
      return json(response, {
        list: [{ vod_id: "vod-1", vod_name: "测试影片", vod_pic: "https://img/search.jpg" }],
        page: 1,
        total: 1,
        limit: 20,
      });
    }
    if (url.pathname === "/app/video") {
      assert.equal(url.searchParams.get("tid"), "movie");
      return json(response, {
        list: [{ vod_id: "vod-1", vod_name: "测试影片", vod_remarks: "HD" }],
        page: 1,
        total: 1,
        limit: 20,
      });
    }
    if (url.pathname === "/app/video_detail") {
      assert.equal(url.searchParams.get("id"), "vod-1");
      return json(response, {
        data: {
          vod_id: "vod-1",
          vod_name: "测试影片",
          vod_pic: "https://img/detail.jpg",
          vod_url_with_player: [
            {
              code: "lzm3u8",
              url: "第1集$https://media.example.com/play?id=1#第2集$https://media.example.com/play?id=2",
              parse_api: "https://parser.example.com/?url=",
            },
          ],
        },
      });
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const adapter = new AppYsV2Adapter({
    key: "appys",
    name: "AppYs",
    type: 3,
    api: "csp_AppYsV2",
    ext: `http://127.0.0.1:${address.port}/app`,
  });

  const home = await adapter.home();
  assert.equal(home.list[0]?.vodName, "首页影片");
  assert.equal(home.list[0]?.siteKey, "appys");

  const category = await adapter.category("movie", "1", { area: "大陆" });
  assert.equal(category.list[0]?.vodRemarks, "HD");

  const search = await adapter.search("测试");
  assert.equal(search.list[0]?.vodId, "vod-1");

  const detail = await adapter.detail("vod-1");
  assert.equal(detail.flags.length, 1);
  assert.equal(detail.flags[0]?.flag, "量子");
  assert.equal(detail.flags[0]?.episodes[1]?.name, "第2集");

  const player = adapter.player("量子", detail.flags[0]!.episodes[0]!.url);
  assert.equal(player.parse, 1);
  assert.equal(player.playUrl, "https://parser.example.com/?url=");
  assert.equal(player.url, "https://media.example.com/play?id=1");

  await adapter.destroy();
});
