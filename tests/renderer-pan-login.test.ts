import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);
const preloadPath = new URL("../src/desktop/preload.ts", import.meta.url);
const ipcPath = new URL("../src/desktop/register-ipc.ts", import.meta.url);
const mainPath = new URL("../src/desktop/main.ts", import.meta.url);

test("renderer exposes multi-provider in-app pan login with automatic polling", async () => {
  const source = await readFile(appPath, "utf8");
  for (const marker of [
    'page === \'accounts\'',
    "账号与网盘",
    "PAN_PROVIDER_DEFINITIONS",
    "夸克网盘",
    "UC 网盘",
    "百度网盘",
    "115 网盘",
    "天翼云盘",
    "移动云盘",
    "ucCookie",
    "ucToken",
    "startPanLogin",
    "pollPanLogin",
    "schedulePanLoginPoll",
    "refreshPanStatus",
    "getPanStatuses",
    "accountState",
    "credentialMode",
    "panAccountStateLabel",
    "panCredentialModeLabel",
    "状态检查失败",
    "clearPanAccount",
    "清除凭据",
    "panLoginQrImage",
    "重新生成二维码",
    "扫码后无需点击任何确认按钮",
    "pendingPanPlayback",
    "playbackNeedsPanLogin",
    "detectPanPlaybackProvider",
    "登录成功，正在继续播放",
    "switchPendingPanPlaybackSource",
    "换一个来源",
    "excludeSiteKeys: pending.item.siteKey",
  ]) assert.ok(source.includes(marker), `missing account marker: ${marker}`);
  assert.doesNotMatch(source, /扫码后点我/);
  assert.doesNotMatch(source, /startQuarkLogin/);
  assert.match(source, /window\.setTimeout\(\(\) => void pollPanLogin\(\), 1500\)/);
  assert.match(source, /cancelPanLogin\(panLoginTaskId\.value\)/);
  assert.match(source, /await play\(pending\.flag, pending\.episode, pending\.startPosition\)/);
  assert.match(source, /pendingPanPlayback\.value = null/);
  assert.match(source, /await searchWithTargetSelection/);
});

test("isolated IPC exposes only fixed pan status and login operations", async () => {
  const [preload, ipc, main] = await Promise.all([
    readFile(preloadPath, "utf8"),
    readFile(ipcPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);
  for (const marker of ["getPanStatus", "getPanStatuses", "clearPanAccount", "startPanLogin", "pollPanLogin", "cancelPanLogin"]) {
    assert.ok(preload.includes(marker), `missing preload method: ${marker}`);
  }
  for (const channel of ["pan:status", "pan:status:all", "pan:clear", "pan:login:start", "pan:login:poll", "pan:login:cancel"]) {
    assert.ok(ipc.includes(channel), `missing IPC channel: ${channel}`);
  }
  assert.ok(main.includes("CatVodAccountService"));
  assert.ok(main.includes("catVodAccountService!.status"));
  assert.ok(main.includes("catVodAccountService!.statuses"));
  assert.ok(main.includes("catVodAccountService!.clear"));
  assert.ok(main.includes("catVodAccountService!.start"));
  assert.ok(main.includes("catVodAccountService!.poll"));
  assert.ok(main.includes("catVodAccountService!.cancel"));
  assert.ok(main.includes("catVodAccountService?.cancelAll()"));
  const beforeQuit = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf('app.on("window-all-closed"'));
  assert.ok(beforeQuit.includes("cancelAll"));
  assert.doesNotMatch(beforeQuit, /\.clear\(|account\/clear/);
  assert.ok(beforeQuit.includes("Persisted Cookie/Token credentials remain"));
});
