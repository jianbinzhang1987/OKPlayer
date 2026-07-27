import assert from "node:assert/strict";
import test from "node:test";
import { DrpyRuleRuntime, parseDrpyList, parseHtml, selectAll } from "../src/core/drpy-runtime.ts";

test("Drpy rule worker provides storage base64 and common hash helpers", async () => {
  const runtime = new DrpyRuleRuntime({ timeoutMs: 2_000 });
  const rule = await runtime.load(`
    localStorage.setItem("token", md5("abc"));
    var rule = {
      title: base64Decode(base64Encode("规则测试")),
      token: localStorage.getItem("token"),
      sha1: sha1("abc"),
      sha256: sha256("abc")
    };
  `);

  assert.equal(rule.title, "规则测试");
  assert.equal(rule.token, "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(runtime.storage.getItem("token"), rule.token);
  assert.equal(String(rule.sha1).length, 40);
  assert.equal(String(rule.sha256).length, 64);
});

test("Drpy worker preserves $js.toString dynamic functions from real dr2 syntax", async () => {
  const runtime = new DrpyRuleRuntime({ timeoutMs: 2_000 });
  const rule = await runtime.load(`
    var rule = {
      title: "真实语法样例",
      lazy: $js.toString(() => {
        input = { parse: 0, url: base64Decode("aHR0cHM6Ly9leGFtcGxlLmNvbS92aWRlby5tM3U4") };
      }),
      pc: PC_UA,
      mobile: MOBILE_UA
    };
  `);

  assert.match(String(rule.lazy), /^js:/);
  assert.match(String(rule.lazy), /base64Decode/);
  assert.match(String(rule.pc), /Macintosh/);
  assert.match(String(rule.mobile), /Android/);
});

test("Drpy JSON list rules support nested paths and fallback fields", () => {
  const payload = JSON.stringify({
    data: {
      hitDocs: [{ title: "JSON 影片", img: "/json.jpg", rightCorner: { text: "完结" }, playPartId: 42 }],
    },
  });
  const list = parseDrpyList(
    payload,
    "json:data.hitDocs;title;img;updateInfo||rightCorner.text;playPartId",
    "https://example.com/api/list",
  );

  assert.deepEqual(list, [{
    id: "42",
    name: "JSON 影片",
    pic: "https://example.com/json.jpg",
    remarks: "完结",
  }]);
});

test("Drpy HTML selector parses list fields and positional selectors", () => {
  const html = `
    <section class="cards">
      <article class="item"><a href="/detail/1"><span class="title">影片一</span><img data-src="/1.jpg"><em>更新至 2 集</em></a></article>
      <article class="item"><a href="/detail/2"><span class="title">影片二</span><img data-src="/2.jpg"><em>完结</em></a></article>
    </section>
    <nav class="tabs"><a>线路一</a><a>线路二</a></nav>
  `;
  const list = parseDrpyList(
    html,
    ".item;.title&&Text;img&&data-src;em&&Text;a&&href",
    "https://example.com/home",
  );

  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    id: "https://example.com/detail/1",
    name: "影片一",
    pic: "https://example.com/1.jpg",
    remarks: "更新至 2 集",
  });
  assert.equal(selectAll(parseHtml(html), ".tabs > a:eq(1)").length, 1);
});

test("Drpy selector distinguishes nested && selectors from extraction directives", () => {
  const html = `
    <div class="detail">
      <ul><li>第一项</li><li><a href="/play/2">第二项</a></li></ul>
      <img class="cover" src="/cover.jpg" alt="封面">
    </div>
  `;
  const root = parseHtml(html);
  const nested = parseDrpyList(
    `<section class="list"><article><a href="/detail/1"><span>标题一</span></a></article></section>`,
    ".list&&article;a&&Text;;;a&&href",
    "https://example.com/home",
  );

  assert.equal(nested[0]?.name, "标题一");
  assert.equal(nested[0]?.id, "https://example.com/detail/1");
  assert.equal(selectAll(root, ".detail&&ul&&li:eq(1)").length, 1);
});
