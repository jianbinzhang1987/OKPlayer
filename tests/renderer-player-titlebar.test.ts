import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const playerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);

test("embedded player reserves traffic-light space only on macOS", async () => {
  const source = await readFile(playerPath, "utf8");

  assert.match(source, /class="mac-window-controls-safe-area"/);
  assert.match(source, /--mac-window-controls-safe-width:\s*96px/);
  assert.match(source, /\.mac-window-controls-safe-area\s*\{[\s\S]*?display:\s*none;[\s\S]*?flex:\s*0 0 0;/);
  assert.match(source, /html\[data-platform="darwin"\][\s\S]*?\.mac-window-controls-safe-area[\s\S]*?display:\s*block;[\s\S]*?flex-basis:\s*var\(--mac-window-controls-safe-width\)/);
  assert.match(source, /class="player-header-button player-back-button"/);
  assert.match(source, /\.embedded-player:fullscreen \.mac-window-controls-safe-area\s*\{\s*display:\s*none;/s);
});

test("embedded player keeps shortcut hints above native video controls", async () => {
  const source = await readFile(playerPath, "utf8");

  assert.match(source, /--native-controls-safe-height:\s*74px/);
  assert.match(source, /--player-hint-gap:\s*14px/);
  assert.match(source, /bottom:\s*calc\(var\(--native-controls-safe-height\) \+ var\(--player-hint-gap\)\)/);
  assert.match(source, /\.player-hint\s*\{[\s\S]*?pointer-events:\s*none;/);
  assert.doesNotMatch(source, /inset:\s*auto 0 52px/);
});
