export interface DesktopApiContract {
  appInfo: () => Promise<{ name: string; version: string }>;
  configList: () => Promise<unknown[]>;
  search: (keyword: string) => Promise<unknown[]>;
  detail: (siteKey: string, vodId: string) => Promise<unknown>;
  resolvePlay: (siteKey: string, id: string) => Promise<unknown>;
}

export const IPC_CHANNELS = {
  APP_INFO: "app:info",
  CONFIG_LIST: "config:list",
  SEARCH: "vod:search",
  DETAIL: "vod:detail",
  RESOLVE: "player:resolve",
} as const;

export function validateKeyword(keyword: string): string {
  const value = keyword.trim();
  if (!value) {
    throw new Error("搜索关键词不能为空");
  }
  return value;
}
