import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDanmakuPayload } from "../src/desktop/renderer/player/danmaku.ts";

const artPlayerPath = new URL("../src/desktop/renderer/components/ArtPlayerHost.vue", import.meta.url);
const embeddedPlayerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const overlayPath = new URL("../src/desktop/renderer/components/DanmakuOverlay.vue", import.meta.url);

test("danmaku parser supports DPlayer XML and common JSON shapes", () => {
  const xml = `<i><d p="1.5,1,25,16711680,0,0,0,0">第一条&amp;弹幕</d><d p="2,5,25,16777215,0,0,0,0">顶部弹幕</d></i>`;
  const parsedXml = parseDanmakuPayload(xml, "application/xml");
  assert.equal(parsedXml.length, 2);
  assert.equal(parsedXml[0]?.time, 1.5);
  assert.equal(parsedXml[0]?.text, "第一条&弹幕");
  assert.equal(parsedXml[0]?.color, "#ff0000");
  assert.equal(parsedXml[1]?.mode, "top");

  const parsedJson = parseDanmakuPayload(JSON.stringify({ data: [
    { time: 3, text: "对象弹幕", mode: "bottom", color: "00ff00" },
    [4, 1, 16777215, 0, "数组弹幕"],
  ] }), "application/json");
  assert.deepEqual(parsedJson.map((item) => item.text), ["对象弹幕", "数组弹幕"]);
  assert.equal(parsedJson[0]?.mode, "bottom");
  assert.equal(parsedJson[0]?.color, "#00ff00");
});

test("ArtPlayer and stable embedded player mount the shared danmaku overlay", async () => {
  const [artPlayer, embeddedPlayer, overlay] = await Promise.all([
    readFile(artPlayerPath, "utf8"),
    readFile(embeddedPlayerPath, "utf8"),
    readFile(overlayPath, "utf8"),
  ]);
  for (const source of [artPlayer, embeddedPlayer]) {
    assert.ok(source.includes("DanmakuOverlay"));
    assert.ok(source.includes("session.danmakuUrl"));
    assert.ok(source.includes("danmakuEnabled"));
    assert.ok(source.includes("currentTime"));
  }
  assert.ok(overlay.includes("parseDanmakuPayload"));
  assert.ok(overlay.includes("danmaku-item"));
  assert.ok(overlay.includes("mode-top"));
  assert.ok(overlay.includes("mode-bottom"));
});
