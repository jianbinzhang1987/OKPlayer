import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { FavoriteRecord, HistoryRecord } from "./storage.ts";
import type {
  LiveCatchupHistoryRecord,
  LiveFavoriteRecord,
  LiveLineHealth,
  LiveLineQualityRecord,
  LivePlaybackFeedback,
  LiveRecentRecord,
} from "./live/live-models.ts";
import type { LiveEpgGuide, LiveEpgMapping } from "./live/epg-models.ts";
import type { SourceQualityRecord } from "./source-quality.ts";

export interface ConfigRecord {
  id?: number;
  name: string;
  url: string;
  enabled: boolean;
  updatedAt: number;
}

export interface StorageRecoveryInfo {
  state: "none" | "restored-backup" | "reset-empty";
  message: string;
  archivedPath?: string;
  backupPath?: string;
  recoveredAt?: number;
}

const DATABASE_BACKUP_RETENTION = 3;

export class SqliteStorage {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;
  private closed = false;
  readonly recoveryInfo: StorageRecoveryInfo;

  constructor(databasePath = ":memory:") {
    this.databasePath = databasePath;
    const opened = openResilientDatabase(databasePath);
    this.db = opened.db;
    this.recoveryInfo = opened.recovery;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS histories (
        site_key TEXT NOT NULL,
        vod_id TEXT NOT NULL,
        vod_name TEXT NOT NULL,
        episode_name TEXT NOT NULL,
        episode_url TEXT NOT NULL,
        flag TEXT,
        position REAL NOT NULL,
        duration REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (site_key, vod_id, episode_name)
      );
      CREATE TABLE IF NOT EXISTS favorites (
        site_key TEXT NOT NULL,
        vod_id TEXT NOT NULL,
        vod_name TEXT NOT NULL,
        vod_pic TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (site_key, vod_id)
      );
      CREATE TABLE IF NOT EXISTS live_favorites (
        source_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        logo TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS live_recent_channels (
        source_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        line_id TEXT,
        watched_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS live_catchup_history (
        source_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        programme_start_at INTEGER NOT NULL,
        programme_end_at INTEGER NOT NULL,
        programme_title TEXT NOT NULL,
        position REAL NOT NULL,
        duration REAL NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, channel_id, programme_start_at)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS live_epg_cache (
        source_id TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        guide_json TEXT NOT NULL,
        loaded_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS live_epg_mappings (
        source_id TEXT NOT NULL,
        live_channel_id TEXT NOT NULL,
        epg_channel_id TEXT NOT NULL,
        epg_channel_name TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, live_channel_id)
      );
      CREATE TABLE IF NOT EXISTS live_line_quality (
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
        buffering_count INTEGER NOT NULL DEFAULT 0,
        buffering_duration_ms INTEGER NOT NULL DEFAULT 0,
        failover_success_count INTEGER NOT NULL DEFAULT 0,
        failover_failure_count INTEGER NOT NULL DEFAULT 0,
        startup_samples INTEGER NOT NULL DEFAULT 0,
        startup_total_ms INTEGER NOT NULL DEFAULT 0,
        last_startup_ms INTEGER,
        last_playback_at INTEGER NOT NULL DEFAULT 0,
        last_failure_at INTEGER NOT NULL DEFAULT 0,
        last_failure_reason TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, channel_id, line_id)
      );
      CREATE TABLE IF NOT EXISTS source_quality (
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
    this.ensureHistoryColumns();
    this.ensureSourceQualityColumns();
    this.ensureLiveLineQualityColumns();
    if (this.recoveryInfo.state !== "none") this.setSetting("storageRecoveryNotice", this.recoveryInfo);
  }

  private ensureHistoryColumns(): void {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(histories)").all().map((row: any) => String(row.name)),
    );
    if (!columns.has("flag")) this.db.exec("ALTER TABLE histories ADD COLUMN flag TEXT");
  }

  private ensureLiveLineQualityColumns(): void {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(live_line_quality)").all().map((row: any) => String(row.name)),
    );
    const additions: Array<[string, string]> = [
      ["buffering_count", "INTEGER NOT NULL DEFAULT 0"],
      ["buffering_duration_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["failover_success_count", "INTEGER NOT NULL DEFAULT 0"],
      ["failover_failure_count", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE live_line_quality ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureSourceQualityColumns(): void {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(source_quality)").all().map((row: any) => String(row.name)),
    );
    const additions: Array<[string, string]> = [
      ["last_success_at", "INTEGER NOT NULL DEFAULT 0"],
      ["last_failure_at", "INTEGER NOT NULL DEFAULT 0"],
      ["last_search_success_at", "INTEGER NOT NULL DEFAULT 0"],
      ["search_success_count", "INTEGER NOT NULL DEFAULT 0"],
      ["search_failure_count", "INTEGER NOT NULL DEFAULT 0"],
      ["last_media_success_at", "INTEGER NOT NULL DEFAULT 0"],
      ["media_success_count", "INTEGER NOT NULL DEFAULT 0"],
      ["media_failure_count", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE source_quality ADD COLUMN ${name} ${definition}`);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.databasePath === ":memory:") {
      this.db.close();
      return;
    }
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Close the database even if a checkpoint cannot be completed.
    }
    this.db.close();
    createDatabaseBackup(this.databasePath);
  }

  saveConfig(record: ConfigRecord) {
    this.db.prepare(`
      INSERT INTO configs(name, url, enabled, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        name=excluded.name,
        enabled=excluded.enabled,
        updated_at=excluded.updated_at
    `).run(record.name, record.url, record.enabled ? 1 : 0, record.updatedAt);
  }

  listConfigs(): ConfigRecord[] {
    return this.db.prepare("SELECT id, name, url, enabled, updated_at FROM configs ORDER BY enabled DESC, updated_at DESC").all().map((row: any) => ({
      id: Number(row.id),
      name: String(row.name),
      url: String(row.url),
      enabled: Number(row.enabled) === 1,
      updatedAt: Number(row.updated_at),
    }));
  }

  setActiveConfig(url: string) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE configs SET enabled=0").run();
      this.db.prepare("UPDATE configs SET enabled=1 WHERE url=?").run(url);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renameConfig(url: string, name: string) {
    const value = name.trim();
    if (!value) throw new Error("配置名称不能为空");
    this.db.prepare("UPDATE configs SET name=?, updated_at=? WHERE url=?").run(value, Date.now(), url);
  }

  deleteConfig(url: string) {
    this.db.prepare("DELETE FROM configs WHERE url=?").run(url);
  }

  saveHistory(record: HistoryRecord) {
    this.db.prepare(`
      INSERT INTO histories(site_key, vod_id, vod_name, episode_name, episode_url, flag, position, duration, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site_key, vod_id, episode_name) DO UPDATE SET
        vod_name=excluded.vod_name,
        episode_url=excluded.episode_url,
        flag=excluded.flag,
        position=excluded.position,
        duration=excluded.duration,
        updated_at=excluded.updated_at
    `).run(record.siteKey, record.vodId, record.vodName, record.episodeName, record.episodeUrl, record.flag ?? null, record.position, record.duration, record.updatedAt);
  }

  listHistory(): HistoryRecord[] {
    return this.db.prepare("SELECT * FROM histories ORDER BY updated_at DESC").all().map((row: any) => ({
      siteKey: String(row.site_key),
      vodId: String(row.vod_id),
      vodName: String(row.vod_name),
      episodeName: String(row.episode_name),
      episodeUrl: String(row.episode_url),
      flag: row.flag === null || row.flag === undefined ? undefined : String(row.flag),
      position: Number(row.position),
      duration: Number(row.duration),
      updatedAt: Number(row.updated_at),
    }));
  }

  removeHistory(siteKey: string, vodId: string, episodeName: string) {
    this.db.prepare("DELETE FROM histories WHERE site_key=? AND vod_id=? AND episode_name=?").run(siteKey, vodId, episodeName);
  }

  clearHistory() {
    this.db.prepare("DELETE FROM histories").run();
  }

  saveFavorite(record: FavoriteRecord) {
    this.db.prepare(`
      INSERT INTO favorites(site_key, vod_id, vod_name, vod_pic, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(site_key, vod_id) DO UPDATE SET
        vod_name=excluded.vod_name,
        vod_pic=excluded.vod_pic,
        created_at=excluded.created_at
    `).run(record.siteKey, record.vodId, record.vodName, record.vodPic ?? null, record.createdAt);
  }

  removeFavorite(siteKey: string, vodId: string) {
    this.db.prepare("DELETE FROM favorites WHERE site_key=? AND vod_id=?").run(siteKey, vodId);
  }

  isFavorite(siteKey: string, vodId: string) {
    return this.db.prepare("SELECT 1 AS found FROM favorites WHERE site_key=? AND vod_id=?").get(siteKey, vodId) !== undefined;
  }

  listFavorites(): FavoriteRecord[] {
    return this.db.prepare("SELECT * FROM favorites ORDER BY created_at DESC").all().map((row: any) => ({
      siteKey: String(row.site_key),
      vodId: String(row.vod_id),
      vodName: String(row.vod_name),
      vodPic: row.vod_pic === null ? undefined : String(row.vod_pic),
      createdAt: Number(row.created_at),
    }));
  }

  saveLiveFavorite(record: LiveFavoriteRecord) {
    this.db.prepare(`
      INSERT INTO live_favorites(source_id, channel_id, channel_name, logo, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, channel_id) DO UPDATE SET
        channel_name=excluded.channel_name,
        logo=excluded.logo,
        created_at=excluded.created_at
    `).run(record.sourceId, record.channelId, record.channelName, record.logo ?? null, record.createdAt);
  }

  removeLiveFavorite(sourceId: string, channelId: string) {
    this.db.prepare("DELETE FROM live_favorites WHERE source_id=? AND channel_id=?").run(sourceId, channelId);
  }

  listLiveFavorites(): LiveFavoriteRecord[] {
    return this.db.prepare("SELECT * FROM live_favorites ORDER BY created_at DESC").all().map((row: any) => ({
      sourceId: String(row.source_id),
      channelId: String(row.channel_id),
      channelName: String(row.channel_name),
      logo: row.logo === null ? undefined : String(row.logo),
      createdAt: Number(row.created_at),
    }));
  }

  saveLiveRecent(record: LiveRecentRecord) {
    this.db.prepare(`
      INSERT INTO live_recent_channels(source_id, channel_id, channel_name, line_id, watched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, channel_id) DO UPDATE SET
        channel_name=excluded.channel_name,
        line_id=excluded.line_id,
        watched_at=excluded.watched_at
    `).run(record.sourceId, record.channelId, record.channelName, record.lineId ?? null, record.watchedAt);
  }

  listLiveRecent(limit = 50): LiveRecentRecord[] {
    const normalizedLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    return this.db.prepare("SELECT * FROM live_recent_channels ORDER BY watched_at DESC LIMIT ?").all(normalizedLimit).map((row: any) => ({
      sourceId: String(row.source_id),
      channelId: String(row.channel_id),
      channelName: String(row.channel_name),
      lineId: row.line_id === null ? undefined : String(row.line_id),
      watchedAt: Number(row.watched_at),
    }));
  }

  saveLiveCatchupHistory(record: LiveCatchupHistoryRecord): void {
    this.db.prepare(`
      INSERT INTO live_catchup_history(
        source_id, channel_id, programme_start_at, programme_end_at,
        programme_title, position, duration, completed, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, channel_id, programme_start_at) DO UPDATE SET
        programme_end_at=excluded.programme_end_at,
        programme_title=excluded.programme_title,
        position=excluded.position,
        duration=excluded.duration,
        completed=excluded.completed,
        updated_at=excluded.updated_at
    `).run(
      record.sourceId,
      record.channelId,
      record.programmeStartAt,
      record.programmeEndAt,
      record.programmeTitle,
      record.position,
      record.duration,
      record.completed ? 1 : 0,
      record.updatedAt,
    );
  }

  getLiveCatchupHistory(sourceId: string, channelId: string, programmeStartAt: number): LiveCatchupHistoryRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM live_catchup_history
      WHERE source_id=? AND channel_id=? AND programme_start_at=?
    `).get(sourceId, channelId, programmeStartAt) as any;
    if (!row) return undefined;
    return {
      sourceId: String(row.source_id),
      channelId: String(row.channel_id),
      programmeStartAt: Number(row.programme_start_at),
      programmeEndAt: Number(row.programme_end_at),
      programmeTitle: String(row.programme_title),
      position: Number(row.position),
      duration: Number(row.duration),
      completed: Boolean(row.completed),
      updatedAt: Number(row.updated_at),
    };
  }

  removeLiveCatchupHistory(sourceId: string, channelId: string, programmeStartAt: number): void {
    this.db.prepare(`
      DELETE FROM live_catchup_history
      WHERE source_id=? AND channel_id=? AND programme_start_at=?
    `).run(sourceId, channelId, programmeStartAt);
  }

  getLiveLineQuality(sourceId: string, channelId: string, lineId: string): LiveLineQualityRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM live_line_quality
      WHERE source_id=? AND channel_id=? AND line_id=?
    `).get(sourceId, channelId, lineId) as any;
    return row ? mapLiveLineQualityRow(row) : undefined;
  }

  listLiveLineQuality(sourceId: string, channelId?: string): LiveLineQualityRecord[] {
    const rows = channelId
      ? this.db.prepare("SELECT * FROM live_line_quality WHERE source_id=? AND channel_id=? ORDER BY score DESC, updated_at DESC").all(sourceId, channelId)
      : this.db.prepare("SELECT * FROM live_line_quality WHERE source_id=? ORDER BY score DESC, updated_at DESC").all(sourceId);
    return rows.map((row: any) => mapLiveLineQualityRow(row));
  }

  saveLiveLineProbe(
    sourceId: string,
    channelId: string,
    lineId: string,
    lineName: string,
    health: LiveLineHealth,
  ): LiveLineQualityRecord {
    const existing = this.getLiveLineQuality(sourceId, channelId, lineId)
      ?? emptyLiveLineQuality(sourceId, channelId, lineId, lineName, health.checkedAt);
    const next = recalculateLiveLineQuality({
      ...existing,
      lineName: lineName || existing.lineName,
      probeState: health.state,
      probeScore: clampInteger(health.score, 0, 100),
      ...(Number.isFinite(health.latencyMs) ? { probeLatencyMs: Math.max(0, Math.round(Number(health.latencyMs))) } : { probeLatencyMs: undefined }),
      ...(health.resolution ? { resolution: health.resolution } : { resolution: undefined }),
      ...(Number.isFinite(health.bandwidthKbps) ? { bandwidthKbps: Math.max(0, Math.round(Number(health.bandwidthKbps))) } : { bandwidthKbps: undefined }),
      ...(typeof health.segmentVerified === "boolean" ? { segmentVerified: health.segmentVerified } : { segmentVerified: undefined }),
      ...(health.reason ? { probeReason: health.reason.slice(0, 500) } : { probeReason: undefined }),
      lastProbeAt: Math.max(0, Math.round(health.checkedAt || Date.now())),
      updatedAt: Date.now(),
    });
    this.persistLiveLineQuality(next);
    return next;
  }

  recordLiveLinePlayback(feedback: LivePlaybackFeedback): LiveLineQualityRecord {
    const occurredAt = Math.max(0, Math.round(feedback.occurredAt || Date.now()));
    const existing = this.getLiveLineQuality(feedback.sourceId, feedback.channelId, feedback.lineId)
      ?? emptyLiveLineQuality(feedback.sourceId, feedback.channelId, feedback.lineId, feedback.lineName ?? "直播线路", occurredAt);
    let next: LiveLineQualityRecord = {
      ...existing,
      lineName: feedback.lineName || existing.lineName,
      lastPlaybackAt: occurredAt,
      updatedAt: occurredAt,
    };
    if (feedback.kind === "started") {
      const startupMs = clampInteger(feedback.startupMs ?? 0, 0, 120_000);
      if (startupMs > 0) {
        next = {
          ...next,
          startupSamples: next.startupSamples + 1,
          startupTotalMs: next.startupTotalMs + startupMs,
          lastStartupMs: startupMs,
        };
      }
    } else if (feedback.kind === "stable") {
      next = {
        ...next,
        playbackSuccessCount: next.playbackSuccessCount + 1,
        stablePlaybackSeconds: next.stablePlaybackSeconds + clampInteger(feedback.playedSeconds ?? 0, 0, 24 * 60 * 60),
      };
    } else if (feedback.kind === "buffering") {
      next = {
        ...next,
        bufferingCount: next.bufferingCount + clampInteger(feedback.bufferingCount ?? 1, 1, 100),
        bufferingDurationMs: next.bufferingDurationMs + clampInteger(feedback.bufferingDurationMs ?? 0, 0, 10 * 60 * 1_000),
      };
    } else if (feedback.kind === "failover-success") {
      next = { ...next, failoverSuccessCount: next.failoverSuccessCount + 1 };
    } else if (feedback.kind === "failover-failure") {
      next = { ...next, failoverFailureCount: next.failoverFailureCount + 1 };
    } else {
      next = {
        ...next,
        playbackFailureCount: next.playbackFailureCount + 1,
        lastFailureAt: occurredAt,
        lastFailureReason: String(feedback.reason ?? "直播播放失败").slice(0, 500),
      };
    }
    next = recalculateLiveLineQuality(next);
    this.persistLiveLineQuality(next);
    return next;
  }

  clearLiveLineQuality(sourceId?: string): void {
    if (sourceId) this.db.prepare("DELETE FROM live_line_quality WHERE source_id=?").run(sourceId);
    else this.db.prepare("DELETE FROM live_line_quality").run();
  }

  private persistLiveLineQuality(record: LiveLineQualityRecord): void {
    this.db.prepare(`
      INSERT INTO live_line_quality(
        source_id, channel_id, line_id, line_name, state, score,
        probe_state, probe_score, probe_latency_ms, resolution, bandwidth_kbps,
        segment_verified, probe_reason, last_probe_at, playback_success_count,
        playback_failure_count, stable_playback_seconds, buffering_count,
        buffering_duration_ms, failover_success_count, failover_failure_count,
        startup_samples, startup_total_ms, last_startup_ms, last_playback_at,
        last_failure_at, last_failure_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, channel_id, line_id) DO UPDATE SET
        line_name=excluded.line_name,
        state=excluded.state,
        score=excluded.score,
        probe_state=excluded.probe_state,
        probe_score=excluded.probe_score,
        probe_latency_ms=excluded.probe_latency_ms,
        resolution=excluded.resolution,
        bandwidth_kbps=excluded.bandwidth_kbps,
        segment_verified=excluded.segment_verified,
        probe_reason=excluded.probe_reason,
        last_probe_at=excluded.last_probe_at,
        playback_success_count=excluded.playback_success_count,
        playback_failure_count=excluded.playback_failure_count,
        stable_playback_seconds=excluded.stable_playback_seconds,
        buffering_count=excluded.buffering_count,
        buffering_duration_ms=excluded.buffering_duration_ms,
        failover_success_count=excluded.failover_success_count,
        failover_failure_count=excluded.failover_failure_count,
        startup_samples=excluded.startup_samples,
        startup_total_ms=excluded.startup_total_ms,
        last_startup_ms=excluded.last_startup_ms,
        last_playback_at=excluded.last_playback_at,
        last_failure_at=excluded.last_failure_at,
        last_failure_reason=excluded.last_failure_reason,
        updated_at=excluded.updated_at
    `).run(
      record.sourceId,
      record.channelId,
      record.lineId,
      record.lineName,
      record.state,
      record.score,
      record.probeState,
      record.probeScore,
      record.probeLatencyMs ?? null,
      record.resolution ?? null,
      record.bandwidthKbps ?? null,
      record.segmentVerified === undefined ? null : record.segmentVerified ? 1 : 0,
      record.probeReason ?? null,
      record.lastProbeAt,
      record.playbackSuccessCount,
      record.playbackFailureCount,
      record.stablePlaybackSeconds,
      record.bufferingCount,
      record.bufferingDurationMs,
      record.failoverSuccessCount,
      record.failoverFailureCount,
      record.startupSamples,
      record.startupTotalMs,
      record.lastStartupMs ?? null,
      record.lastPlaybackAt,
      record.lastFailureAt,
      record.lastFailureReason ?? null,
      record.updatedAt,
    );
  }

  saveSourceQuality(record: SourceQualityRecord) {
    this.db.prepare(`
      INSERT INTO source_quality(
        config_source, site_key, fingerprint, state, stage, reason,
        latency_ms, checked_at, failure_count, success_count,
        last_success_at, last_failure_at, last_search_success_at,
        search_success_count, search_failure_count, last_media_success_at,
        media_success_count, media_failure_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_source, site_key) DO UPDATE SET
        fingerprint=excluded.fingerprint,
        state=excluded.state,
        stage=excluded.stage,
        reason=excluded.reason,
        latency_ms=excluded.latency_ms,
        checked_at=excluded.checked_at,
        failure_count=excluded.failure_count,
        success_count=excluded.success_count,
        last_success_at=excluded.last_success_at,
        last_failure_at=excluded.last_failure_at,
        last_search_success_at=excluded.last_search_success_at,
        search_success_count=excluded.search_success_count,
        search_failure_count=excluded.search_failure_count,
        last_media_success_at=excluded.last_media_success_at,
        media_success_count=excluded.media_success_count,
        media_failure_count=excluded.media_failure_count
    `).run(
      record.configSource,
      record.siteKey,
      record.fingerprint,
      record.state,
      record.stage,
      record.reason,
      record.latencyMs,
      record.checkedAt,
      record.failureCount,
      record.successCount,
      record.lastSuccessAt ?? 0,
      record.lastFailureAt ?? 0,
      record.lastSearchSuccessAt ?? 0,
      record.searchSuccessCount ?? 0,
      record.searchFailureCount ?? 0,
      record.lastMediaSuccessAt ?? 0,
      record.mediaSuccessCount ?? 0,
      record.mediaFailureCount ?? 0,
    );
  }

  getSourceQuality(configSource: string, siteKey: string): SourceQualityRecord | undefined {
    const row = this.db.prepare("SELECT * FROM source_quality WHERE config_source=? AND site_key=?").get(configSource, siteKey) as any;
    return row === undefined ? undefined : mapSourceQualityRow(row);
  }

  listSourceQuality(configSource: string): SourceQualityRecord[] {
    return this.db.prepare("SELECT * FROM source_quality WHERE config_source=? ORDER BY checked_at DESC").all(configSource)
      .map((row: any) => mapSourceQualityRow(row));
  }

  clearSourceQuality(configSource?: string) {
    if (configSource) {
      this.db.prepare("DELETE FROM source_quality WHERE config_source=?").run(configSource);
      return;
    }
    this.db.prepare("DELETE FROM source_quality").run();
  }

  getLiveEpgCache(sourceId: string): { identity: string; guide: LiveEpgGuide; expiresAt: number } | undefined {
    const row = this.db.prepare("SELECT identity, guide_json, expires_at FROM live_epg_cache WHERE source_id=?").get(sourceId) as {
      identity: string;
      guide_json: string;
      expires_at: number;
    } | undefined;
    if (!row) return undefined;
    try {
      return {
        identity: row.identity,
        guide: JSON.parse(row.guide_json) as LiveEpgGuide,
        expiresAt: Number(row.expires_at),
      };
    } catch {
      this.deleteLiveEpgCache(sourceId);
      return undefined;
    }
  }

  saveLiveEpgCache(sourceId: string, identity: string, guide: LiveEpgGuide): void {
    this.db.prepare(`
      INSERT INTO live_epg_cache(source_id, identity, guide_json, loaded_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        identity=excluded.identity,
        guide_json=excluded.guide_json,
        loaded_at=excluded.loaded_at,
        expires_at=excluded.expires_at
    `).run(sourceId, identity, JSON.stringify(guide), guide.loadedAt, guide.expiresAt);
  }

  deleteLiveEpgCache(sourceId: string): void {
    this.db.prepare("DELETE FROM live_epg_cache WHERE source_id=?").run(sourceId);
  }

  listLiveEpgMappings(sourceId: string): LiveEpgMapping[] {
    return this.db.prepare("SELECT * FROM live_epg_mappings WHERE source_id=? ORDER BY updated_at DESC").all(sourceId)
      .map((row: any) => ({
        sourceId: String(row.source_id),
        liveChannelId: String(row.live_channel_id),
        epgChannelId: String(row.epg_channel_id),
        ...(row.epg_channel_name ? { epgChannelName: String(row.epg_channel_name) } : {}),
        updatedAt: Number(row.updated_at),
      }));
  }

  saveLiveEpgMapping(mapping: LiveEpgMapping): void {
    this.db.prepare(`
      INSERT INTO live_epg_mappings(source_id, live_channel_id, epg_channel_id, epg_channel_name, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, live_channel_id) DO UPDATE SET
        epg_channel_id=excluded.epg_channel_id,
        epg_channel_name=excluded.epg_channel_name,
        updated_at=excluded.updated_at
    `).run(
      mapping.sourceId,
      mapping.liveChannelId,
      mapping.epgChannelId,
      mapping.epgChannelName ?? null,
      mapping.updatedAt,
    );
  }

  removeLiveEpgMapping(sourceId: string, liveChannelId: string): void {
    this.db.prepare("DELETE FROM live_epg_mappings WHERE source_id=? AND live_channel_id=?").run(sourceId, liveChannelId);
  }

  setSetting(key: string, value: unknown) {
    this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value));
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
    if (row === undefined) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
  }
}

function openResilientDatabase(databasePath: string): { db: DatabaseSync; recovery: StorageRecoveryInfo } {
  if (databasePath === ":memory:") {
    return { db: new DatabaseSync(databasePath), recovery: { state: "none", message: "内存数据库" } };
  }

  mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!existsSync(databasePath)) {
    return { db: new DatabaseSync(databasePath), recovery: { state: "none", message: "数据库正常" } };
  }

  try {
    return { db: openValidatedDatabase(databasePath), recovery: { state: "none", message: "数据库正常" } };
  } catch (error) {
    const archivedPath = archiveCorruptDatabase(databasePath);
    for (const backupPath of listDatabaseBackups(databasePath)) {
      try {
        copyFileSync(backupPath, databasePath);
        const db = openValidatedDatabase(databasePath);
        return {
          db,
          recovery: {
            state: "restored-backup",
            message: "检测到数据库损坏，已从最近有效备份恢复",
            archivedPath,
            backupPath,
            recoveredAt: Date.now(),
          },
        };
      } catch {
        try { if (existsSync(databasePath)) unlinkSync(databasePath); } catch { /* continue to the next backup */ }
      }
    }

    const db = new DatabaseSync(databasePath);
    return {
      db,
      recovery: {
        state: "reset-empty",
        message: `检测到数据库损坏且没有可用备份，原文件已归档：${error instanceof Error ? error.message : String(error)}`,
        archivedPath,
        recoveredAt: Date.now(),
      },
    };
  }
}

function openValidatedDatabase(databasePath: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath);
    const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (String(Object.values(row ?? {})[0] ?? "").toLowerCase() !== "ok") {
      throw new Error("SQLite quick_check 未通过");
    }
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* ignore close failures while recovering */ }
    throw error;
  }
}

function archiveCorruptDatabase(databasePath: string): string {
  const archivedPath = `${databasePath}.corrupt-${Date.now()}`;
  renameSync(databasePath, archivedPath);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${databasePath}${suffix}`;
    if (existsSync(source)) {
      try { renameSync(source, `${archivedPath}${suffix}`); } catch { /* keep the primary archive even if a sidecar cannot move */ }
    }
  }
  return archivedPath;
}

function databaseBackupDirectory(databasePath: string): string {
  return `${databasePath}.backups`;
}

function listDatabaseBackups(databasePath: string): string[] {
  const directory = databaseBackupDirectory(databasePath);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => path.join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function createDatabaseBackup(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  let validation: DatabaseSync | undefined;
  try {
    validation = openValidatedDatabase(databasePath);
    validation.close();
    validation = undefined;
    const directory = databaseBackupDirectory(databasePath);
    mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `backup-${Date.now()}.sqlite`);
    copyFileSync(databasePath, target);
    const backups = listDatabaseBackups(databasePath);
    for (const stale of backups.slice(DATABASE_BACKUP_RETENTION)) {
      try { unlinkSync(stale); } catch { /* retain an extra backup when deletion is unavailable */ }
    }
  } catch {
    try { validation?.close(); } catch { /* ignore */ }
  }
}

function mapLiveLineQualityRow(row: any): LiveLineQualityRecord {
  return {
    sourceId: String(row.source_id),
    channelId: String(row.channel_id),
    lineId: String(row.line_id),
    lineName: String(row.line_name),
    state: String(row.state) as LiveLineQualityRecord["state"],
    score: clampInteger(row.score, 0, 100),
    probeState: String(row.probe_state) as LiveLineQualityRecord["probeState"],
    probeScore: clampInteger(row.probe_score, 0, 100),
    ...(row.probe_latency_ms === null ? {} : { probeLatencyMs: Math.max(0, Number(row.probe_latency_ms)) }),
    ...(row.resolution === null ? {} : { resolution: String(row.resolution) }),
    ...(row.bandwidth_kbps === null ? {} : { bandwidthKbps: Math.max(0, Number(row.bandwidth_kbps)) }),
    ...(row.segment_verified === null ? {} : { segmentVerified: Boolean(row.segment_verified) }),
    ...(row.probe_reason === null ? {} : { probeReason: String(row.probe_reason) }),
    lastProbeAt: Math.max(0, Number(row.last_probe_at)),
    playbackSuccessCount: Math.max(0, Number(row.playback_success_count)),
    playbackFailureCount: Math.max(0, Number(row.playback_failure_count)),
    stablePlaybackSeconds: Math.max(0, Number(row.stable_playback_seconds)),
    bufferingCount: Math.max(0, Number(row.buffering_count ?? 0)),
    bufferingDurationMs: Math.max(0, Number(row.buffering_duration_ms ?? 0)),
    failoverSuccessCount: Math.max(0, Number(row.failover_success_count ?? 0)),
    failoverFailureCount: Math.max(0, Number(row.failover_failure_count ?? 0)),
    startupSamples: Math.max(0, Number(row.startup_samples)),
    startupTotalMs: Math.max(0, Number(row.startup_total_ms)),
    ...(row.last_startup_ms === null ? {} : { lastStartupMs: Math.max(0, Number(row.last_startup_ms)) }),
    lastPlaybackAt: Math.max(0, Number(row.last_playback_at)),
    lastFailureAt: Math.max(0, Number(row.last_failure_at)),
    ...(row.last_failure_reason === null ? {} : { lastFailureReason: String(row.last_failure_reason) }),
    updatedAt: Math.max(0, Number(row.updated_at)),
  };
}

function emptyLiveLineQuality(
  sourceId: string,
  channelId: string,
  lineId: string,
  lineName: string,
  now: number,
): LiveLineQualityRecord {
  return {
    sourceId,
    channelId,
    lineId,
    lineName,
    state: "unknown",
    score: 40,
    probeState: "unknown",
    probeScore: 40,
    lastProbeAt: 0,
    playbackSuccessCount: 0,
    playbackFailureCount: 0,
    stablePlaybackSeconds: 0,
    bufferingCount: 0,
    bufferingDurationMs: 0,
    failoverSuccessCount: 0,
    failoverFailureCount: 0,
    startupSamples: 0,
    startupTotalMs: 0,
    lastPlaybackAt: 0,
    lastFailureAt: 0,
    updatedAt: now,
  };
}

function recalculateLiveLineQuality(record: LiveLineQualityRecord): LiveLineQualityRecord {
  const now = Math.max(record.updatedAt, Date.now());
  const probeAge = record.lastProbeAt > 0 ? Math.max(0, now - record.lastProbeAt) : Number.POSITIVE_INFINITY;
  const probeFresh = probeAge <= 24 * 60 * 60 * 1_000;
  const probeBlocking = record.probeState === "unavailable"
    && probeAge <= 10 * 60 * 1_000
    && record.lastPlaybackAt <= record.lastProbeAt;
  let score = record.lastProbeAt > 0 ? record.probeScore : 40;
  if (!probeFresh) score = Math.max(25, Math.round(score * 0.65));

  if (record.startupSamples > 0) {
    const averageStartupMs = record.startupTotalMs / record.startupSamples;
    if (averageStartupMs <= 800) score += 9;
    else if (averageStartupMs <= 2_000) score += 6;
    else if (averageStartupMs <= 5_000) score += 2;
    else if (averageStartupMs >= 12_000) score -= 8;
    else if (averageStartupMs >= 8_000) score -= 4;
  }

  score += Math.min(12, record.playbackSuccessCount * 3);
  score += Math.min(10, Math.floor(record.stablePlaybackSeconds / 600));
  const bufferingSeconds = record.bufferingDurationMs / 1_000;
  const bufferingRatio = record.stablePlaybackSeconds > 0 ? bufferingSeconds / record.stablePlaybackSeconds : 0;
  score -= Math.min(16, record.bufferingCount * 2);
  score -= Math.min(18, Math.round(bufferingRatio * 30));
  score += Math.min(8, record.failoverSuccessCount * 2);
  score -= Math.min(12, record.failoverFailureCount * 4);
  score -= Math.min(30, record.playbackFailureCount * 6);
  if (record.lastFailureAt > 0 && now - record.lastFailureAt <= 60 * 60 * 1_000) score -= 12;
  if (record.lastPlaybackAt > record.lastFailureAt && record.playbackSuccessCount > 0) score += 4;
  score = clampInteger(score, 0, 100);

  let state: LiveLineQualityRecord["state"];
  if (probeBlocking) state = "unavailable";
  else if (score >= 60 || (record.probeState === "available" && probeFresh && score >= 45)) state = "available";
  else if (score >= 15 || record.probeState === "degraded") state = "degraded";
  else state = "unknown";
  return { ...record, state, score, updatedAt: now };
}

function clampInteger(value: unknown, minimum: number, maximum: number): number {
  const normalized = Math.round(Number(value) || 0);
  return Math.max(minimum, Math.min(maximum, normalized));
}

function mapSourceQualityRow(row: any): SourceQualityRecord {
  return {
    configSource: String(row.config_source),
    siteKey: String(row.site_key),
    fingerprint: String(row.fingerprint),
    state: String(row.state) as SourceQualityRecord["state"],
    stage: String(row.stage) as SourceQualityRecord["stage"],
    reason: String(row.reason),
    latencyMs: Number(row.latency_ms),
    checkedAt: Number(row.checked_at),
    failureCount: Number(row.failure_count),
    successCount: Number(row.success_count),
    lastSuccessAt: Number(row.last_success_at ?? 0),
    lastFailureAt: Number(row.last_failure_at ?? 0),
    lastSearchSuccessAt: Number(row.last_search_success_at ?? 0),
    searchSuccessCount: Number(row.search_success_count ?? 0),
    searchFailureCount: Number(row.search_failure_count ?? 0),
    lastMediaSuccessAt: Number(row.last_media_success_at ?? 0),
    mediaSuccessCount: Number(row.media_success_count ?? 0),
    mediaFailureCount: Number(row.media_failure_count ?? 0),
  };
}
