import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteStorage } from "../src/core/sqlite-storage.ts";

test("sqlite persists configs, history, favorites and settings", () => {
  const db = new SqliteStorage();
  db.saveConfig({ name: "测试源", url: "https://example.com/config.json", enabled: true, updatedAt: 1 });
  db.saveConfig({ name: "备用源", url: "https://example.com/backup.json", enabled: false, updatedAt: 2 });
  db.setActiveConfig("https://example.com/config.json");
  db.saveHistory({
    siteKey: "s",
    vodId: "1",
    vodName: "测试影片",
    episodeName: "第01集",
    episodeUrl: "https://example.com/1.m3u8",
    position: 10,
    duration: 100,
    updatedAt: 1,
  });
  db.saveHistory({
    siteKey: "s",
    vodId: "1",
    vodName: "测试影片",
    episodeName: "第01集",
    episodeUrl: "https://example.com/1.m3u8",
    position: 80,
    duration: 100,
    updatedAt: 2,
  });
  db.saveFavorite({ siteKey: "s", vodId: "1", vodName: "测试影片", createdAt: 1 });
  db.saveLiveFavorite({ sourceId: "live-source", channelId: "cctv1", channelName: "CCTV-1", createdAt: 4 });
  db.saveLiveRecent({ sourceId: "live-source", channelId: "cctv1", channelName: "CCTV-1", lineId: "line-1", watchedAt: 5 });
  db.saveLiveRecent({ sourceId: "live-source", channelId: "cctv1", channelName: "CCTV-1 综合", lineId: "line-2", watchedAt: 6 });
  db.saveLiveCatchupHistory({
    sourceId: "live-source",
    channelId: "cctv1",
    programmeStartAt: 1_754_132_400_000,
    programmeEndAt: 1_754_136_000_000,
    programmeTitle: "新闻联播",
    position: 620,
    duration: 1_800,
    completed: false,
    updatedAt: 7,
  });
  const probedLine = db.saveLiveLineProbe("live-source", "cctv1", "line-2", "线路 2", {
    state: "available",
    score: 80,
    checkedAt: Date.now(),
    latencyMs: 420,
    segmentVerified: true,
    reason: "清单和直播分片均验证通过",
  });
  assert.equal(probedLine.score, 80);
  db.recordLiveLinePlayback({ sourceId: "live-source", channelId: "cctv1", lineId: "line-2", lineName: "线路 2", kind: "started", startupMs: 650, occurredAt: Date.now() });
  db.recordLiveLinePlayback({ sourceId: "live-source", channelId: "cctv1", lineId: "line-2", lineName: "线路 2", kind: "stable", playedSeconds: 620, occurredAt: Date.now() });
  db.recordLiveLinePlayback({ sourceId: "live-source", channelId: "cctv1", lineId: "line-2", lineName: "线路 2", kind: "buffering", bufferingCount: 2, bufferingDurationMs: 4_500, occurredAt: Date.now() });
  db.recordLiveLinePlayback({ sourceId: "live-source", channelId: "cctv1", lineId: "line-2", lineName: "线路 2", kind: "failover-success", occurredAt: Date.now() });
  db.recordLiveLinePlayback({ sourceId: "live-source", channelId: "cctv1", lineId: "line-2", lineName: "线路 2", kind: "failover-failure", occurredAt: Date.now() });
  db.recordLiveLinePlayback({ sourceId: "live-source", channelId: "cctv1", lineId: "line-2", lineName: "线路 2", kind: "failure", reason: "连接中断", occurredAt: Date.now() });
  db.saveSourceQuality({
    configSource: "https://example.com/config.json",
    siteKey: "s",
    fingerprint: "fingerprint",
    state: "blocked",
    stage: "media",
    reason: "媒体地址检测失败：HTTP 404",
    latencyMs: 321,
    checkedAt: 3,
    failureCount: 1,
    successCount: 2,
    lastSuccessAt: 10,
    lastFailureAt: 20,
    lastSearchSuccessAt: 11,
    searchSuccessCount: 2,
    searchFailureCount: 1,
    lastMediaSuccessAt: 12,
    mediaSuccessCount: 1,
    mediaFailureCount: 1,
  });
  db.setSetting("speed", 1.5);

  assert.equal(db.listConfigs()[0]?.name, "测试源");
  assert.equal(db.listConfigs()[0]?.enabled, true);
  db.renameConfig("https://example.com/backup.json", "备用配置");
  assert.equal(db.listConfigs().find((item) => item.url.endsWith("backup.json"))?.name, "备用配置");
  assert.equal(db.listHistory()[0]?.position, 80);
  assert.equal(db.isFavorite("s", "1"), true);
  assert.equal(db.getSetting("speed", 1), 1.5);
  assert.equal(db.listLiveFavorites()[0]?.channelName, "CCTV-1");
  assert.equal(db.listLiveRecent()[0]?.channelName, "CCTV-1 综合");
  assert.equal(db.listLiveRecent()[0]?.lineId, "line-2");
  assert.equal(db.getLiveCatchupHistory("live-source", "cctv1", 1_754_132_400_000)?.position, 620);
  assert.equal(db.getLiveCatchupHistory("live-source", "cctv1", 1_754_132_400_000)?.completed, false);
  assert.equal(db.getLiveLineQuality("live-source", "cctv1", "line-2")?.playbackSuccessCount, 1);
  assert.equal(db.getLiveLineQuality("live-source", "cctv1", "line-2")?.playbackFailureCount, 1);
  assert.equal(db.getLiveLineQuality("live-source", "cctv1", "line-2")?.startupSamples, 1);
  assert.equal(db.getLiveLineQuality("live-source", "cctv1", "line-2")?.stablePlaybackSeconds, 620);
  assert.equal(db.getLiveLineQuality("live-source", "cctv1", "line-2")?.bufferingCount, 2);
  assert.equal(db.getLiveLineQuality("live-source", "cctv1", "line-2")?.bufferingDurationMs, 4_500);
  assert.equal(db.getLiveLineQuality("live-source", "cctv1", "line-2")?.failoverSuccessCount, 1);
  assert.equal(db.getLiveLineQuality("live-source", "cctv1", "line-2")?.failoverFailureCount, 1);
  assert.ok((db.getLiveLineQuality("live-source", "cctv1", "line-2")?.score ?? 0) > 35);
  assert.equal(db.getSourceQuality("https://example.com/config.json", "s")?.state, "blocked");
  assert.equal(db.getSourceQuality("https://example.com/config.json", "s")?.searchSuccessCount, 2);
  assert.equal(db.getSourceQuality("https://example.com/config.json", "s")?.lastMediaSuccessAt, 12);
  assert.equal(db.listSourceQuality("https://example.com/config.json")[0]?.reason, "媒体地址检测失败：HTTP 404");

  db.removeFavorite("s", "1");
  assert.equal(db.isFavorite("s", "1"), false);
  db.removeLiveFavorite("live-source", "cctv1");
  assert.equal(db.listLiveFavorites().length, 0);
  db.removeLiveCatchupHistory("live-source", "cctv1", 1_754_132_400_000);
  assert.equal(db.getLiveCatchupHistory("live-source", "cctv1", 1_754_132_400_000), undefined);
  db.removeHistory("s", "1", "第01集");
  assert.equal(db.listHistory().length, 0);
  db.deleteConfig("https://example.com/backup.json");
  assert.equal(db.listConfigs().length, 1);
  db.clearSourceQuality("https://example.com/config.json");
  assert.equal(db.listSourceQuality("https://example.com/config.json").length, 0);
  db.clearHistory();
  db.close();
});

