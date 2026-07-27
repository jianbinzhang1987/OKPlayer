import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository } from "../src/core/database.ts";

test("历史记录支持覆盖同一剧集并保存收藏", () => {
  const db = new MemoryRepository();
  db.saveHistory({
    siteKey: "a",
    vodId: "1",
    vodName: "测试",
    episode: { name: "第1集", url: "u", index: 0 },
    position: 10,
    duration: 100,
    updatedAt: Date.now(),
  });

  db.saveHistory({
    siteKey: "a",
    vodId: "1",
    vodName: "测试",
    episode: { name: "第1集", url: "u", index: 0 },
    position: 50,
    duration: 100,
    updatedAt: Date.now(),
  });

  assert.equal(db.listHistory().length, 1);
  assert.equal(db.listHistory()[0].position, 50);

  db.addFavorite({ siteKey: "a", vodId: "1", vodName: "测试", createdAt: 1 });
  assert.equal(db.listFavorite().length, 1);
});
