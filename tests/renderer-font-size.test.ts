import assert from "node:assert/strict";
import test from "node:test";
import { FONT_SIZE_OPTIONS, fontSizeClass, normalizeFontSize } from "../src/desktop/renderer/font-size.ts";

test("font size preferences default to the readable standard mode", () => {
  assert.equal(normalizeFontSize(undefined), "standard");
  assert.equal(normalizeFontSize("legacy-value"), "standard");
  assert.equal(fontSizeClass(normalizeFontSize(undefined)), "font-standard");
});

test("font size preferences expose compact standard large and extra-large", () => {
  assert.deepEqual(FONT_SIZE_OPTIONS.map((option) => option.value), [
    "compact",
    "standard",
    "large",
    "extra-large",
  ]);
  assert.equal(normalizeFontSize("extra-large"), "extra-large");
  assert.equal(fontSizeClass("large"), "font-large");
});
