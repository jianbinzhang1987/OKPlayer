import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveCatchupPlayback, expandCatchupTemplate, supportsLiveCatchup } from "../src/core/live/live-catchup.ts";
import type { EpgProgramme } from "../src/core/live/epg-models.ts";
import type { LiveChannel, LiveLine } from "../src/core/live/live-models.ts";

const NOW = Date.parse("2026-08-02T12:00:00Z");
const PROGRAMME: EpgProgramme = {
  id: "programme-1",
  channelId: "CCTV1",
  startAt: Date.parse("2026-08-02T10:00:00Z"),
  endAt: Date.parse("2026-08-02T11:00:00Z"),
  title: "新闻联播",
  categories: ["新闻"],
};
const LINE: LiveLine = {
  id: "line-1",
  name: "线路 1",
  url: "https://live.example.com/cctv1.m3u8?token=abc",
  headers: { Referer: "https://portal.example.com/" },
  format: "hls",
  parse: false,
  priority: 0,
};

function channel(catchup: LiveChannel["catchup"]): LiveChannel {
  return {
    id: "channel-1",
    sourceId: "source-1",
    groupId: "group-1",
    name: "CCTV-1 综合",
    lines: [LINE],
    catchup,
  };
}

test("catchup query rules expand standard UTC placeholders and preserve headers", () => {
  const value = channel({ type: "query", source: "utc={utc}&utcend={utcend}&duration={duration}" });
  const result = buildLiveCatchupPlayback(value, LINE, PROGRAMME, NOW);
  assert.equal(supportsLiveCatchup(value), true);
  assert.match(result.line.url, /token=abc&utc=1785664800&utcend=1785668400&duration=3600/);
  assert.deepEqual(result.line.headers, LINE.headers);
  assert.equal(result.channel.lines.length, 1);
  assert.equal(result.line.name, "回看 · 新闻联播");
});

test("catchup replace rules rewrite the current live URL", () => {
  const value = channel({
    type: "replace",
    regex: "cctv1\\.m3u8",
    replace: "archive/{utc}/{duration}/cctv1.m3u8",
  });
  const result = buildLiveCatchupPlayback(value, LINE, PROGRAMME, NOW);
  assert.match(result.line.url, /archive\/1785664800\/3600\/cctv1\.m3u8/);
});

test("flussonic catchup derives an absolute timeshift path without a source template", () => {
  const flussonicLine = { ...LINE, url: "https://live.example.com/cctv1/index.m3u8?token=abc" };
  const result = buildLiveCatchupPlayback(channel({ type: "flussonic" }), flussonicLine, PROGRAMME, NOW);
  assert.equal(result.line.url, "https://live.example.com/cctv1/timeshift_abs-1785664800.m3u8?token=abc");
  assert.equal(supportsLiveCatchup(channel({ type: "fs" })), true);
});

test("catchup templates expose ISO and title variables", () => {
  const result = expandCatchupTemplate("https://archive.example.com/{start}/{title}", {
    start: "2026-08-02T10%3A00%3A00.000Z",
    title: "%E6%96%B0%E9%97%BB",
  });
  assert.equal(result, "https://archive.example.com/2026-08-02T10%3A00%3A00.000Z/%E6%96%B0%E9%97%BB");
});

test("future programmes and incomplete catchup rules are rejected", () => {
  assert.equal(supportsLiveCatchup(channel({ type: "query" })), false);
  assert.throws(() => buildLiveCatchupPlayback(channel({ type: "query", source: "utc={utc}" }), LINE, {
    ...PROGRAMME,
    startAt: NOW + 60 * 60_000,
    endAt: NOW + 2 * 60 * 60_000,
  }, NOW), /未来节目不能回看/);
});
