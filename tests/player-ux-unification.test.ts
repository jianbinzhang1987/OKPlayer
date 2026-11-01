import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NativeFallbackPlaybackController } from "../src/desktop/native-fallback-playback-controller.ts";
import type { PlaybackController } from "../src/core/player-service.ts";

const nativeHostPath = new URL("../src/desktop/renderer/components/NativePlayerHost.vue", import.meta.url);
const artPlayerPath = new URL("../src/desktop/renderer/components/ArtPlayerHost.vue", import.meta.url);
const embeddedPlayerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const mainPath = new URL("../src/desktop/main.ts", import.meta.url);
const preloadPath = new URL("../src/desktop/preload.ts", import.meta.url);

test("NativePlayerHost supports floating overlay controls, danmaku, subtitle, and stage double-click fullscreen", async () => {
  const source = await readFile(nativeHostPath, "utf8");

  // 1. Control bar & full-screen consistency
  assert.ok(source.includes("controls-hidden"), "missing controls-hidden class");
  assert.ok(source.includes("@mousemove=\"showControls\""), "missing mousemove handler");
  assert.ok(source.includes("@mouseleave=\"scheduleControlsHide\""), "missing mouseleave handler");
  assert.ok(source.includes("3_000"), "missing 3-second auto-hide timeout");
  assert.ok(source.includes("@dblclick.prevent=\"toggleFullscreen\""), "missing double-click fullscreen toggle");

  // Floating overlay styles
  assert.match(source, /\.native-player-topbar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0 0 auto;/);
  assert.match(source, /\.native-player-controls\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*auto 0 0;/);
  assert.match(source, /\.native-player-stage\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;/);
  assert.match(source, /\.controls-hidden \.native-player-topbar\s*\{[\s\S]*?opacity:\s*0;/);
  assert.match(source, /\.controls-hidden \.native-player-controls\s*\{[\s\S]*?opacity:\s*0;/);

  // 2. Danmaku and Subtitles
  assert.ok(source.includes("<DanmakuOverlay"), "missing DanmakuOverlay component");
  assert.ok(source.includes(":danmaku-url=\"session.danmakuUrl\""), "missing danmaku url binding");
  assert.ok(source.includes(":current-time=\"position\""), "missing current-time binding");
  assert.ok(source.includes("toggleSubtitle"), "missing toggleSubtitle function");
  assert.ok(source.includes("setSubtitleVisibility"), "missing setSubtitleVisibility call");
  assert.ok(source.includes("setSubtitleDelay"), "missing setSubtitleDelay call");
  assert.ok(source.includes("addSubtitle"), "missing addSubtitle call");

  // 3. Unified Keyboard shortcuts
  assert.ok(source.includes("INPUT") && source.includes("TEXTAREA"), "missing input target protection in handleKeydown");
  assert.ok(source.includes("queueNativeSeek(position.value - 10)"), "missing debounced left seek");
  assert.ok(source.includes("queueNativeSeek(position.value + 10)"), "missing debounced right seek");
});

test("ArtPlayerHost and EmbeddedPlayer implement unified keyboard shortcuts without hijacking input elements", async () => {
  const [artSource, embeddedSource] = await Promise.all([
    readFile(artPlayerPath, "utf8"),
    readFile(embeddedPlayerPath, "utf8"),
  ]);

  assert.ok(artSource.includes("INPUT") && artSource.includes("TEXTAREA") && artSource.includes("SELECT"), "ArtPlayer missing input/select target protection");
  assert.ok(embeddedSource.includes("INPUT") && embeddedSource.includes("TEXTAREA") && embeddedSource.includes("SELECT"), "EmbeddedPlayer missing input/select target protection");

  assert.ok(artSource.includes("addEventListener(\"keydown\", handleKeydown, true)"), "ArtPlayer should listen to keydown in capture phase");
  assert.ok(embeddedSource.includes("addEventListener(\"keydown\", handleKeydown, true)"), "EmbeddedPlayer should listen to keydown in capture phase");

  for (const shortcut of ["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"]) {
    assert.ok(artSource.includes(shortcut), `ArtPlayer missing shortcut: ${shortcut}`);
    assert.ok(embeddedSource.includes(shortcut), `EmbeddedPlayer missing shortcut: ${shortcut}`);
  }
});

test("main.ts disables raw MPV window escape and preload exposes subtitle controls", async () => {
  const [mainSource, preloadSource] = await Promise.all([
    readFile(mainPath, "utf8"),
    readFile(preloadPath, "utf8"),
  ]);

  assert.ok(mainSource.includes("allowWindowFallback: false"), "main.ts should configure allowWindowFallback: false");

  assert.ok(preloadSource.includes("setSubtitleTrack"), "preload missing setSubtitleTrack");
  assert.ok(preloadSource.includes("setSubtitleDelay"), "preload missing setSubtitleDelay");
  assert.ok(preloadSource.includes("setSubtitleVisibility"), "preload missing setSubtitleVisibility");
  assert.ok(preloadSource.includes("addSubtitle"), "preload missing addSubtitle");
});

test("NativeFallbackPlaybackController forwards subtitle commands to active backend", async () => {
  const calls: string[] = [];
  const fakeNative: PlaybackController = {
    start: async () => undefined,
    load: async () => undefined,
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    stop: async () => undefined,
    seek: () => undefined,
    setSpeed: () => undefined,
    setVolume: () => undefined,
    setMuted: () => undefined,
    release: async () => undefined,
    setSubtitleTrack: (track) => calls.push(`track:${track}`),
    setSubtitleDelay: (seconds) => calls.push(`delay:${seconds}`),
    setSubtitleVisibility: (visible) => calls.push(`vis:${visible}`),
    addSubtitle: (url) => calls.push(`add:${url}`),
  };
  const fakeFallback: PlaybackController = {
    ...fakeNative,
  };

  const controller = new NativeFallbackPlaybackController(fakeNative, fakeFallback, { allowWindowFallback: true });
  await controller.setSubtitleTrack(2);
  await controller.setSubtitleDelay(1.5);
  await controller.setSubtitleVisibility(false);
  await controller.addSubtitle("https://example.com/sub.vtt");

  assert.deepEqual(calls, [
    "track:2",
    "delay:1.5",
    "vis:false",
    "add:https://example.com/sub.vtt",
  ]);
});

test("NativeLibmpvController implements subtitle control methods and delegates to player handle", async () => {
  const { NativeLibmpvController } = await import("../src/desktop/native-libmpv-controller.ts");
  const controller = new NativeLibmpvController();
  const calls: string[] = [];
  const fakePlayer = {
    load: () => undefined,
    play: () => undefined,
    pause: () => undefined,
    stop: () => undefined,
    seek: () => undefined,
    setSpeed: () => undefined,
    setVolume: () => undefined,
    setMuted: () => undefined,
    setSubtitleTrack: (track: number | string) => calls.push(`track:${track}`),
    setSubtitleDelay: (seconds: number) => calls.push(`delay:${seconds}`),
    setSubtitleVisibility: (visible: boolean) => calls.push(`vis:${visible}`),
    addSubtitle: (url: string) => calls.push(`add:${url}`),
    attachView: () => ({ ok: true, viewHandle: 0n, message: "" }),
    resizeView: () => undefined,
    detachView: () => undefined,
    isViewAttached: () => false,
    getState: () => ({
      position: 0,
      duration: 0,
      speed: 1,
      volume: 100,
      paused: false,
      muted: false,
      buffering: false,
      cachePercent: 0,
      videoReady: false,
      stopped: true,
    }),
    destroy: () => undefined,
  };
  (controller as any).player = fakePlayer;

  controller.setSubtitleTrack("2");
  controller.setSubtitleDelay(2.5);
  controller.setSubtitleVisibility(true);
  controller.addSubtitle("https://example.com/test.srt");

  assert.deepEqual(calls, [
    "track:2",
    "delay:2.5",
    "vis:true",
    "add:https://example.com/test.srt",
  ]);
});

test("NativePlayerHost only schedules controls hide on status transition and protects SELECT elements", async () => {
  const source = await readFile(nativeHostPath, "utf8");
  assert.ok(source.includes("previousStatus !== \"playing\""), "handlePlayerState should not reset hide timer if already playing");
  assert.ok(source.includes("tagName === \"SELECT\""), "NativePlayerHost should protect SELECT from shortcut hijacking");
  assert.ok(source.includes("native-episode-drawer-backdrop"), "NativePlayerHost should have episode drawer backdrop");
  assert.ok(source.includes("watch(() => props.session.subtitleUrl"), "NativePlayerHost should watch subtitleUrl");
});
