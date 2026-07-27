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
