import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { once } from "node:events";
import { loadVodConfig } from "../src/core/config-loader.ts";
import { HttpSource } from "../src/core/http-source.ts";
import { resolvePlayerResult } from "../src/core/resolver.ts";
import { parseFlags } from "../src/core/vod-parser.ts";

async function withServer<T>(handler: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? "/", origin);
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (url.pathname === "/config.json") {
      response.end(JSON.stringify({
        sites: [{ key: "demo", name: "演示源", type: 1, api: "./api", searchable: 1 }],
        parses: [{ name: "演示解析", type: 1, url: "./parse?url=" }],
      }));
      return;
    }

    if (url.pathname === "/api" && url.searchParams.get("ids")) {
      const direct = url.searchParams.get("ids") === "direct";
      response.end(JSON.stringify({
        list: [{
          vod_id: direct ? "direct" : "parsed",
          vod_name: direct ? "直链影片" : "解析影片",
          vod_play_from: "主线路$$$备用线路",
          vod_play_url: direct
            ? `第01集$${origin}/video/ep1.m3u8#第02集$${origin}/video/ep2.m3u8$$$正片$${origin}/video/backup.mp4`
            : `正片$${origin}/watch/parsed`,
        }],
      }));
      return;
    }

    if (url.pathname === "/api") {
      response.end(JSON.stringify({
        list: [
          { vod_id: "direct", vod_name: "直链影片", vod_pic: "cover.jpg" },
          { vod_id: "parsed", vod_name: "解析影片", vod_pic: "cover2.jpg" },
        ],
      }));
      return;
    }

    if (url.pathname === "/parse") {
      response.end(JSON.stringify({
        url: `${origin}/video/resolved.m3u8`,
        "User-Agent": "DemoPlayer/1.0",
        Referer: origin,
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试服务器启动失败");
  try {
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("线路和剧集协议兼容 $$$、# 和 $", () => {
  const flags = parseFlags(
    "线路一$$$线路二",
    "第01集$url1#第02集$url2$$$正片$url3",
  );
  assert.equal(flags.length, 2);
  assert.equal(flags[0]?.episodes[1]?.name, "第02集");
  assert.equal(flags[0]?.episodes[1]?.url, "url2");
  assert.equal(flags[1]?.episodes[0]?.url, "url3");
});

test("配置、搜索、详情、线路和直链解析闭环", async () => {
  await withServer(async (origin) => {
    const config = await loadVodConfig(`${origin}/config.json`);
    assert.equal(config.sites[0]?.api, `${origin}/api`);
    assert.equal(config.parses[0]?.url, `${origin}/parse?url=`);

    const source = new HttpSource(config.sites[0]!);
    const search = await source.search("影片");
    assert.equal(search.list.length, 2);
    assert.equal(search.list[0]?.siteKey, "demo");

    const vod = await source.detail("direct");
    assert.equal(vod.flags.length, 2);
    assert.equal(vod.flags[0]?.episodes.length, 2);

    const episode = vod.flags[0]!.episodes[0]!;
    const player = source.player(vod.flags[0]!.flag, episode.url);
    assert.equal(player.parse, 0);
    const resolved = await resolvePlayerResult(player, config.parses);
    assert.equal(resolved.url, `${origin}/video/ep1.m3u8`);
    assert.equal(resolved.resolvedBy, "direct");
  });
});

test("非直链通过 JSON 解析器获得最终媒体地址和请求头", async () => {
  await withServer(async (origin) => {
    const config = await loadVodConfig(`${origin}/config.json`);
    const source = new HttpSource(config.sites[0]!);
    const vod = await source.detail("parsed");
    const episode = vod.flags[0]!.episodes[0]!;
    const player = source.player(vod.flags[0]!.flag, episode.url);
    assert.equal(player.parse, 1);

    const resolved = await resolvePlayerResult(player, config.parses);
    assert.equal(resolved.url, `${origin}/video/resolved.m3u8`);
    assert.equal(resolved.headers["User-Agent"], "DemoPlayer/1.0");
    assert.equal(resolved.resolvedBy, "json-api");
  });
});
