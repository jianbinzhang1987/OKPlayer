import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const mainPath = new URL("../src/desktop/main.ts", import.meta.url);
const registerIpcPath = new URL("../src/desktop/register-ipc.ts", import.meta.url);
const playerContainerPath = new URL("../src/desktop/renderer/components/PlayerContainer.vue", import.meta.url);
const nativeHostPath = new URL("../src/desktop/renderer/components/NativePlayerHost.vue", import.meta.url);
const embeddedPlayerPath = new URL("../src/desktop/renderer/components/EmbeddedPlayer.vue", import.meta.url);
const artPlayerPath = new URL("../src/desktop/renderer/components/ArtPlayerHost.vue", import.meta.url);

test("1. App.vue eliminates zombie overlay lockout on playback end", async () => {
  const source = await readFile(appPath, "utf8");

  // handleEmbeddedEnded must close playback when no auto-next episode or if switch fails
  assert.ok(source.includes("handleEmbeddedEnded(progress: PlaybackProgress)"), "missing handleEmbeddedEnded");
  assert.ok(
    source.includes("await closeEmbeddedPlayback({ ...progress, completed: true })"),
    "handleEmbeddedEnded should call closeEmbeddedPlayback when no next episode to prevent zombie overlay",
  );
  assert.ok(
    source.includes("const switched = await switchEmbeddedEpisode(next.url, progress)") &&
    source.includes("if (!switched) {\n      await closeEmbeddedPlayback({ ...progress, completed: true });"),
    "handleEmbeddedEnded should fallback to closeEmbeddedPlayback if auto-next episode switch fails",
  );

  // closeEmbeddedPlayback clears playing.value and calls closePlayback
  const closeStart = source.indexOf("async function closeEmbeddedPlayback");
  assert.ok(closeStart > 0);
  const closeBlock = source.slice(closeStart, closeStart + 500);
  assert.ok(closeBlock.includes("playing.value = null"), "closeEmbeddedPlayback should clear playing.value");
  assert.ok(closeBlock.includes("window.tvApi.closePlayback"), "closeEmbeddedPlayback should call tvApi.closePlayback");
  assert.ok(closeBlock.includes("await restoreNavigationState()"), "closeEmbeddedPlayback should restore navigation");
});

test("2. main.ts eliminates raw external MPV OS window escape", async () => {
  const source = await readFile(mainPath, "utf8");

  // allowWindowFallback must be false
  assert.ok(source.includes("allowWindowFallback: false"), "allowWindowFallback must be false in main.ts");
  assert.ok(
    !source.includes("allowWindowFallback: true"),
    "main.ts must not have allowWindowFallback: true",
  );

  // UnavailablePlaybackController should be used when preference disabled or addon unavailable
  assert.ok(
    source.includes("UnavailablePlaybackController"),
    "main.ts must use UnavailablePlaybackController to avoid spawning standalone MPV windows",
  );
});

test("3. App.vue implements context-aware navigation snapshot tracking and history restoration", async () => {
  const source = await readFile(appPath, "utf8");

  // Navigation snapshot state and methods
  assert.ok(source.includes("NavigationHistorySnapshot"), "missing NavigationHistorySnapshot type");
  assert.ok(source.includes("navigationSnapshot = ref"), "missing navigationSnapshot reactive ref");
  assert.ok(source.includes("saveNavigationSnapshot"), "missing saveNavigationSnapshot function");
  assert.ok(source.includes("restoreNavigationState"), "missing restoreNavigationState function");

  // Snapshot captures source page, keyword, searchTitle, folder trail, and scroll position
  assert.ok(source.includes("page: fromPage"), "snapshot should record source page");
  assert.ok(source.includes("keyword: keyword.value"), "snapshot should record keyword");
  assert.ok(source.includes("searchTitle: searchTitle.value"), "snapshot should record searchTitle");
  assert.ok(source.includes("folderTrail: [...folderTrail.value]"), "snapshot should record folderTrail");
  assert.ok(source.includes("scrollTop:"), "snapshot should record scrollTop");

  // Snapshot is consumed and cleared upon restoration to prevent stale leaks
  assert.ok(
    source.includes("navigationSnapshot.value = null"),
    "restoreNavigationState must clear navigationSnapshot.value to avoid stale navigation jumps",
  );

  // openDetail and playLiveChannel save navigation snapshot
  assert.ok(
    source.includes("if (from !== \"detail\") saveNavigationSnapshot(from)"),
    "openDetail should save navigation snapshot when entering from a source page",
  );
  assert.ok(
    source.includes("saveNavigationSnapshot(page.value)"),
    "playLiveChannel should save navigation snapshot when launching live playback",
  );

  // backFromDetail and closeEmbeddedPlayback restore navigation
  assert.ok(source.includes("backFromDetail"), "missing backFromDetail");
  assert.ok(source.includes("await restoreNavigationState()"), "backFromDetail or close should restore navigation state");

  // Content scroll container ref
  assert.ok(source.includes("ref=\"contentContainer\""), "missing ref=\"contentContainer\" on main.content element");
});

