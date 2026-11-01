import assert from "node:assert/strict";
import test from "node:test";
import { parseVodConfigText } from "../src/core/config-loader.ts";
import { LiveService } from "../src/core/live/live-service.ts";
import { parseEmbeddedLive, parseLiveText } from "../src/core/live/live-parser.ts";
import { SqliteStorage } from "../src/core/sqlite-storage.ts";

test("pure live config is accepted without sites and resolves relative playlist URLs", () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "测试直播",
      url: "./channels/live.m3u",
      epg: "./epg.xml.gz",
      ua: "Test-UA",
    }],
  }), "https://config.example.com/fongmi/config.json");

  assert.equal(config.sites.length, 0);
  assert.equal(config.lives?.length, 1);
  assert.equal(config.lives?.[0]?.url, "https://config.example.com/fongmi/channels/live.m3u");
  assert.deepEqual(config.lives?.[0]?.epgUrls, ["https://config.example.com/fongmi/epg.xml.gz"]);
});

test("direct M3U TXT and JSON playlists can be imported as pure live configurations", () => {
  const m3u = parseVodConfigText("#EXTM3U\n#EXTINF:-1,CCTV-1\nhttps://live.example.com/cctv1.m3u8", "https://lists.example.com/channels.m3u");
  assert.equal(m3u.sites.length, 0);
  assert.equal(m3u.lives?.[0]?.url, "https://lists.example.com/channels.m3u");
  assert.equal(m3u.lives?.[0]?.name, "channels");

  const txt = parseVodConfigText("央视,#genre#\nCCTV-1,https://live.example.com/cctv1.m3u8", "file:///tmp/iptv.txt");
  assert.equal(txt.lives?.[0]?.url, "file:///tmp/iptv.txt");

  const json = parseVodConfigText('[{"name":"央视","channel":[{"name":"CCTV-1","urls":["https://live.example.com/cctv1.m3u8"]}]}]', "https://lists.example.com/iptv.json");
  assert.equal(json.lives?.[0]?.url, "https://lists.example.com/iptv.json");
});

test("a direct HLS media manifest becomes one live channel instead of segment lines", () => {
  const config = parseVodConfigText("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment-1.ts\n#EXTINF:6,\nsegment-2.ts", "https://live.example.com/cctv1.m3u8");
  const source = parseLiveText("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment-1.ts\n#EXTINF:6,\nsegment-2.ts", config.lives![0]!);
  assert.equal(source.groups.length, 1);
  assert.equal(source.groups[0]?.channels.length, 1);
  assert.equal(source.groups[0]?.channels[0]?.lines.length, 1);
  assert.equal(source.groups[0]?.channels[0]?.lines[0]?.url, "https://live.example.com/cctv1.m3u8");
  assert.equal(source.groups[0]?.channels[0]?.lines[0]?.format, "hls");
});

test("TXT parser supports groups directives inline headers and multiple lines", () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{ name: "TXT", url: "https://live.example.com/list.txt", referer: "https://portal.example.com/" }],
  }), "https://config.example.com/config.json");
  const definition = config.lives![0]!;
  const source = parseLiveText(`
央视频道,#genre#
ua=Mozilla/5.0
CCTV-1,https://cdn1.example.com/cctv1.m3u8|Authorization=Bearer%20abc#https://cdn2.example.com/cctv1.m3u8$IPv6
CCTV-1,https://cdn1.example.com/cctv1.m3u8|Authorization=Bearer%20abc
`, definition);

  assert.equal(source.format, "txt");
  assert.equal(source.groups.length, 1);
  assert.equal(source.groups[0]?.channels.length, 1);
  const channel = source.groups[0]!.channels[0]!;
  assert.equal(channel.name, "CCTV-1");
  assert.equal(channel.lines.length, 2);
  assert.equal(channel.lines[0]?.headers["User-Agent"], "Mozilla/5.0");
  assert.equal(channel.lines[0]?.headers.Referer, "https://portal.example.com/");
  assert.equal(channel.lines[0]?.headers.Authorization, "Bearer abc");
  assert.equal(channel.lines[1]?.name, "IPv6");
});

