export interface SearchItem {
  vodId: string;
  vodName: string;
  vodTag?: "file" | "folder" | "action" | string;
  vodPic?: string;
  vodRemarks?: string;
  siteName?: string;
}

export type ContentRoute = "detail" | "search" | "settings" | "folder" | "live-unsupported";

export interface DesktopState {
  keyword: string;
  results: SearchItem[];
  loading: boolean;
  current?: SearchItem;
}

export const createDesktopState = (): DesktopState => ({
  keyword: "",
  results: [],
  loading: false,
});

export function isFolderItem(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "vodTag" in value
    && (value as { vodTag?: string }).vodTag === "folder";
}

export function resolveContentRoute(value: unknown): ContentRoute {
  if (typeof value !== "object" || value === null) return "detail";
  const item = value as { contentKind?: string; vodTag?: string };
  if (item.contentKind === "discovery") return "search";
  if (item.contentKind === "action" || item.vodTag === "action") return "settings";
  if (item.contentKind === "live") return "live-unsupported";
  if (item.contentKind === "folder" || item.vodTag === "folder") return "folder";
  return "detail";
}
