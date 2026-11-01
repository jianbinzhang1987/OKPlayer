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

test("existing live line quality tables migrate buffering and failover metrics", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fongmi-live-quality-migration-"));
  const databasePath = path.join(dir, "tv.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE live_line_quality (
      source_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      line_name TEXT NOT NULL,
      state TEXT NOT NULL,
      score INTEGER NOT NULL,
      probe_state TEXT NOT NULL,
      probe_score INTEGER NOT NULL,
      probe_latency_ms INTEGER,
      resolution TEXT,
      bandwidth_kbps INTEGER,
      segment_verified INTEGER,
      probe_reason TEXT,
      last_probe_at INTEGER NOT NULL,
      playback_success_count INTEGER NOT NULL DEFAULT 0,
      playback_failure_count INTEGER NOT NULL DEFAULT 0,
      stable_playback_seconds INTEGER NOT NULL DEFAULT 0,
      startup_samples INTEGER NOT NULL DEFAULT 0,
      startup_total_ms INTEGER NOT NULL DEFAULT 0,
      last_startup_ms INTEGER,
      last_playback_at INTEGER NOT NULL DEFAULT 0,
      last_failure_at INTEGER NOT NULL DEFAULT 0,
      last_failure_reason TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, channel_id, line_id)
    );
  `);
  legacy.close();

  const storage = new SqliteStorage(databasePath);
  try {
    storage.recordLiveLinePlayback({
      sourceId: "live",
      channelId: "channel",
      lineId: "line",
      lineName: "线路",
      kind: "buffering",
      bufferingCount: 1,
      bufferingDurationMs: 2_500,
      occurredAt: Date.now(),
    });
    storage.recordLiveLinePlayback({
      sourceId: "live",
      channelId: "channel",
      lineId: "line",
      lineName: "线路",
      kind: "failover-success",
      occurredAt: Date.now(),
    });
    const record = storage.getLiveLineQuality("live", "channel", "line");
    assert.equal(record?.bufferingCount, 1);
    assert.equal(record?.bufferingDurationMs, 2_500);
    assert.equal(record?.failoverSuccessCount, 1);
    assert.equal(record?.failoverFailureCount, 0);
  } finally {
    storage.close();
  }
});
