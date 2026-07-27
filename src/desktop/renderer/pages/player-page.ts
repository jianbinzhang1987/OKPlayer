export interface PlayerApi {
  resolve(siteKey: string, flag: string, url: string): Promise<unknown>;
}

export interface PlayerState {
  loading: boolean;
  media: unknown | null;
  error: string;
}

export async function resolvePlayer(
  api: PlayerApi,
  siteKey: string,
  flag: string,
  url: string,
): Promise<PlayerState> {
  if (!siteKey || !url) {
    return { loading: false, media: null, error: "缺少播放信息" };
  }

  try {
    const media = await api.resolve(siteKey, flag, url);
    return { loading: false, media, error: "" };
  } catch (error) {
    return {
      loading: false,
      media: null,
      error: error instanceof Error ? error.message : "播放解析失败",
    };
  }
}
