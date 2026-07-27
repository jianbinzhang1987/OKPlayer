import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeTechnicalDetail, presentRendererError } from "../src/desktop/renderer/error-presentation.ts";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);

test("renderer error presentation returns user copy, redacted technical detail and recovery action", () => {
  const error = new Error("Error invoking remote method 'catvod:search': Error: fetch failed Cookie=abc123&token=secret-key");
  const presentation = presentRendererError(error, "search");

  assert.equal(presentation.message, "网络连接暂时不可用，请检查网络后重试。");
  assert.equal(presentation.recoveryAction, "retry-search");
  assert.equal(presentation.recoveryLabel, "重新搜索");
  assert.ok(presentation.technicalDetail.includes("fetch failed"));
  assert.ok(!presentation.technicalDetail.includes("abc123"));
  assert.ok(!presentation.technicalDetail.includes("secret-key"));
});

test("renderer error presentation maps contexts to recovery operations", () => {
  assert.equal(presentRendererError("timeout", "home").recoveryAction, "retry-home");
  assert.equal(presentRendererError("timeout", "library").recoveryAction, "retry-library");
  assert.equal(presentRendererError("timeout", "account").recoveryAction, "retry-account");
  assert.equal(presentRendererError("timeout", "detail").recoveryAction, "back");
});

test("technical detail is normalized for renderer display", () => {
  assert.equal(
    normalizeTechnicalDetail("Error invoking remote method 'x': Error:  line 1\nline 2  "),
    "line 1 line 2",
  );
});

test("App.vue wires unified error presentation into global error UI", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    "presentRendererError",
    "displayedError",
    "runErrorRecovery",
    "technicalDetail",
    "errorTechnicalOpen",
    "showRendererError(e, \"search\")",
    "showRendererError(e, \"library\")",
    "showRendererError(e, \"account\"",
  ]) {
    assert.ok(source.includes(marker), `missing unified error marker: ${marker}`);
  }
});
