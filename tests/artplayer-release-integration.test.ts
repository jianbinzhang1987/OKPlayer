import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeWebPlayerEngine } from "../src/desktop/renderer/player/player-types.ts";

const packagePath = new URL("../package.json", import.meta.url);
const lockPath = new URL("../package-lock.json", import.meta.url);
const containerPath = new URL("../src/desktop/renderer/components/PlayerContainer.vue", import.meta.url);
const artPlayerPath = new URL("../src/desktop/renderer/components/ArtPlayerHost.vue", import.meta.url);
const htmlPath = new URL("../src/desktop/renderer/index.html", import.meta.url);
const builderPath = new URL("../electron-builder.yml", import.meta.url);
const verifyPath = new URL("../scripts/verify-release.mjs", import.meta.url);
const noticesPath = new URL("../THIRD_PARTY_NOTICES.md", import.meta.url);

test("ArtPlayer is a fixed local dependency and is loaded on demand", async () => {
  const [packageText, lock, container, player, html] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
    readFile(containerPath, "utf8"),
    readFile(artPlayerPath, "utf8"),
    readFile(htmlPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageText) as { dependencies?: Record<string, string> };

  assert.equal(packageJson.dependencies?.artplayer, "5.4.0");
  assert.match(lock, /"node_modules\/artplayer"/);
  assert.match(lock, /"version": "5\.4\.0"/);
  assert.ok(container.includes("defineAsyncComponent"));
  assert.ok(container.includes('import("./ArtPlayerHost.vue")'));
  assert.ok(player.includes('import Artplayer from "artplayer"'));
  assert.ok(player.includes('preload: "auto"'));
  assert.match(player, /crossOrigin:\s*"anonymous"/);
  assert.doesNotMatch(player, /crossOrigin:\s*"use-credentials"/);
  assert.doesNotMatch(`${container}\n${player}\n${html}`, /cdn\.jsdelivr|unpkg\.com/i);
  assert.match(html, /script-src 'self'/);
});

test("ArtPlayer release verification includes the lazy chunk and license notices", async () => {
  const [builder, verify, notices] = await Promise.all([
    readFile(builderPath, "utf8"),
    readFile(verifyPath, "utf8"),
    readFile(noticesPath, "utf8"),
  ]);

  assert.ok(builder.includes("THIRD_PARTY_NOTICES.md"));
  assert.ok(verify.includes("ArtPlayerHost-"));
  assert.ok(verify.includes("thirdPartyNotices"));
  assert.ok(notices.includes("ArtPlayer 5.4.0"));
  assert.ok(notices.includes("option-validator 2.0.6"));
  assert.ok(notices.includes("hls.js 1.6.16"));
});

test("unknown player engine settings safely fall back to the stable player", () => {
  assert.equal(normalizeWebPlayerEngine("artplayer"), "artplayer");
  assert.equal(normalizeWebPlayerEngine("legacy"), "legacy");
  assert.equal(normalizeWebPlayerEngine("unknown"), "legacy");
  assert.equal(normalizeWebPlayerEngine(undefined), "legacy");
});