test("repeated channel declarations receive unique line names after merging", () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{ name: "TXT", url: "https://live.example.com/list.txt" }],
  }), "https://config.example.com/config.json");
  const source = parseLiveText(`
央视,#genre#
CCTV-1,https://cdn1.example.com/cctv1.m3u8$线路一
CCTV-1,https://cdn2.example.com/cctv1.m3u8$线路一
CCTV-1,https://cdn3.example.com/cctv1.m3u8$线路一
`, config.lives![0]!);

  assert.deepEqual(
    source.groups[0]?.channels[0]?.lines.map((line) => line.name),
    ["线路 1", "线路 2", "线路 3"],
  );
});

test("M3U parser reads metadata directives headers and channel lines", () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{ name: "M3U", url: "https://live.example.com/path/list.m3u" }],
  }), "https://config.example.com/config.json");
  const definition = config.lives![0]!;
  const source = parseLiveText(`#EXTM3U tvg-url="../epg.xml.gz"
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV-1 综合" tvg-chno="1" tvg-logo="../logo/cctv1.png" group-title="央视",CCTV-1
#EXTVLCOPT:http-user-agent=Mozilla/5.0
#EXTHTTP:{"Authorization":"Bearer token"}
format=hls
https://media.example.com/live/cctv1.m3u8|Referer=https%3A%2F%2Fportal.example.com%2F
`, definition);

  assert.equal(source.format, "m3u");
  const channel = source.groups[0]!.channels[0]!;
  assert.equal(source.groups[0]?.name, "央视");
  assert.equal(channel.tvgId, "CCTV1");
  assert.equal(channel.tvgName, "CCTV-1 综合");
  assert.equal(channel.number, "1");
  assert.equal(channel.logo, "https://live.example.com/logo/cctv1.png");
  assert.equal(channel.lines[0]?.format, "hls");
  assert.equal(channel.lines[0]?.headers["User-Agent"], "Mozilla/5.0");
  assert.equal(channel.lines[0]?.headers.Authorization, "Bearer token");
  assert.equal(channel.lines[0]?.headers.Referer, "https://portal.example.com/");
});

test("embedded JSON groups normalize channels line names and protected groups", () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "内嵌直播",
      groups: [
        {
          name: "新闻",
          channel: [{
            name: "TVBS",
            number: "56",
            tvgId: "TVBS",
            urls: [
              "https://cdn1.example.com/tvbs.m3u8$主线路",
              "https://cdn2.example.com/tvbs.m3u8$备用线路",
            ],
          }],
        },
        {
          name: "隐藏",
          pass: "secret",
          channel: [{ name: "Secret", urls: ["https://cdn.example.com/secret.m3u8"] }],
        },
      ],
    }],
  }), "https://config.example.com/config.json");

  const source = parseEmbeddedLive(config.lives![0]!);
  assert.equal(source.format, "embedded");
  assert.equal(source.groups.length, 1);
  assert.equal(source.groups[0]?.name, "新闻");
  assert.equal(source.groups[0]?.channels[0]?.lines[0]?.name, "主线路");
  assert.equal(source.groups[0]?.channels[0]?.lines[1]?.name, "备用线路");
});

