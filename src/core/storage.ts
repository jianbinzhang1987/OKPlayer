export interface HistoryRecord {
  siteKey: string;
  vodId: string;
  vodName: string;
  episodeName: string;
  episodeUrl: string;
  flag?: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface FavoriteRecord {
  siteKey: string;
  vodId: string;
  vodName: string;
  vodPic?: string;
  createdAt: number;
}

/**
 * Storage abstraction.
 *
 * The production Electron version will bind this interface to SQLite.
 * The in-memory implementation is kept for core tests and CLI verification.
 */
export class StorageRepository {
  private histories = new Map<string, HistoryRecord>();
  private favorites = new Map<string, FavoriteRecord>();

  private key(siteKey: string, vodId: string, episodeName: string) {
    return `${siteKey}:${vodId}:${episodeName}`;
  }

  saveHistory(record: HistoryRecord) {
    this.histories.set(this.key(record.siteKey, record.vodId, record.episodeName), record);
  }

  getHistory(siteKey: string, vodId: string, episodeName: string) {
    return this.histories.get(this.key(siteKey, vodId, episodeName));
  }

  listHistory() {
    return [...this.histories.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  saveFavorite(record: FavoriteRecord) {
    this.favorites.set(`${record.siteKey}:${record.vodId}`, record);
  }

  removeFavorite(siteKey: string, vodId: string) {
    this.favorites.delete(`${siteKey}:${vodId}`);
  }

  isFavorite(siteKey: string, vodId: string) {
    return this.favorites.has(`${siteKey}:${vodId}`);
  }

  listFavorites() {
    return [...this.favorites.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