test("4. Safe non-destructive mini-mode replaces destructive window setBounds", async () => {
  const [ipcSource, containerSource, embeddedSource, artSource, nativeSource] = await Promise.all([
    readFile(registerIpcPath, "utf8"),
    readFile(playerContainerPath, "utf8"),
    readFile(embeddedPlayerPath, "utf8"),
    readFile(artPlayerPath, "utf8"),
    readFile(nativeHostPath, "utf8"),
  ]);

  // IPC never destructive setBounds
  assert.ok(!ipcSource.includes("ownerWindow.setBounds"), "register-ipc.ts must not call ownerWindow.setBounds");
  assert.ok(!ipcSource.includes("ownerWindow.setMinimumSize(360, 202)"), "register-ipc.ts must not shrink minimum window size");

  // PlayerContainer supports in-app floating mini-mode
  assert.ok(containerSource.includes(".player-container:has(.is-mini-mode)") || containerSource.includes(".player-container.is-mini-mode"), "PlayerContainer missing is-mini-mode style");
  assert.ok(containerSource.includes("width: 480px"), "PlayerContainer missing 480px mini width style");
  assert.ok(containerSource.includes("height: 270px"), "PlayerContainer missing 270px mini height style");

  // Embedded and ArtPlayer support Picture-in-Picture
  assert.ok(embeddedSource.includes("requestPictureInPicture"), "EmbeddedPlayer should support requestPictureInPicture");
  assert.ok(artSource.includes("requestPictureInPicture"), "ArtPlayerHost should support requestPictureInPicture");
  assert.ok(artSource.includes("leavepictureinpicture"), "ArtPlayerHost should listen to leavepictureinpicture");
  assert.ok(artSource.includes("art.resize()"), "ArtPlayerHost should call art.resize() on mini-mode toggle");
  assert.ok(nativeSource.includes("setTimeout(() => void resizeNativeSurface(), 260)"), "NativePlayerHost should resync native surface after mini-mode transition");
});

test("5. Persistent 2px mini progress line and live clock visibility", async () => {
  const [nativeSource, embeddedSource, artSource] = await Promise.all([
    readFile(nativeHostPath, "utf8"),
    readFile(embeddedPlayerPath, "utf8"),
    readFile(artPlayerPath, "utf8"),
  ]);

  // Persistent 2px mini progress line on all 3 players
  for (const [name, src] of [["NativePlayerHost", nativeSource], ["EmbeddedPlayer", embeddedSource], ["ArtPlayerHost", artSource]]) {
    assert.ok(src.includes("persistent-mini-progress"), `${name} missing persistent-mini-progress element`);
    assert.ok(src.includes("height: 2px"), `${name} missing 2px persistent mini progress height style`);
    assert.ok(src.includes("persistent-mini-progress.visible"), `${name} missing persistent-mini-progress.visible class`);
  }

  // Live streaming clock and status indicator
  assert.ok(nativeSource.includes("currentLiveClock"), "NativePlayerHost missing currentLiveClock");
  assert.ok(nativeSource.includes("native-live-time-status"), "NativePlayerHost missing native-live-time-status");
  assert.ok(embeddedSource.includes("currentLiveClock"), "EmbeddedPlayer missing currentLiveClock");
  assert.ok(embeddedSource.includes("LIVE ·"), "EmbeddedPlayer missing live clock indicator");
});
