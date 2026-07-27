import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseJsonDanmaku } from "../src/desktop/renderer/player/danmaku.ts";
import {
  normalizeDanmakuSettings,
  normalizeSubtitleSettings,
  parseBlockedWords,
} from "../src/desktop/renderer/player/presentation-settings.ts";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const containerPath = new URL("../src/desktop/renderer/components/PlayerContainer.vue", import.meta.url);
const embeddedPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const artPath = new URL("../src/desktop/renderer/components/ArtPlayerHost.vue", import.meta.url);
const overlayPath = new URL("../src/desktop/renderer/components/DanmakuOverlay.vue", import.meta.url);

test("presentation settings clamp unsafe values and normalize blocked words", () => {
  assert.deepEqual(normalizeDanmakuSettings({
    opacity: 9,
    fontScale: 0.1,
    speed: 5,
    maxActive: 500,
    blockedWords: [" 剧透 ", "广告", "剧透", "", 123],
  }), {
    opacity: 1,
    fontScale: 0.7,
    speed: 2,
    maxActive: 72,
    blockedWords: ["剧透", "广告"],
  });
  assert.deepEqual(normalizeSubtitleSettings({
    fontScale: 3,
    delaySeconds: -30,
    backgroundOpacity: -1,
  }), {
    fontScale: 1.8,
    delaySeconds: -10,
    backgroundOpacity: 0,
  });
  assert.deepEqual(parseBlockedWords("剧透，广告\n营销;剧透"), ["剧透", "广告", "营销"]);
});

test("high-density danmaku remains bounded and malicious markup is converted to plain text", () => {
  const payload = Array.from({ length: 9_000 }, (_, index) => ({
    time: index / 10,
    text: index === 0 ? "<script>alert(1)</script>正常文字" : `弹幕 ${index}`,
    mode: index % 3 === 0 ? "top" : index % 3 === 1 ? "bottom" : "scroll",
  }));
  const parsed = parseJsonDanmaku(JSON.stringify(payload));
  assert.equal(parsed.length, 8_000);
  assert.equal(parsed[0]?.text, "alert(1)正常文字");
  assert.doesNotMatch(parsed[0]?.text ?? "", /<script>/i);
});

test("both embedded players receive persisted subtitle and danmaku settings", async () => {
  const [app, container, embedded, art, overlay] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(containerPath, "utf8"),
    readFile(embeddedPath, "utf8"),
    readFile(artPath, "utf8"),
    readFile(overlayPath, "utf8"),
  ]);

  for (const marker of [
    "danmakuSettings",
    "subtitleSettings",
    "danmakuBlockedWordsText",
    'setSetting("danmakuSettings"',
    'setSetting("subtitleSettings"',
    "弹幕屏蔽词",
    "字幕时间偏移",
    "同屏弹幕上限",
  ]) assert.ok(app.includes(marker), `missing app presentation marker: ${marker}`);

  assert.match(container, /:danmaku-settings="props\.danmakuSettings"/);
  assert.match(container, /:subtitle-settings="props\.subtitleSettings"/);
  assert.match(embedded, /applySubtitlePreferences/);
  assert.match(embedded, /video::cue/);
  assert.match(embedded, /:settings="danmakuSettings"/);
  assert.match(art, /offset: subtitleSettings\.delaySeconds/);
  assert.match(art, /:settings="danmakuSettings"/);
  assert.match(overlay, /blockedWords/);
  assert.match(overlay, /maxActive/);
  assert.match(overlay, /animationDuration/);
});
