import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MpvController } from "../src/core/mpv-controller.ts";
import { PlayerService, type PlaybackController } from "../src/core/player-service.ts";
import { NativeFallbackPlaybackController } from "../src/desktop/native-fallback-playback-controller.ts";
import { NativeLibmpvController } from "../src/desktop/native-libmpv-controller.ts";
import { createMockTvApi } from "../src/desktop/renderer/mock-api.ts";

const nativeHostPath = new URL("../src/desktop/renderer/components/NativePlayerHost.vue", import.meta.url);
const embeddedPlayerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const artPlayerPath = new URL("../src/desktop/renderer/components/ArtPlayerHost.vue", import.meta.url);
const registerIpcPath = new URL("../src/desktop/register-ipc.ts", import.meta.url);
const preloadPath = new URL("../src/desktop/preload.ts", import.meta.url);
const mockApiPath = new URL("../src/desktop/renderer/mock-api.ts", import.meta.url);
const appVuePath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const sourceCapabilityPath = new URL("../src/core/source-capability.ts", import.meta.url);

test("MpvController handles aspect ratio and audio track commands accurately", async () => {
  const controller = new MpvController({ executable: "mock-mpv" });
  const commands: unknown[] = [];
  controller.onCommand((command) => commands.push(command));

  // Audio track commands
  await controller.setAudioTrack("cycle");
  await controller.setAudioTrack("next");
  await controller.setAudioTrack(2);
  await controller.setAudioTrack("1");

  assert.deepEqual(commands.slice(0, 4), [
    ["cycle", "aid"],
    ["cycle", "aid"],
    ["set_property", "aid", 2],
    ["set_property", "aid", "1"],
  ]);

  // Aspect ratio commands
  commands.length = 0;
  await controller.setAspectRatio("stretch");
  assert.deepEqual(commands, [
    ["set_property", "keepaspect", false],
  ]);

  commands.length = 0;
  await controller.setAspectRatio("16:9");
  assert.deepEqual(commands, [
    ["set_property", "keepaspect", true],
    ["set_property", "video-aspect-override", "16:9"],
  ]);

  commands.length = 0;
  await controller.setAspectRatio("4:3");
  assert.deepEqual(commands, [
    ["set_property", "keepaspect", true],
    ["set_property", "video-aspect-override", "4:3"],
  ]);

  commands.length = 0;
  await controller.setAspectRatio("auto");
  assert.deepEqual(commands, [
    ["set_property", "keepaspect", true],
    ["set_property", "video-aspect-override", "-1"],
  ]);
});

test("NativeLibmpvController normalizes track numbers and forwards aspect ratio and audio track commands", async () => {
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
    setSubtitleTrack: (track: number | string) => calls.push(`subtitle:${track}`),
    setSubtitleDelay: () => undefined,
    setSubtitleVisibility: () => undefined,
    addSubtitle: () => undefined,
    setAudioTrack: (track: number | string) => calls.push(`audio:${track}`),
    setAspectRatio: (ratio: string) => calls.push(`aspect:${ratio}`),
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

  // Numeric track IDs should be converted to string to avoid NAPI string typecheck failures
  await controller.setAudioTrack("cycle");
  await controller.setAudioTrack(3);
  await controller.setSubtitleTrack(2);
  await controller.setAspectRatio("16:9");
  await controller.setAspectRatio("stretch");

  assert.deepEqual(calls, [
    "audio:cycle",
    "audio:3",
    "subtitle:2",
    "aspect:16:9",
    "aspect:stretch",
  ]);
});

