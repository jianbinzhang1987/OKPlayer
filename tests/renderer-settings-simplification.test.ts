import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/desktop/renderer/App.vue", import.meta.url);

test("ordinary settings hide technical runtime controls behind advanced settings", async () => {
  const source = await readFile(appPath, "utf8");
  const settingsIndex = source.indexOf("<section v-else-if=\"page === 'settings'\"");
  const advancedToggleIndex = source.indexOf("高级设置", settingsIndex);
  const advancedPanelIndex = source.indexOf('v-if="advancedSettingsOpen"', settingsIndex);
  const catVodIndex = source.indexOf("CatVod Node 服务", settingsIndex);
  const providerIndex = source.indexOf("替代 Provider 注册表", settingsIndex);
  const runtimeIndex = source.indexOf("当前运行环境", settingsIndex);

  assert.ok(settingsIndex >= 0);
  assert.ok(source.indexOf("界面显示", settingsIndex) < advancedToggleIndex);
  assert.ok(source.indexOf("播放偏好", settingsIndex) < advancedToggleIndex);
  assert.ok(source.indexOf("数据与隐私", settingsIndex) < advancedToggleIndex);
  assert.ok(advancedPanelIndex > advancedToggleIndex);
  assert.ok(catVodIndex > advancedPanelIndex);
  assert.ok(providerIndex > advancedPanelIndex);
  assert.ok(runtimeIndex > advancedPanelIndex);
  assert.ok(source.includes("仅用于故障排查"));
});

test("source configuration belongs to content sources rather than settings", async () => {
  const source = await readFile(appPath, "utf8");
  const sourcesIndex = source.indexOf("<section v-else-if=\"page === 'sources'\"");
  const settingsIndex = source.indexOf("<section v-else-if=\"page === 'settings'\"");
  const addConfigIndex = source.indexOf("添加内容配置");

  assert.ok(addConfigIndex > sourcesIndex && addConfigIndex < settingsIndex);
  assert.equal(source.match(/添加内容配置/g)?.length, 1);
  assert.ok(source.includes("名称（可选）"));
  assert.ok(source.includes("留空自动识别"));
  assert.ok(source.includes("检查并修复"));
});
