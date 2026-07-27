import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendCatVodLog, maskCatVodLogSecrets } from "../src/desktop/catvod-log-service.ts";

test("CatVod log masking removes credentials from headers fields and URLs", () => {
  const masked = maskCatVodLogSecrets([
    "Authorization: Bearer super-secret",
    "Cookie=session-private",
    "token=abc123",
    "password=hunter2",
    "https://example.com/play?access_token=url-secret&x=1",
  ].join("\n"));

  for (const secret of ["super-secret", "session-private", "abc123", "hunter2", "url-secret"]) {
    assert.equal(masked.includes(secret), false, `secret leaked: ${secret}`);
  }
  assert.match(masked, /Authorization:\s*\*\*\*/i);
  assert.match(masked, /Cookie=\*\*\*/i);
});

test("CatVod service logs rotate by size and keep retention limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "catvod-log-"));
  const logFile = path.join(directory, "service.log");

  await appendCatVodLog(logFile, "first token=secret-one\n", 32, 2);
  await appendCatVodLog(logFile, "second authorization=secret-two\n", 32, 2);
  await appendCatVodLog(logFile, "third password=secret-three\n", 32, 2);

  const current = await readFile(logFile, "utf8");
  const previous = await readFile(`${logFile}.1`, "utf8");
  const oldest = await readFile(`${logFile}.2`, "utf8");
  const combined = `${current}\n${previous}\n${oldest}`;

  assert.match(current, /third/);
  assert.match(previous, /second/);
  assert.match(oldest, /first/);
  assert.equal(/secret-one|secret-two|secret-three/.test(combined), false);
});
