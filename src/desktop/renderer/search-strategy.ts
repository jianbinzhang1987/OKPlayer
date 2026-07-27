export type SearchScopePreference = "smart" | "current";
export type SearchBackendScope = "all-configs" | "current-site";

export interface SearchIdentityItem {
  vodId: string;
  vodName: string;
  vodYear?: string;
  siteName?: string;
  configName?: string;
}

export function resolveInitialSearchBackend(
  preference: SearchScopePreference,
  activeSite: string,
): SearchBackendScope {
  if (preference === "current") return "current-site";
  return activeSite.trim() ? "current-site" : "all-configs";
}

export function resolveContinuationSearchBackend(expandedToAllSources: boolean): SearchBackendScope {
  return expandedToAllSources ? "all-configs" : "current-site";
}

export function searchResultIdentity(item: SearchIdentityItem): string {
  return [item.configName, item.siteName, item.vodId, item.vodName, item.vodYear]
    .map((value) => String(value ?? "").trim().toLocaleLowerCase("zh-CN"))
    .join("\u0000");
}
