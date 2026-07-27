import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const stylesPath = new URL("../src/desktop/renderer/styles.css", import.meta.url);

test("renderer persists system dark and light appearance choices", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    'type ThemeMode = "system" | "dark" | "light"',
    "themeMode",
    "resolvedTheme",
    "themeClass",
    'matchMedia("(prefers-color-scheme: dark)")',
    'setSetting("themeMode"',
    'getSetting("themeMode", "system")',
    "跟随系统",
    "深色",
    "浅色",
  ]) assert.ok(source.includes(marker), `missing theme marker: ${marker}`);
  assert.ok(source.includes(':class="[fontSizeClass, themeClass]"'));
});

test("light theme replaces core surfaces without changing media artwork styling", async () => {
  const styles = await readFile(stylesPath, "utf8");
  for (const marker of [
    ".app-shell.theme-light",
    ".theme-light .sidebar",
    ".theme-light .topbar",
    ".theme-light :is(input, select, textarea)",
    ".theme-light .global-message",
    ".theme-light .hero:not(.hero-empty)",
  ]) assert.ok(styles.includes(marker), `missing light theme style: ${marker}`);
});
