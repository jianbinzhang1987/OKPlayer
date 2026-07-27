import assert from "node:assert/strict";
import test from "node:test";
import { HistoryPageController } from "../src/desktop/renderer/pages/history-page.ts";
import { SettingsPageController } from "../src/desktop/renderer/pages/settings-page.ts";

test("history page loads and removes favorites", async () => {
  const controller = new HistoryPageController({
    listHistory: async () => [{ siteKey: "s", vodId: "1", vodName: "影片", episodeName: "1", episodeUrl: "u", position: 1, duration: 10, updatedAt: 1 }],
    listFavorites: async () => [{ siteKey: "s", vodId: "1", vodName: "影片", createdAt: 1 }],
    removeFavorite: async () => undefined,
  });
  await controller.load();
  assert.equal(controller.state.history.length, 1);
  assert.equal(controller.state.favorites.length, 1);
  await controller.removeFavorite("s", "1");
  assert.equal(controller.state.favorites.length, 0);
});

test("settings page validates and persists config and speed", async () => {
  const configs: any[] = [];
  let speed = 1;
  const controller = new SettingsPageController({
    listConfigs: async () => [...configs],
    saveConfig: async (config) => { configs.push(config); },
    getSetting: async (_key, fallback) => speed ?? fallback,
    setSetting: async (_key, value) => { speed = Number(value); },
  });
  await controller.addConfig("测试", " https://example.com/config.json ");
  assert.equal(controller.state.configs[0]?.url, "https://example.com/config.json");
  await controller.setDefaultSpeed(1.5);
  assert.equal(controller.state.defaultSpeed, 1.5);
  await assert.rejects(() => controller.setDefaultSpeed(6), /播放速度范围/);
});
