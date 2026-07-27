import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { DrpyOperationRuntime, parseLooseData } from "../src/core/drpy-operation-runtime.ts";

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => void route(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Drpy 动态测试服务启动失败");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const address = request.socket.address();
  if (!address || typeof address === "string") throw new Error("无法获取测试服务地址");
  const origin = `http://127.0.0.1:${address.port}`;
  const url = new URL(request.url ?? "/", origin);

  if (url.pathname === "/session") {
    response.setHeader("set-cookie", "dynamic=ready; Path=/; HttpOnly");
    response.end("ok");
    return;
  }

  if (url.pathname === "/api/list") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { page?: number };
    if (!String(request.headers.cookie ?? "").includes("dynamic=ready") || request.headers["x-test"] !== "yes") {
      response.statusCode = 401;
      response.end("missing dynamic headers");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      items: [{ id: `movie-${body.page ?? 1}`, name: "动态影片", pic: "/poster.jpg", note: "更新中" }],
    }));
    return;
  }

  if (url.pathname === "/detail") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`
      <main>
        <h1>动态详情</h1>
        <img class="cover" src="/cover.jpg">
        <div class="content">动态规则详情内容</div>
      </main>
    `);
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

test("Drpy dynamic runtime supports synchronous request cookies storage and result mapping", async () => {
  await withServer(async (origin) => {
    const runtime = new DrpyOperationRuntime({
      allowPrivateNetwork: true,
      timeoutMs: 5_000,
      requestTimeoutMs: 2_000,
    });
    const result = await runtime.execute(`js:
      request(HOST + '/session');
      const data = JSON.parse(request(HOST + '/api/list', {
        method: 'POST',
        headers: { 'X-Test': 'yes' },
        body: { page: MY_PAGE }
      }));
      setItem('last-page', String(MY_PAGE));
      setResult(data.items.map((item) => ({
        title: item.name,
        url: item.id,
        pic_url: urljoin(HOST, item.pic),
        desc: item.note
      })));
    `, {
      rule: {},
      host: origin,
      baseUrl: origin,
      page: 3,
    });

    assert.equal(result.vods.length, 1);
    assert.deepEqual(result.vods[0], {
      title: "动态影片",
      url: "movie-3",
      pic_url: `${origin}/poster.jpg`,
      desc: "更新中",
    });
    assert.equal(runtime.storage.getItem("last-page"), "3");
  });
});

test("Drpy dynamic runtime exposes controlled HTML parser RPC", async () => {
  await withServer(async (origin) => {
    const runtime = new DrpyOperationRuntime({ allowPrivateNetwork: true, timeoutMs: 5_000 });
    const result = await runtime.execute(`js:
      const html = request(input);
      VOD = {
        vod_name: pdfh(html, 'h1&&Text'),
        vod_pic: pd(html, 'img.cover&&src'),
        vod_content: jsp.pdfh(html, '.content&&Text')
      };
    `, {
      rule: {},
      host: origin,
      baseUrl: `${origin}/detail`,
      input: `${origin}/detail`,
      myUrl: `${origin}/detail`,
    });

    assert.equal(result.vod.vod_name, "动态详情");
    assert.equal(result.vod.vod_pic, `${origin}/cover.jpg`);
    assert.equal(result.vod.vod_content, "动态规则详情内容");
  });
});

test("Drpy dynamic runtime supports function-style lazy output", async () => {
  const runtime = new DrpyOperationRuntime({ timeoutMs: 3_000 });
  const encoded = Buffer.from("https://media.example.com/video.m3u8").toString("base64");
  const result = await runtime.execute(`js:() => {
    input = {
      parse: 0,
      url: base64Decode('${encoded}'),
      header: { Referer: HOST }
    };
  }`, {
    rule: {},
    host: "https://example.com",
    input: "https://example.com/play/1",
  });

  assert.deepEqual(result.input, {
    parse: 0,
    url: "https://media.example.com/video.m3u8",
    header: { Referer: "https://example.com" },
  });
});

test("Drpy dynamic runtime safely parses loose data literals for TABS and LISTS", async () => {
  const source = `[{name: "第一集", url: "//media.example.com/one.mp3", enabled: true, order: 1}]`;
  assert.deepEqual(parseLooseData(source), [{
    name: "第一集",
    url: "//media.example.com/one.mp3",
    enabled: true,
    order: 1,
  }]);

  const runtime = new DrpyOperationRuntime({ timeoutMs: 3_000 });
  const result = await runtime.execute(`js:
    const data = eval(html.split('audio: ')[1]);
    TABS = ['音频线路'];
    LISTS = [data.map((item) => item.name.strip() + '$https:' + item.url)];
  `, {
    rule: {},
    host: "https://example.com/",
    baseUrl: "https://example.com/detail/1",
    input: "https://example.com/detail/1",
    html: `audio: ${source}`,
  });

  assert.deepEqual(result.tabs, ["音频线路"]);
  assert.deepEqual(result.lists, [["第一集$https://media.example.com/one.mp3"]]);
});

test("Drpy dynamic runtime exposes play_url and URL encoding helpers", async () => {
  const runtime = new DrpyOperationRuntime({ timeoutMs: 3_000 });
  const result = await runtime.execute(`js:
    play_url = play_url.replace('&play_url=', '&type=json&play_url=');
    VOD = { vod_play_url: '正片$' + play_url + urlencode('https://example.com/video?id=1') };
  `, {
    rule: {},
    host: "https://example.com",
    input: "https://example.com/detail/1",
    playUrl: "https://parser.example.com/?jx=&play_url=",
  });
  assert.equal(result.vod.vod_play_url, "正片$https://parser.example.com/?jx=&type=json&play_url=https%3A%2F%2Fexample.com%2Fvideo%3Fid%3D1");
});

test("Drpy dynamic runtime blocks private network and arbitrary string code generation", async () => {
  await withServer(async (origin) => {
    const runtime = new DrpyOperationRuntime({ timeoutMs: 3_000 });
    await assert.rejects(
      runtime.execute(`js:request('${origin}/session')`, { rule: {}, host: origin }),
      /禁止访问本地或内网地址/,
    );
    await assert.rejects(
      runtime.execute("js:eval('1 + 1')", { rule: {}, host: "https://example.com" }),
      /宽松数据字面量|动态规则执行失败/,
    );
  });
});
