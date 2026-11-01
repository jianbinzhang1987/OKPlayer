import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { parseVodConfigText } from "../src/core/config-loader.ts";
import { parseXmlTv, parseXmlTvDate } from "../src/core/live/epg-parser.ts";
import { EpgService, buildLiveEpgGuide, expandEpgTemplate, matchEpgChannel, normalizeChannelName } from "../src/core/live/epg-service.ts";
import { SqliteStorage } from "../src/core/sqlite-storage.ts";
import { parseEmbeddedLive } from "../src/core/live/live-parser.ts";

const NOW = Date.parse("2026-08-02T10:30:00Z");

const XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="CCTV1"><display-name>CCTV-1 综合</display-name><display-name>央视一套</display-name><icon src="https://img.example.com/cctv1.png" /></channel>
  <channel id="CCTV13"><display-name>CCTV-13 新闻</display-name></channel>
  <programme start="20260802180000 +0800" stop="20260802190000 +0800" channel="CCTV1">
    <title lang="zh">新闻 &amp; 访谈</title><sub-title>特别节目</sub-title><desc><![CDATA[今日重点内容]]></desc><category>新闻</category>
  </programme>
  <programme start="20260802190000 +0800" stop="20260802200000 +0800" channel="CCTV1"><title>黄金档剧场</title></programme>
  <programme start="20260802180000 +0800" stop="20260802183000 +0800" channel="CCTV13"><title>共同关注</title></programme>
