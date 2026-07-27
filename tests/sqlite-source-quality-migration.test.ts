import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteStorage } from "../src/core/sqlite-storage.ts";

test("existing source quality tables migrate to stage-specific metrics", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fongmi-quality-migration-"));
  const databasePath = path.join(dir, "tv.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE histories (
      site_key TEXT NOT NULL,
      vod_id TEXT NOT NULL,
      vod_name TEXT NOT NULL,
      episode_name TEXT NOT NULL,
      episode_url TEXT NOT NULL,
      position REAL NOT NULL,
      duration REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (site_key, vod_id, episode_name)
    );
    CREATE TABLE source_quality (
      config_source TEXT NOT NULL,
      site_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      stage TEXT NOT NULL,
      reason TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      checked_at INTEGER NOT NULL,
      failure_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (config_source, site_key)
    );
  `);
  legacy.close();

  const storage = new SqliteStorage(databasePath);
  try {
    storage.saveSourceQuality({
      configSource: "config",
      siteKey: "site",
      fingerprint: "fingerprint",
      state: "healthy",
      stage: "search",
      reason: "搜索成功",
      latencyMs: 500,
      checkedAt: 10,
      failureCount: 0,
      successCount: 1,
      lastSuccessAt: 10,
      lastSearchSuccessAt: 10,
      searchSuccessCount: 1,
    });
    storage.saveHistory({
      siteKey: "site",
      vodId: "vod",
      vodName: "影片",
      episodeName: "第1集",
      episodeUrl: "episode-token",
      flag: "夸克极速",
      position: 30,
      duration: 60,
      updatedAt: 10,
    });
    const record = storage.getSourceQuality("config", "site");
    assert.equal(record?.lastSuccessAt, 10);
    assert.equal(record?.lastSearchSuccessAt, 10);
    assert.equal(record?.searchSuccessCount, 1);
    assert.equal(record?.mediaSuccessCount, 0);
    assert.equal(storage.listHistory()[0]?.flag, "夸克极速");
  } finally {
    storage.close();
  }
});
