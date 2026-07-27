import assert from "node:assert/strict";
import test from "node:test";
import {
  ExternalPlayerService,
  externalPlayerCommand,
  validateExternalMediaUrl,
} from "../src/desktop/external-player-service.ts";

test("external player URL validation allows only HTTP and HTTPS", () => {
  assert.equal(validateExternalMediaUrl("https://cdn.example.com/movie.mp4"), "https://cdn.example.com/movie.mp4");
  assert.throws(() => validateExternalMediaUrl("javascript:alert(1)"), /仅允许打开/);
  assert.throws(() => validateExternalMediaUrl("not-a-url"), /地址无效/);
});

test("macOS commands support IINA VLC and system default player", () => {
  assert.deepEqual(externalPlayerCommand("darwin", "iina", "https://example.com/a.mp4"), {
    file: "open",
    args: ["-a", "IINA", "https://example.com/a.mp4"],
  });
  assert.deepEqual(externalPlayerCommand("darwin", "vlc", "https://example.com/a.mp4"), {
    file: "open",
    args: ["-a", "VLC", "https://example.com/a.mp4"],
  });
  assert.deepEqual(externalPlayerCommand("darwin", "system", "https://example.com/a.mp4"), {
    file: "open",
    args: ["https://example.com/a.mp4"],
  });
});

test("external player service executes the selected player without shell interpolation", async () => {
  const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
  const service = new ExternalPlayerService("darwin", async (file, args, options) => {
    calls.push({ file, args, options });
  });
  const result = await service.open("https://cdn.example.com/movie.mp4?token=a%20b", "iina");
  assert.deepEqual(result, { status: "opened", player: "iina" });
  assert.equal(calls[0]?.file, "open");
  assert.deepEqual(calls[0]?.args, ["-a", "IINA", "https://cdn.example.com/movie.mp4?token=a%20b"]);
});

test("platform-specific external player restrictions are explicit", () => {
  assert.throws(() => externalPlayerCommand("win32", "iina", "https://example.com/a.mp4"), /仅适用于 macOS/);
  assert.throws(() => externalPlayerCommand("linux", "iina", "https://example.com/a.mp4"), /仅适用于 macOS/);
  assert.deepEqual(externalPlayerCommand("linux", "vlc", "https://example.com/a.mp4"), {
    file: "vlc",
    args: ["--one-instance", "https://example.com/a.mp4"],
  });
  assert.deepEqual(externalPlayerCommand("win32", "system", "https://example.com/a.mp4"), {
    file: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "https://example.com/a.mp4"],
  });
});