test("sqlite archives a corrupt database and restores user data from the newest valid backup", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fongmi-sqlite-recovery-"));
  const databasePath = path.join(root, "desktop.sqlite");
  try {
    const original = new SqliteStorage(databasePath);
    original.saveConfig({ name: "恢复配置", url: "https://example.com/recovery.json", enabled: true, updatedAt: 10 });
    original.saveFavorite({ siteKey: "source", vodId: "vod-1", vodName: "恢复影片", createdAt: 11 });
    original.setSetting("theme", "dark");
    original.close();

    const backupDirectory = `${databasePath}.backups`;
    assert.ok(readdirSync(backupDirectory).some((name) => name.endsWith(".sqlite")));
    writeFileSync(databasePath, "this is not sqlite", "utf8");

    const restored = new SqliteStorage(databasePath);
    assert.equal(restored.recoveryInfo.state, "restored-backup");
    assert.equal(restored.listConfigs()[0]?.name, "恢复配置");
    assert.equal(restored.listFavorites()[0]?.vodName, "恢复影片");
    assert.equal(restored.getSetting("theme", "system"), "dark");
    assert.equal(restored.getSetting<any>("storageRecoveryNotice", null)?.state, "restored-backup");
    assert.ok(restored.recoveryInfo.archivedPath && existsSync(restored.recoveryInfo.archivedPath));
    restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite preserves an unrecoverable corrupt file and creates an explicit empty recovery state", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fongmi-sqlite-reset-"));
  const databasePath = path.join(root, "desktop.sqlite");
  try {
    writeFileSync(databasePath, "broken database without backup", "utf8");
    const recovered = new SqliteStorage(databasePath);
    assert.equal(recovered.recoveryInfo.state, "reset-empty");
    assert.equal(recovered.listConfigs().length, 0);
    assert.ok(recovered.recoveryInfo.archivedPath && existsSync(recovered.recoveryInfo.archivedPath));
    assert.equal(recovered.getSetting<any>("storageRecoveryNotice", null)?.state, "reset-empty");
    recovered.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