test("LiveService inspects channel lines, verifies HLS segments and marks definitive failures unavailable", async () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "检测源",
      groups: [{
        name: "央视",
        channel: [{
          name: "CCTV-1",
          urls: [
            "https://live.example.com/master.m3u8$高清",
            "https://live.example.com/missing.m3u8$失效",
          ],
        }],
      }],
    }],
  }), "https://config.example.com/config.json");
  let requests = 0;
  const service = new LiveService(() => config, async (input) => {
    requests += 1;
    const url = String(input);
    if (url.endsWith("master.m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n1080/index.m3u8", { status: 200 });
    }
    if (url.endsWith("1080/index.m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment-1.ts", { status: 200 });
    }
    if (url.endsWith("1080/segment-1.ts")) {
      return new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), { status: 206 });
    }
    return new Response("missing", { status: 404 });
  });

  const definition = config.lives![0]!;
  const source = await service.loadSource(definition.id);
  const channel = source.groups[0]!.channels[0]!;
  const inspected = await service.inspectChannel(definition.id, channel.id);
  const good = inspected.lines.find((line) => line.name === "高清")!;
  const bad = inspected.lines.find((line) => line.name === "失效")!;

  assert.equal(good.health?.state, "available");
  assert.equal(good.health?.segmentVerified, true);
  assert.equal(good.health?.resolution, "1920x1080");
  assert.equal(good.health?.bandwidthKbps, 4500);
  assert.ok((good.health?.score ?? 0) > 80);
  assert.equal(bad.health?.state, "unavailable");
  assert.equal(bad.health?.score, 0);
  const requestCount = requests;
  await service.inspectChannel(definition.id, channel.id);
  assert.equal(requests, requestCount);
});

test("LiveService restores persisted line quality and merges real playback feedback", async () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "质量记忆源",
      groups: [{ name: "央视", channel: [{ name: "CCTV-1", urls: ["https://live.example.com/cctv1.m3u8"] }] }],
    }],
  }), "https://config.example.com/config.json");
  const definition = config.lives![0]!;
  const parsed = parseEmbeddedLive(definition);
  const channel = parsed.groups[0]!.channels[0]!;
  const line = channel.lines[0]!;
  const storage = new SqliteStorage();
  storage.saveLiveLineProbe(parsed.id, channel.id, line.id, line.name, {
    state: "available",
    score: 76,
    checkedAt: Date.now(),
    latencyMs: 680,
    segmentVerified: true,
  });
  storage.recordLiveLinePlayback({ sourceId: parsed.id, channelId: channel.id, lineId: line.id, lineName: line.name, kind: "started", startupMs: 720, occurredAt: Date.now() });
  storage.recordLiveLinePlayback({ sourceId: parsed.id, channelId: channel.id, lineId: line.id, lineName: line.name, kind: "stable", playedSeconds: 900, occurredAt: Date.now() });

  const service = new LiveService(() => config, async () => new Response("", { status: 500 }), undefined, storage);
  const loaded = await service.loadSource(definition.id);
  const restored = loaded.groups[0]!.channels[0]!.lines[0]!.health;
  assert.equal(restored?.state, "available");
  assert.equal(restored?.playbackSuccessCount, 1);
  assert.equal(restored?.averageStartupMs, 720);
  assert.ok((restored?.score ?? 0) > 76);

  const updated = service.recordPlaybackFeedback({
    sourceId: parsed.id,
    channelId: channel.id,
    lineId: line.id,
    lineName: line.name,
    kind: "failure",
    reason: "播放中断",
    playedSeconds: 12,
    occurredAt: Date.now(),
  });
  assert.equal(updated?.playbackFailureCount, 1);
  assert.equal(loaded.groups[0]!.channels[0]!.lines[0]!.health?.playbackFailureCount, 1);
  storage.close();
});

test("stale unavailable probes do not permanently block a live line", async () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{ name: "过期质量源", groups: [{ name: "默认", channel: [{ name: "测试频道", urls: ["https://live.example.com/stale.m3u8"] }] }] }],
  }), "https://config.example.com/config.json");
  const definition = config.lives![0]!;
  const parsed = parseEmbeddedLive(definition);
  const channel = parsed.groups[0]!.channels[0]!;
  const line = channel.lines[0]!;
  const storage = new SqliteStorage();
  storage.saveLiveLineProbe(parsed.id, channel.id, line.id, line.name, {
    state: "unavailable",
    score: 0,
    checkedAt: Date.now() - 11 * 60_000,
    reason: "HTTP 404",
  });
  const service = new LiveService(() => config, async () => new Response("", { status: 500 }), undefined, storage);
  const loaded = await service.loadSource(definition.id);
  assert.notEqual(loaded.groups[0]!.channels[0]!.lines[0]!.health?.state, "unavailable");
  storage.close();
});