test("NativeFallbackPlaybackController and PlayerService forward aspect ratio and audio track commands", async () => {
  const calls: string[] = [];
  const fakeNative: PlaybackController = {
    start: async () => undefined,
    load: async () => undefined,
    play: () => undefined,
    pause: () => undefined,
    stop: async () => undefined,
    seek: () => undefined,
    setSpeed: () => undefined,
    setVolume: () => undefined,
    setMuted: () => undefined,
    release: async () => undefined,
    setAudioTrack: (track) => calls.push(`native:audio:${track}`),
    setAspectRatio: (ratio) => calls.push(`native:aspect:${ratio}`),
  };
  const fakeFallback: PlaybackController = {
    ...fakeNative,
    setAudioTrack: (track) => calls.push(`fallback:audio:${track}`),
    setAspectRatio: (ratio) => calls.push(`fallback:aspect:${ratio}`),
  };

  const fallbackController = new NativeFallbackPlaybackController(fakeNative, fakeFallback, { allowWindowFallback: true });
  await fallbackController.setAudioTrack("cycle");
  await fallbackController.setAspectRatio("4:3");

  assert.deepEqual(calls, [
    "native:audio:cycle",
    "native:aspect:4:3",
  ]);

  const service = new PlayerService(fakeNative);
  await service.setAudioTrack(1);
  await service.setAspectRatio("stretch");

  assert.deepEqual(calls, [
    "native:audio:cycle",
    "native:aspect:4:3",
    "native:audio:1",
    "native:aspect:stretch",
  ]);
});

