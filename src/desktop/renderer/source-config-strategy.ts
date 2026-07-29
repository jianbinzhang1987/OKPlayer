export function isCatVodBundleSource(source: string): boolean {
  const value = source.trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.pathname.toLowerCase().endsWith(".js.md5");
  } catch {
    return false;
  }
}

export function inferCatVodSourceLabel(source: string): string {
  const value = source.trim();
  if (!value) return "CatVod 服务源";
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./i, "");
    return hostname ? `CatVod · ${hostname}` : "CatVod 服务源";
  } catch {
    return "CatVod 服务源";
  }
}

export function selectCatVodSiteAfterImport(siteKeys: string[], previousActiveSite: string): string {
  const candidates = siteKeys.filter((key) => key.startsWith("catvod:"));
  if (candidates.length === 0) return "";
  return previousActiveSite.startsWith("catvod:") && candidates.includes(previousActiveSite)
    ? previousActiveSite
    : candidates[0]!;
}

export function selectConfigSiteAfterImport(siteKeys: string[], previousActiveSite: string): string {
  const candidates = siteKeys.filter((key) => !key.startsWith("catvod:"));
  if (candidates.length === 0) return "";
  return !previousActiveSite.startsWith("catvod:") && candidates.includes(previousActiveSite)
    ? previousActiveSite
    : candidates[0]!;
}

export function inferConfigName(source: string): string {
  const value = source.trim();
  if (!value) return "新配置";
  if (/^[A-Za-z]:[\\/]/.test(value)) return inferLocalConfigName(value);
  try {
    const url = new URL(value);
    const filename = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "")
      .replace(/\.(?:json|txt|js|md5)$/i, "");
    return filename || url.hostname.replace(/^www\./i, "") || "新配置";
  } catch {
    return inferLocalConfigName(value);
  }
}

function inferLocalConfigName(value: string): string {
  const filename = value.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return filename.replace(/\.(?:json|txt|js|md5)$/i, "") || "本地配置";
}