</tv>`;

test("XMLTV parser reads channels programmes entities and timezone offsets", () => {
  const parsed = parseXmlTv(XMLTV, { now: NOW });
  assert.equal(parsed.channels.length, 2);
  assert.deepEqual(parsed.channels[0]?.names, ["CCTV-1 综合", "央视一套"]);
  assert.equal(parsed.programmes.length, 3);
  assert.equal(parsed.programmes[0]?.title, "新闻 & 访谈");
  assert.equal(parsed.programmes[0]?.subtitle, "特别节目");
  assert.equal(parsed.programmes[0]?.description, "今日重点内容");
  assert.equal(parsed.programmes[0]?.startAt, Date.parse("2026-08-02T10:00:00Z"));
  assert.equal(parseXmlTvDate("20260802180000 +08:00"), Date.parse("2026-08-02T10:00:00Z"));
});

test("EPG guide matches tvg-id first and calculates current next and schedule", () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "测试直播",
      epg: "https://epg.example.com/guide.xml.gz",
      groups: [{ name: "央视", channel: [{ name: "CCTV-1 高清", tvgId: "CCTV1", urls: ["https://live.example.com/cctv1.m3u8"] }] }],
    }],
  }), "https://config.example.com/config.json");
  const source = parseEmbeddedLive(config.lives![0]!);
  const parsed = parseXmlTv(XMLTV, { now: NOW });
  const guide = buildLiveEpgGuide(source, parsed, NOW);
  const channel = source.groups[0]!.channels[0]!;
  const epg = guide.channels[channel.id]!;

  assert.equal(epg.matchMethod, "tvg-id");
  assert.equal(epg.confidence, 100);
  assert.equal(epg.current?.title, "新闻 & 访谈");
  assert.equal(epg.next?.title, "黄金档剧场");
  assert.equal(epg.schedule.length, 2);
  assert.equal(guide.matchedChannelCount, 1);
});

test("EPG channel matching supports conservative normalized names", () => {
  const match = matchEpgChannel({
    id: "live-1",
    sourceId: "source",
    groupId: "group",
    name: "CCTV-13 新闻高清",
    lines: [],
  }, [{ id: "news", names: ["CCTV-13 新闻"] }]);
  assert.equal(match?.method, "normalized-name");
  assert.equal(match?.channelId, "news");
  assert.equal(normalizeChannelName("央视一套 高清"), "cctv一套");
});

test("EPG templates expand channel and date placeholders safely", () => {
  const url = expandEpgTemplate("https://epg.example.com/api?ch={tvg-id}&name={name}&date={date}", {
    id: "live-id",
    sourceId: "source",
    groupId: "group",
    name: "CCTV-1 综合",
    tvgId: "CCTV1",
    lines: [],
  }, NOW, "Asia/Shanghai");
  assert.equal(url, "https://epg.example.com/api?ch=CCTV1&name=CCTV-1%20%E7%BB%BC%E5%90%88&date=2026-08-02");
});

test("EPG service downloads and decompresses gzip XMLTV with source headers", async () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "测试直播",
      epg: "https://epg.example.com/guide.xml.gz",
      ua: "EPG-Test",
      groups: [{ name: "央视", channel: [{ name: "CCTV-1 综合", tvgId: "CCTV1", urls: ["https://live.example.com/cctv1.m3u8"] }] }],
    }],
  }), "https://config.example.com/config.json");
  const definition = config.lives![0]!;
  const source = parseEmbeddedLive(definition);
  let requests = 0;
  const service = new EpgService(async (_input, init) => {
    requests += 1;
    assert.equal(new Headers(init?.headers).get("User-Agent"), "EPG-Test");
    return new Response(gzipSync(Buffer.from(XMLTV)), { status: 200, headers: { "content-type": "application/gzip" } });
  });

  const first = await service.loadGuide(source, definition, false, NOW);
  const second = await service.loadGuide(source, definition, false, NOW + 60_000);
  assert.equal(requests, 1);
  assert.equal(first.matchedChannelCount, 1);
  assert.equal(second.channels[source.groups[0]!.channels[0]!.id]?.current?.title, "新闻 & 访谈");
});

test("EPG service loads per-channel templates and reuses SQLite cache after restart", async () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "模板节目单",
      epg: "https://epg.example.com/api?ch={tvg-id}&date={date}",
      groups: [{ name: "央视", channel: [{ name: "CCTV-1 综合", tvgId: "CCTV1", urls: ["https://live.example.com/cctv1.m3u8"] }] }],
    }],
  }), "https://config.example.com/config.json");
  const definition = config.lives![0]!;
  const source = parseEmbeddedLive(definition);
  const storage = new SqliteStorage(":memory:");
  let requests = 0;
  try {
    const firstService = new EpgService(async (input) => {
      requests += 1;
      assert.match(String(input), /ch=CCTV1/);
      assert.match(String(input), /date=2026-08-02/);
      return new Response(XMLTV, { status: 200 });
    }, storage);
    const first = await firstService.loadGuide(source, definition, false, NOW);
    assert.equal(first.matchedChannelCount, 1);
    assert.equal(requests, 1);

    const restarted = new EpgService(async () => {
      throw new Error("持久化缓存有效时不应重新请求网络");
    }, storage);
    const cached = await restarted.loadGuide(source, definition, false, NOW + 60_000);
    assert.equal(cached.channels[source.groups[0]!.channels[0]!.id]?.current?.title, "新闻 & 访谈");
  } finally {
    storage.close();
  }
});

test("manual EPG mappings persist and override automatic matching", () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "人工映射",
      groups: [{ name: "其他", channel: [{ name: "未知频道", urls: ["https://live.example.com/unknown.m3u8"] }] }],
    }],
  }), "https://config.example.com/config.json");
  const source = parseEmbeddedLive(config.lives![0]!);
  const liveChannel = source.groups[0]!.channels[0]!;
  const storage = new SqliteStorage(":memory:");
  try {
    const service = new EpgService(undefined, storage);
    service.saveMapping(source.id, liveChannel.id, "CCTV1", "CCTV-1 综合");
    const guide = buildLiveEpgGuide(source, parseXmlTv(XMLTV, { now: NOW }), NOW, 1, [], service.listMappings(source.id));
    assert.equal(guide.channels[liveChannel.id]?.matchMethod, "manual");
    assert.equal(guide.channels[liveChannel.id]?.current?.title, "新闻 & 访谈");
    assert.equal(storage.listLiveEpgMappings(source.id)[0]?.epgChannelId, "CCTV1");
    service.removeMapping(source.id, liveChannel.id);
    assert.equal(storage.listLiveEpgMappings(source.id).length, 0);
  } finally {
    storage.close();
  }
});
