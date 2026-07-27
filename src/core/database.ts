import type { Episode } from "./models.ts";

export interface HistoryRecord {
  siteKey: string;
  vodId: string;
  vodName: string;
  episode: Episode;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface FavoriteRecord {
  siteKey: string;
  vodId: string;
  vodName: string;
  createdAt: number;
}

export class MemoryRepository {
  private histories: HistoryRecord[] = [];
  private favorites: FavoriteRecord[] = [];

  saveHistory(item: HistoryRecord) {
    this.histories = this.histories.filter(
      (x) => !(x.siteKey === item.siteKey && x.vodId === item.vodId && x.episode.index === item.episode.index),
    );
    this.histories.unshift(item);
  }

  listHistory() {
    return [...this.histories];
  }

  addFavorite(item: FavoriteRecord) {
    if (!this.favorites.some((x) => x.siteKey === item.siteKey && x.vodId === item.vodId)) {
      this.favorites.push(item);
    }
  }

  listFavorite() {
    return [...this.favorites];
  }
}
