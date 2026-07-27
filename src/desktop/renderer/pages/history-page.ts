import type { FavoriteRecord, HistoryRecord } from "../../../core/storage.ts";

export interface HistoryApi {
  listHistory(): Promise<HistoryRecord[]>;
  listFavorites(): Promise<FavoriteRecord[]>;
  removeFavorite(siteKey: string, vodId: string): Promise<void>;
}

export interface HistoryPageState {
  loading: boolean;
  history: HistoryRecord[];
  favorites: FavoriteRecord[];
  error: string;
}

export class HistoryPageController {
  readonly state: HistoryPageState = { loading: false, history: [], favorites: [], error: "" };
  private readonly api: HistoryApi;

  constructor(api: HistoryApi) {
    this.api = api;
  }

  async load() {
    this.state.loading = true;
    this.state.error = "";
    try {
      const [history, favorites] = await Promise.all([this.api.listHistory(), this.api.listFavorites()]);
      this.state.history = history;
      this.state.favorites = favorites;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : "加载历史记录失败";
    } finally {
      this.state.loading = false;
    }
  }

  async removeFavorite(siteKey: string, vodId: string) {
    await this.api.removeFavorite(siteKey, vodId);
    this.state.favorites = this.state.favorites.filter((item) => item.siteKey !== siteKey || item.vodId !== vodId);
  }
}
