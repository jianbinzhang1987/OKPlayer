import { createDesktopState } from "../app-model.ts";

export class SearchPageController {
  state = createDesktopState();

  async search(keyword: string) {
    const value = keyword.trim();
    if (!value) {
      this.state.results = [];
      return [];
    }

    this.state.keyword = value;
    this.state.loading = true;

    try {
      const api = (globalThis as any).tvApi;
      const result = await api.search(value);
      this.state.results = result ?? [];
      return this.state.results;
    } finally {
      this.state.loading = false;
    }
  }
}
