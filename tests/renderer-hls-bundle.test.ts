import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJsonPath = new URL("../package.json", import.meta.url);
const playerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const hlsEnginePath = new URL("../src/desktop/renderer/player/hls-engine.ts", import.meta.url);
const htmlPath = new URL("../src/desktop/renderer/index.html", import.meta.url);

test("renderer bundles a fixed local HLS.js dependency behind a reusable engine", async () => {
  const [packageText, playerSource, hlsEngineSource, html] = await Promise.all([
    readFile(packageJsonPath, "utf8"),
    readFile(playerPath, "utf8"),
    readFile(hlsEnginePath, "utf8"),
    readFile(htmlPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageText) as { devDependencies?: Record<string, string> };

  assert.equal(packageJson.devDependencies?.["hls.js"], "1.6.16");
  assert.match(playerSource, /from ["']\.\.\/player\/hls-engine\.ts["']/);
  assert.match(hlsEngineSource, /import\(["']hls\.js["']\)/);
  assert.doesNotMatch(`${playerSource}\n${hlsEngineSource}`, /cdn\.jsdelivr|https:\/\//i);
  assert.doesNotMatch(html, /cdn\.jsdelivr/i);
  assert.match(html, /script-src 'self'/);
});
