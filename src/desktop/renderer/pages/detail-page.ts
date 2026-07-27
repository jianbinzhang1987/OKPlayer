export interface DetailApi {
  detail(siteKey: string, vodId: string): Promise<unknown>;
}

export interface DetailState {
  loading: boolean;
  detail: unknown | null;
  error: string;
}

export async function loadDetail(api: DetailApi, siteKey: string, vodId: string): Promise<DetailState> {
  if (!siteKey || !vodId) {
    return { loading: false, detail: null, error: "缺少影片信息" };
  }

  try {
    const detail = await api.detail(siteKey, vodId);
    return { loading: false, detail, error: "" };
  } catch (error) {
    return {
      loading: false,
      detail: null,
      error: error instanceof Error ? error.message : "详情加载失败",
    };
  }
}
