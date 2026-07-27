import assert from "node:assert/strict";
import test from "node:test";
import { StorageRepository } from "../src/core/storage.ts";

test("storage history and favorite lifecycle", () => {
  const storage = new StorageRepository();

  storage.saveHistory({
    siteKey: "demo",
    vodId: "1",
    vodName: "demo",
    episodeName: "第1集",
    episodeUrl: "url",
    position: 120,
    duration: 3600,
    updatedAt: 10,
  });

  storage.saveHistory({
    siteKey: "demo",
    vodId: "1",
    vodName: "demo",
    episodeName: "第1集",
    episodeUrl: "url",
    position: 600,
    duration: 3600,
    updatedAt: 20,
  });

  assert.equal(storage.getHistory("demo", "1", "第1集")?.position, 600);

  storage.saveFavorite({
    siteKey: "demo",
    vodId: "1",
    vodName: "demo",
    createdAt: 1,
  });

  assert.equal(storage.isFavorite("demo", "1"), true);
  storage.removeFavorite("demo", "1");
  assert.equal(storage.isFavorite("demo", "1"), false);
});
