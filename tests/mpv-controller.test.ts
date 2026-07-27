import assert from "node:assert/strict";
import test from "node:test";
import { formatHttpHeaderFields, MpvController } from "../src/core/mpv-controller.ts";

test("mpv控制器生成统一播放命令", async () => {
  const controller = new MpvController({ executable: "mock-mpv" });
  const commands: unknown[] = [];

  controller.onCommand((command) => commands.push(command));

  await controller.load("https://example.com/video.m3u8", {
    Referer: "https://example.com",
  });
  controller.pause();
  controller.play();
  controller.seek(120);

  assert.equal(commands.length, 5);
  assert.deepEqual(commands[0], [
    "set_property",
    "http-header-fields",
    "Referer: https://example.com",
  ]);
  assert.deepEqual(commands[1], ["loadfile", "https://example.com/video.m3u8", "replace"]);
  assert.deepEqual(commands[2], ["set_property", "pause", true]);
  assert.deepEqual(commands[3], ["set_property", "pause", false]);
  assert.deepEqual(commands[4], ["seek", 120, "absolute"]);
});

test("mpv playback resets protected headers before the next unrelated item", async () => {
  const controller = new MpvController({ executable: "mock-mpv" });
  const commands: unknown[] = [];
  controller.onCommand((command) => commands.push(command));

  await controller.load("https://video-play.pds.quark.cn/protected.mp4", {
    Cookie: "sid=secret",
    Referer: "https://pan.quark.cn/",
    "User-Agent": "FongMi Test",
  });
  await controller.load("https://cdn.example.com/public.mp4");

  assert.deepEqual(commands[0], [
    "set_property",
    "http-header-fields",
    "Cookie: sid=secret,Referer: https://pan.quark.cn/,User-Agent: FongMi Test",
  ]);
  assert.deepEqual(commands[2], ["set_property", "http-header-fields", ""]);
  assert.deepEqual(commands[3], ["loadfile", "https://cdn.example.com/public.mp4", "replace"]);
});

test("mpv header formatting rejects transport headers and newline injection", () => {
  assert.equal(formatHttpHeaderFields({
    Cookie: "sid=secret",
    Host: "malicious.invalid",
    "Content-Length": "999",
    Referer: "https://pan.quark.cn/\r\nX-Evil: yes",
    "User-Agent": "FongMi",
  }), "Cookie: sid=secret,User-Agent: FongMi");
});
