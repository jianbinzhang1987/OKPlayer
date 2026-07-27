import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { FavoriteRecord, HistoryRecord } from "./storage.ts";
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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
    if (this.recoveryInfo.state !== "none") this.setSetting("storageRecoveryNotice", this.recoveryInfo);
  }

  private ensureHistoryColumns(): void {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(histories)").all().map((row: any) => String(row.name)),
    );
    if (!columns.has("flag")) this.db.exec("ALTER TABLE histories ADD COLUMN flag TEXT");
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