test("IPC contract, preload, and mockApi handle P2 controls with state persistence", async () => {
  const [registerSource, preloadSource, mockApiSource] = await Promise.all([
    readFile(registerIpcPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(mockApiPath, "utf8"),
  ]);

  // IPC channel registration
  assert.ok(registerSource.includes("PLAYER_SET_AUDIO_TRACK: \"player:audio:track\""), "missing PLAYER_SET_AUDIO_TRACK IPC");
  assert.ok(registerSource.includes("PLAYER_SET_ASPECT_RATIO: \"player:aspect-ratio\""), "missing PLAYER_SET_ASPECT_RATIO IPC");
  assert.ok(registerSource.includes("WINDOW_ALWAYS_ON_TOP_GET: \"window:always-on-top:get\""), "missing WINDOW_ALWAYS_ON_TOP_GET IPC");
  assert.ok(registerSource.includes("WINDOW_ALWAYS_ON_TOP_SET: \"window:always-on-top:set\""), "missing WINDOW_ALWAYS_ON_TOP_SET IPC");
  assert.ok(registerSource.includes("WINDOW_MINI_MODE_GET: \"window:mini-mode:get\""), "missing WINDOW_MINI_MODE_GET IPC");
  assert.ok(registerSource.includes("WINDOW_MINI_MODE_SET: \"window:mini-mode:set\""), "missing WINDOW_MINI_MODE_SET IPC");

  // Preload exposed methods
  assert.ok(preloadSource.includes("setAudioTrack: (track: number | string) => ipcRenderer.invoke"), "preload missing setAudioTrack");
  assert.ok(preloadSource.includes("setAspectRatio: (ratio: string) => ipcRenderer.invoke"), "preload missing setAspectRatio");
  assert.ok(preloadSource.includes("getWindowAlwaysOnTop: () => ipcRenderer.invoke"), "preload missing getWindowAlwaysOnTop");
  assert.ok(preloadSource.includes("setWindowAlwaysOnTop: (enabled: boolean) => ipcRenderer.invoke"), "preload missing setWindowAlwaysOnTop");
  assert.ok(preloadSource.includes("getWindowMiniMode: () => ipcRenderer.invoke"), "preload missing getWindowMiniMode");
  assert.ok(preloadSource.includes("setWindowMiniMode: (enabled: boolean) => ipcRenderer.invoke"), "preload missing setWindowMiniMode");

  // Functional mock API verification (actual invocation & state retention)
  const mock = createMockTvApi();
  assert.equal(await mock.getWindowAlwaysOnTop(), false);
  assert.equal(await mock.getWindowMiniMode(), false);

  assert.equal(await mock.setWindowAlwaysOnTop(true), true);
  assert.equal(await mock.getWindowAlwaysOnTop(), true);

  assert.equal(await mock.setWindowMiniMode(true), true);
  assert.equal(await mock.getWindowMiniMode(), true);
  assert.equal(await mock.getWindowAlwaysOnTop(), true); // mini-mode sets always on top

  assert.equal(await mock.setWindowMiniMode(false), false);
  assert.equal(await mock.getWindowMiniMode(), false);
});

test("NativePlayerHost protects system modifier shortcuts and provides P2 features", async () => {
  const source = await readFile(nativeHostPath, "utf8");

  // Aspect ratio controls & cycling
  assert.ok(source.includes("const aspectRatio = ref"), "missing aspectRatio reactive ref");
  assert.ok(source.includes("changeAspectRatio"), "missing changeAspectRatio function");
  assert.ok(source.includes("event.key.toLowerCase() === \"r\""), "missing 'r' aspect ratio cycle hotkey");

  // Modifier key protection so Cmd+R, Ctrl+R, Cmd+A, etc. are not hijacked
  assert.ok(source.includes("if (event.metaKey || event.ctrlKey || event.altKey) return;"), "missing modifier shortcut protection");

  // Audio track cycling
  assert.ok(source.includes("cycleAudioTrack"), "missing cycleAudioTrack function");
  assert.ok(source.includes("event.key.toLowerCase() === \"a\""), "missing 'a' audio track cycle hotkey");

  // Subtitle delay calibration with [ and ]
  assert.ok(source.includes("event.key === \"[\""), "missing '[' subtitle delay -0.5s shortcut");
  assert.ok(source.includes("event.key === \"]\""), "missing ']' subtitle delay +0.5s shortcut");
  assert.ok(source.includes("adjustSubtitleDelay(-0.5)"), "missing adjustSubtitleDelay(-0.5)");
  assert.ok(source.includes("adjustSubtitleDelay(0.5)"), "missing adjustSubtitleDelay(+0.5)");
  assert.ok(source.includes("showPlayerToast"), "missing showPlayerToast function");
  assert.ok(source.includes(".player-toast"), "missing player toast styling");

  // Always-on-top and Mini-mode
  assert.ok(source.includes("toggleAlwaysOnTop"), "missing toggleAlwaysOnTop function");
  assert.ok(source.includes("event.key.toLowerCase() === \"t\""), "missing 't' always-on-top hotkey");
  assert.ok(source.includes("toggleMiniMode"), "missing toggleMiniMode function");
  assert.ok(source.includes("alwaysOnTopActive"), "missing alwaysOnTopActive ref");
  assert.ok(source.includes("miniModeActive"), "missing miniModeActive ref");
  assert.ok(source.includes(".is-mini-mode"), "missing .is-mini-mode styles");

  // Cleanup on unmount / exit
  assert.ok(source.includes("setWindowMiniMode?.(false)"), "should reset mini mode on exit");
  assert.ok(source.includes("setWindowAlwaysOnTop?.(false)"), "should reset always-on-top on exit");
});

test("EmbeddedPlayer implements container-query aspect ratio, modifier safety, and subtitle delay watcher", async () => {
  const source = await readFile(embeddedPlayerPath, "utf8");

  // Container query sizing for aspect-ratio
  assert.ok(source.includes("container-type: size"), "missing container-type: size on .video-stage");
  assert.ok(source.includes("100cqw") && source.includes("100cqh"), "missing container query sizing units for aspect ratio");
  assert.ok(source.includes(".aspect-16-9"), "missing .aspect-16-9 style class");
  assert.ok(source.includes(".aspect-4-3"), "missing .aspect-4-3 style class");
  assert.ok(source.includes(".aspect-stretch"), "missing .aspect-stretch style class");
  assert.ok(source.includes("event.key.toLowerCase() === \"r\""), "missing 'r' aspect ratio cycle shortcut");

  // Modifier key protection
  assert.ok(source.includes("if (event.metaKey || event.ctrlKey || event.altKey) return;"), "missing modifier shortcut protection");

  // Subtitle delay prop reactivity
  assert.ok(source.includes("watch(() => props.subtitleSettings?.delaySeconds"), "missing delaySeconds watcher");

  // Audio track switching
  assert.ok(source.includes("cycleAudioTrack"), "missing cycleAudioTrack function");
  assert.ok(source.includes("event.key.toLowerCase() === \"a\""), "missing 'a' audio track cycle shortcut");

  // Subtitle delay calibration
  assert.ok(source.includes("adjustSubtitleDelay(-0.5)"), "missing adjustSubtitleDelay(-0.5)");
  assert.ok(source.includes("adjustSubtitleDelay(0.5)"), "missing adjustSubtitleDelay(+0.5)");
  assert.ok(source.includes("event.key === \"[\""), "missing '[' shortcut");
  assert.ok(source.includes("event.key === \"]\""), "missing ']' shortcut");

  // Window pinning & mini mode
  assert.ok(source.includes("toggleAlwaysOnTop"), "missing toggleAlwaysOnTop function");
  assert.ok(source.includes("toggleMiniMode"), "missing toggleMiniMode function");
  assert.ok(source.includes(".embedded-player.is-mini-mode"), "missing mini mode styles");
});

test("ArtPlayerHost integrates subtitleOffset API, modifier protection, always-on-top, and mini-mode", async () => {
  const source = await readFile(artPlayerPath, "utf8");
  assert.ok(source.includes("subtitleOffset: true"), "ArtPlayer should enable subtitleOffset option");
  assert.ok(source.includes("art.subtitleOffset"), "ArtPlayer should use official art.subtitleOffset API");
  assert.ok(!source.includes("(art.subtitle as any).offset"), "ArtPlayer should NOT use invalid (art.subtitle as any).offset");
  assert.ok(source.includes("event.key === \"[\""), "ArtPlayer missing '[' shortcut");
  assert.ok(source.includes("event.key === \"]\""), "ArtPlayer missing ']' shortcut");
  assert.ok(source.includes("if (event.metaKey || event.ctrlKey || event.altKey) return;"), "missing modifier shortcut protection");
  assert.ok(source.includes("toggleAlwaysOnTop"), "ArtPlayer missing toggleAlwaysOnTop");
  assert.ok(source.includes("toggleMiniMode"), "ArtPlayer missing toggleMiniMode");
  assert.ok(source.includes("event.key.toLowerCase() === \"t\""), "missing 't' always-on-top hotkey in ArtPlayer");
  assert.ok(source.includes("event.key.toLowerCase() === \"r\""), "missing 'r' aspect ratio hotkey in ArtPlayer");
});

test("register-ipc handles fullscreen exit and always-on-top restoration in mini-mode", async () => {
  const source = await readFile(registerIpcPath, "utf8");
  assert.ok(source.includes("ownerWindow.isFullScreen()"), "mini mode should check and exit full screen");
  assert.ok(source.includes("wasAlwaysOnTopBeforeMini"), "mini mode should preserve and restore prior always-on-top state");
});

test("Branding and platform strings are normalized for cross-platform desktop UI", async () => {
  const [appSource, capabilitySource, mockSource] = await Promise.all([
    readFile(appVuePath, "utf8"),
    readFile(sourceCapabilityPath, "utf8"),
    readFile(mockApiPath, "utf8"),
  ]);

  // App.vue theme description should not mention macOS specifically
  assert.ok(!appSource.includes("跟随系统会随 macOS 外观自动切换"), "App.vue should normalize macOS string in theme setting");
  assert.ok(appSource.includes("跟随系统会随系统外观自动切换"), "App.vue should use neutral system theme text");

  // source-capability.ts should mention desktop rather than macOS
  assert.ok(!capabilitySource.includes("不能在 macOS 进程中直接执行"), "source-capability should normalize macOS string");
  assert.ok(capabilitySource.includes("不能在桌面端进程中直接执行"), "source-capability should use desktop-neutral text");

  // mock-api.ts should not refer to MACOS featured
  assert.ok(!mockSource.includes("MACOS · FEATURED"), "mock-api should normalize MACOS · FEATURED");
  assert.ok(mockSource.includes("DESKTOP · FEATURED"), "mock-api should use DESKTOP · FEATURED");
});
