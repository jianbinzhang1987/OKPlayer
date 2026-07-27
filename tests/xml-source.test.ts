import assert from "node:assert/strict";
import test from "node:test";
import { parseXmlSourceResult } from "../src/core/vod-parser.ts";

test("type=0 XML source parses list detail flags and episodes", () => {
  const xml = `<?xml version="1.0"?>
  <rss><list pagecount="3"><video>
    <id>vod-1</id><name><![CDATA[示例影片]]></name><pic>https://img/p.jpg</pic>
    <note>更新至2集</note><year>2026</year><des><![CDATA[简介]]></des>
    <dl><dd flag="线路A"><![CDATA[第1集$https://cdn/a1.m3u8#第2集$https://cdn/a2.m3u8]]></dd></dl>
  </video></list></rss>`;

  const result = parseXmlSourceResult(xml);
  assert.equal(result.pageCount, 3);
  assert.equal(result.list.length, 1);
  assert.equal(result.list[0]?.vodName, "示例影片");
  assert.equal(result.list[0]?.flags[0]?.flag, "线路A");
  assert.equal(result.list[0]?.flags[0]?.episodes[1]?.url, "https://cdn/a2.m3u8");
});
