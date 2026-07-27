import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MpvController } from "../src/core/mpv-controller.ts";
import { PlayerService } from "../src/core/player-service.ts";

const mediaPath = path.join(tmpdir(), `fongmi-player-smoke-${process.pid}.mp4`);
const socketPath = path.join(tmpdir(), `fongmi-player-smoke-${process.pid}.sock`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(100);
  assert.ok(predicate(), message);
}

let player: PlayerService | undefined;

try {
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "testsrc=size=320x180:rate=24",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "5",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-y",
    mediaPath,
  ], { stdio: "inherit" });

  const mpv = new MpvController({
    executable: "/usr/local/bin/mpv",
    ipcPath: socketPath,
    startupTimeoutMs: 10_000,
  });
  player = new PlayerService(mpv);

  let duration = 0;
  const pauseStates: boolean[] = [];
  const diagnostics: string[] = [];

  mpv.on("duration", (value) => {
    if (typeof value === "number") duration = value;
  });
  mpv.on("pause", (value) => {
    if (typeof value === "boolean") pauseStates.push(value);
  });
  mpv.on("stderr", (value) => diagnostics.push(String(value).trim()));
  mpv.on("error", (value) => diagnostics.push(String(value)));

  await player.open(mediaPath);
  await waitFor(
    () => duration > 0,
    5_000,
    `未收到有效时长；诊断：${diagnostics.join(" | ")}`,
  );

  await player.pause();
  await waitFor(
    () => pauseStates.includes(true),
    2_000,
    `未收到暂停状态 true，实际：${JSON.stringify(pauseStates)}`,
  );

  const resumeStart = pauseStates.length;
  await player.play();
  await waitFor(
    () => pauseStates.slice(resumeStart).includes(false),
    2_000,
    `未收到继续播放状态 false，实际：${JSON.stringify(pauseStates)}`,
  );

  await player.stop();
  assert.equal(mpv.isStarted(), true);

  await player.close();
  player = undefined;
  assert.equal(mpv.isStarted(), false);
  console.log(`mpv smoke passed: duration=${duration.toFixed(2)} pauseStates=${JSON.stringify(pauseStates)}`);
} finally {
  await player?.close().catch(() => undefined);
  await rm(mediaPath, { force: true }).catch(() => undefined);
  await rm(socketPath, { force: true }).catch(() => undefined);
}
