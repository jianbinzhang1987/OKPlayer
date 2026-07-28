import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const managerPath = new URL("../src/desktop/catvod-process-manager.ts", import.meta.url);

test("CatVod startup preserves Windows runtime environment and bypasses localhost proxies", async () => {
  const source = await readFile(managerPath, "utf8");
  for (const marker of [
    "WINDOWS_START_TIMEOUT_MS = 60_000",
    '"SystemRoot"',
    '"LOCALAPPDATA"',
    '"COMSPEC"',
    "mergeNoProxy",
    '"127.0.0.1", "localhost", "::1"',
  ]) assert.ok(source.includes(marker), `missing Windows CatVod startup marker: ${marker}`);
});

test("CatVod startup reports early child exit and the concrete service log", async () => {
  const source = await readFile(managerPath, "utf8");
  assert.ok(source.includes("CatVod 子进程启动阶段异常退出"));
  assert.ok(source.includes("服务日志：${logFile}"));
  assert.ok(source.includes("Promise.race"));
});