test("LiveService can preflight only the selected line before playback", async () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "快速启动源",
      groups: [{
        name: "测试",
        channel: [{
          name: "频道",
          urls: [
            "https://live.example.com/fast.m3u8$快速线路",
            "https://live.example.com/slow.m3u8$慢速线路",
          ],
        }],
      }],
    }],
  }), "https://config.example.com/config.json");
  const requested: string[] = [];
  const service = new LiveService(() => config, async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("fast.m3u8")) return new Response("#EXTM3U\n#EXTINF:6,\nfast.ts", { status: 200 });
    if (url.endsWith("fast.ts")) return new Response(new Uint8Array([0x47]), { status: 206 });
    throw new Error("未选择的慢速线路不应在播放前被检测");
  });

  const definition = config.lives![0]!;
  const source = await service.loadSource(definition.id);
  const channel = source.groups[0]!.channels[0]!;
  const selected = channel.lines.find((line) => line.name === "快速线路")!;
  const inspected = await service.inspectChannel(definition.id, channel.id, false, selected.id);

  assert.equal(inspected.lines.find((line) => line.id === selected.id)?.health?.state, "available");
  assert.ok(requested.every((url) => !url.includes("slow.m3u8")));
});

test("LiveService identifies HLS and DASH DRM instead of treating protected streams as ordinary media", async () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{
      name: "DRM 检测源",
      groups: [{
        name: "测试",
        channel: [
          { name: "HLS DRM", urls: ["https://live.example.com/drm.m3u8"] },
          { name: "DASH DRM", urls: ["https://live.example.com/drm.mpd"] },
        ],
      }],
    }],
  }), "https://config.example.com/config.json");
  const service = new LiveService(() => config, async (input) => {
    const url = String(input);
    if (url.endsWith("drm.m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT=\"com.apple.streamingkeydelivery\"\n#EXTINF:6,\nsegment.ts", { status: 200 });
    }
    if (url.endsWith("drm.mpd")) {
      return new Response("<MPD><Period><AdaptationSet><ContentProtection schemeIdUri=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"/></AdaptationSet></Period></MPD>", { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const definition = config.lives![0]!;
  const source = await service.loadSource(definition.id);
  const hlsChannel = source.groups[0]!.channels[0]!;
  const dashChannel = source.groups[0]!.channels[1]!;
  const hls = await service.inspectChannel(definition.id, hlsChannel.id, true);
  const dash = await service.inspectChannel(definition.id, dashChannel.id, true);
  assert.equal(hls.lines[0]?.health?.state, "unavailable");
  assert.match(hls.lines[0]?.health?.reason ?? "", /DRM|SAMPLE-AES/);
  assert.equal(dash.lines[0]?.health?.state, "unavailable");
  assert.match(dash.lines[0]?.health?.reason ?? "", /DRM|Widevine/);
});

test("LiveService loads an external source caches it and supports channel search", async () => {
  const config = parseVodConfigText(JSON.stringify({
    lives: [{ name: "远程直播", url: "https://live.example.com/list.txt" }],
  }), "https://config.example.com/config.json");
  let requests = 0;
  const service = new LiveService(() => config, async () => {
    requests += 1;
    return new Response("新闻,#genre#\nCCTV-13,https://cdn.example.com/cctv13.m3u8", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });

  const definition = config.lives![0]!;
  const first = await service.loadSource(definition.id);
  const second = await service.loadSource(definition.id);
  const matches = await service.searchChannels(definition.id, "CCTV");

  assert.equal(requests, 1);
  assert.equal(first.id, second.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.name, "CCTV-13");
  assert.equal(service.listSummaries()[0]?.channelCount, 1);
});
