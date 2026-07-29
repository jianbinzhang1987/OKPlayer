import assert from "node:assert/strict";
import test from "node:test";
import type { NativePlayerViewRect, PlaybackController } from "../src/core/player-service.ts";
import { NativeFallbackPlaybackController } from "../src/desktop/native-fallback-playback-controller.ts";

class FakeController implements PlaybackController {
  started = 0;
  loaded: Array<{ url: string; headers: Record<string, string> }> = [];
  released = 0;
  detached = 0;
  attachError?: Error;
  loadError?: Error;
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  private readonly backend: string;

  constructor(backend: string) {
    this.backend = backend;
  }

  getBackend() { return this.backend; }
  getIpcPath() { return this.backend === "mpv-ipc" ? "fake-ipc" : undefined; }
  async start() { this.started += 1; }
  async load(url: string, headers: Record<string, string> = {}) {
    if (this.loadError) throw this.loadError;
    this.loaded.push({ url, headers });
  }
  async play() {}
  async pause() {}
  async stop() {}
  async seek(_seconds: number) {}
  async setSpeed(_speed: number) {}
  async setVolume(_volume: number) {}
  async setMuted(_muted: boolean) {}
  async release() { this.released += 1; }
  async attachNativeView(_parentHandle: bigint, _rect: NativePlayerViewRect) {
    if (this.attachError) throw this.attachError;
    return { ok: true, message: "attached" };
  }
  async resizeNativeView(_rect: NativePlayerViewRect) {}
  async detachNativeView() { this.detached += 1; }
  on(event: string, callback: (value: unknown) => void) {
    const callbacks = this.listeners.get(event) ?? new Set<(value: unknown) => void>();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(callback);
  }
  emit(event: string, value: unknown) {
    this.listeners.get(event)?.forEach((callback) => callback(value));
  }
}

const rect = { x: 10, y: 20, width: 640, height: 360 };

test("native view attachment failure switches the same controller to MPV IPC", async () => {
  const native = new FakeController("native-libmpv");
  const fallback = new FakeController("mpv-ipc");
  native.attachError = new Error("WGL unavailable");
  const controller = new NativeFallbackPlaybackController(native, fallback);

  const attachment = await controller.attachNativeView(1n, rect);
  assert.equal(attachment.ok, false);
  assert.equal(attachment.backend, "mpv-ipc");
  assert.match(String(attachment.message), /WGL unavailable/);
  assert.equal(controller.getBackend(), "mpv-ipc");
  assert.equal(native.detached, 1);
  assert.equal(native.released, 1);

  await controller.start();
  await controller.load("https://example.test/video.mp4", { Referer: "https://example.test/" });
  assert.equal(fallback.started, 1);
  assert.deepEqual(fallback.loaded, [{
    url: "https://example.test/video.mp4",
    headers: { Referer: "https://example.test/" },
  }]);
  assert.equal(controller.getIpcPath(), "fake-ipc");
});

test("native media load failure retries the same URL through MPV IPC", async () => {
  const native = new FakeController("native-libmpv");
  const fallback = new FakeController("mpv-ipc");
  native.loadError = new Error("decoder initialization failed");
  const controller = new NativeFallbackPlaybackController(native, fallback);

  const attachment = await controller.attachNativeView(2n, rect);
  assert.equal(attachment.ok, true);
  await controller.start();
  await controller.load("https://example.test/protected.m3u8", { Cookie: "token=redacted" });

  assert.equal(controller.getBackend(), "mpv-ipc");
  assert.equal(native.released, 1);
  assert.equal(fallback.started, 1);
  assert.equal(fallback.loaded[0]?.url, "https://example.test/protected.m3u8");
  assert.deepEqual(fallback.loaded[0]?.headers, { Cookie: "token=redacted" });
});

test("event forwarding follows only the currently active backend", async () => {
  const native = new FakeController("native-libmpv");
  const fallback = new FakeController("mpv-ipc");
  native.attachError = new Error("GLX unavailable");
  const controller = new NativeFallbackPlaybackController(native, fallback);
  const values: number[] = [];
  const remove = controller.on("time-pos", (value) => values.push(Number(value)));

  native.emit("time-pos", 1);
  await controller.attachNativeView(3n, rect);
  native.emit("time-pos", 2);
  fallback.emit("time-pos", 3);
  remove();
  fallback.emit("time-pos", 4);

  assert.deepEqual(values, [1, 3]);
});
