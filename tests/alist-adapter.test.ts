import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { AlistAdapter } from "../src/core/alist-adapter.ts";

async function readBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const source = Buffer.concat(chunks).toString("utf8");
  return source ? JSON.parse(source) as Record<string, unknown> : {};
}

async function withServer<T>(handler: (origin: string, requests: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const body = request.method === "POST" ? await readBody(request) : {};
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? "",
      client: request.headers["x-client"] ?? "",
      body,
    });
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (request.url === "/v3/api/public/settings") {
      response.end(JSON.stringify({
        code: 200,
        data: {
          site_title: "我的网盘",
          version: "3.45.0",
          default_page_size: 20,
        },
      }));
      return;
    }
    if (request.url === "/v3/api/auth/login") {
      response.end(JSON.stringify({ code: 200, data: { token: "token-v3" } }));
      return;
    }
    if (request.url === "/v3/api/fs/list") {
      response.end(JSON.stringify({
        code: 200,
        data: {
          total: 3,
          content: [
            { name: "连续剧", type: 1, size: 0 },
            { name: "电影.mp4", type: 2, size: 2_097_152, thumb: "/thumb/movie.jpg" },
            { name: "说明.txt", type: 4, size: 128 },
          ],
        },
      }));
      return;
    }
    if (request.url === "/v3/api/fs/search") {
      response.end(JSON.stringify({
        code: 200,
        data: {
          total: 1,
          content: [{ name: "第01集.mkv", parent: "/media/连续剧/", type: 2, size: 1024 }],
        },
      }));
      return;
    }
    if (request.url === "/v3/api/fs/get") {
      response.end(JSON.stringify({
        code: 200,
        data: {
          name: "电影.mp4",
          type: 2,
          size: 2_097_152,
          raw_url: `${origin}/media/movie.mp4?sign=abc`,
        },
      }));
      return;
    }

    if (request.url === "/v2/api/public/settings") {
      response.end(JSON.stringify({
        code: 200,
        data: [
          { key: "title", value: "旧版网盘" },
          { key: "version", value: "2.6.4" },
          { key: "enable search", value: "true" },
          { key: "default page size", value: "10" },
        ],
      }));
      return;
    }
    if (request.url === "/v2/api/public/path") {
      const path = String(body.path ?? "");
      response.end(JSON.stringify({
        code: 200,
        data: path.endsWith(".mp4")
          ? { files: [{ name: "旧电影.mp4", type: 3, size: 1024, url: `${origin}/legacy/movie.mp4` }] }
          : { files: [{ name: "旧电影.mp4", type: 3, size: 1024 }, { name: "旧目录", type: 1, size: 0 }] },
      }));
      return;
    }
    if (request.url === "/v2/api/public/search") {
      response.end(JSON.stringify({
        code: 200,
        data: { files: [{ name: "旧电影.mp4", parent: "/", type: 3, size: 1024 }] },
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ code: 404, message: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试服务器启动失败");
  try {
    return await handler(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("Alist v3 supports login directory password folders search detail and direct playback", async () => {
  await withServer(async (origin, requests) => {
    const adapter = new AlistAdapter({
      key: "alist-v3",
      name: "Alist V3",
      type: 13,
      api: "csp_Alist",
      ext: JSON.stringify({
        server: `${origin}/v3`,
        startPage: "/media/",
        params: { "/media": { password: "secret" } },
        headers: { "X-Client": "mac" },
        username: "demo",
        password: "pass",
      }),
    });

    const home = await adapter.home();
    assert.equal(home.list.length, 2);
    assert.equal(home.list[0]?.vodTag, "folder");
    assert.equal(home.list[0]?.vodId, "/media/连续剧/");
    assert.equal(home.list[1]?.vodTag, "file");
    assert.equal(home.list[1]?.vodRemarks, "2.00 MB");
    assert.equal(home.list[1]?.vodPic, `${origin}/thumb/movie.jpg`);

    const listRequest = requests.find((entry) => entry.url === "/v3/api/fs/list");
    assert.deepEqual(listRequest?.body, {
      path: "/media/",
      password: "secret",
      page: 1,
      per_page: 20,
      refresh: false,
    });
    assert.equal(listRequest?.authorization, "token-v3");
    assert.equal(listRequest?.client, "mac");

    const search = await adapter.search("第01集");
    assert.equal(search.list[0]?.vodId, "/media/连续剧/第01集.mkv");
    assert.equal(search.list[0]?.vodTag, "file");

    const detail = await adapter.detail("/media/电影.mp4");
    assert.equal(detail.flags[0]?.flag, "我的网盘");
    assert.equal(detail.flags[0]?.episodes[0]?.url, `${origin}/media/movie.mp4?sign=abc`);
    const player = adapter.player("我的网盘", detail.flags[0]!.episodes[0]!.url);
    assert.equal(player.parse, 0);
    assert.deepEqual(player.header, {});

    await assert.rejects(adapter.detail("/media/连续剧/"), /目录不能直接播放/);
    await adapter.destroy();
  });
});

test("Alist v2 supports public path search and file detail", async () => {
  await withServer(async (origin) => {
    const adapter = new AlistAdapter({
      key: "alist-v2",
      name: "Alist V2",
      type: 3,
      api: "csp_Alist",
      ext: JSON.stringify({ server: `${origin}/v2`, startPage: "/" }),
    });

    const home = await adapter.home();
    assert.equal(home.list.length, 2);
    assert.equal(home.list[0]?.vodTag, "file");
    assert.equal(home.list[1]?.vodTag, "folder");
    assert.equal(home.list[1]?.vodId, "/旧目录/");

    const search = await adapter.search("旧电影");
    assert.equal(search.list[0]?.vodId, "/旧电影.mp4");

    const detail = await adapter.detail("/旧电影.mp4");
    assert.equal(detail.flags[0]?.flag, "旧版网盘");
    assert.equal(detail.flags[0]?.episodes[0]?.url, `${origin}/legacy/movie.mp4`);
    await adapter.destroy();
  });
});
