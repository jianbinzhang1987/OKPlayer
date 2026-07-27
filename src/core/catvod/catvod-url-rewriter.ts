export const CATVOD_PROTOCOL_SCHEME = "fongmi-catvod";
export const CATVOD_PROTOCOL_ORIGIN = `${CATVOD_PROTOCOL_SCHEME}://service`;

export function rewriteCatVodUrl(value: string, baseUrl?: string): string {
  const source = value.trim();
  if (!source) return source;
  if (source.startsWith(`${CATVOD_PROTOCOL_ORIGIN}/`)) return source;
  if (source.startsWith("/")) return `${CATVOD_PROTOCOL_ORIGIN}${source}`;
  if (source === "js2p://_WEB_") return baseUrl ?? source;

  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (isLoopbackHost(url.hostname) && isCatVodProxyPath(url.pathname)) {
        return `${CATVOD_PROTOCOL_ORIGIN}${url.pathname}${url.search}${url.hash}`;
      }
    }
  } catch {
    return source;
  }
  return source;
}

export function resolveCatVodRuntimeUrl(value: string, baseUrl: string): string {
  const source = value.trim();
  if (!source) return source;
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  if (source.startsWith("/")) return `${normalizedBase}${source}`;
  if (source === "js2p://_WEB_") return normalizedBase;
  try {
    const url = new URL(source);
    if ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname) && isCatVodProxyPath(url.pathname)) {
      const target = new URL(normalizedBase);
      target.pathname = url.pathname;
      target.search = url.search;
      target.hash = url.hash;
      return target.toString();
    }
  } catch {
    return source;
  }
  return source;
}

export function restoreCatVodTarget(stableUrl: string, baseUrl: string): string {
  const url = new URL(stableUrl);
  if (url.protocol !== `${CATVOD_PROTOCOL_SCHEME}:`) throw new Error("不是有效的 CatVod 内部代理地址");
  const origin = new URL(baseUrl.replace(/\/+$/, ""));
  origin.pathname = url.pathname;
  origin.search = url.search;
  origin.hash = url.hash;
  return origin.toString();
}

export function rewriteCatVodPayload<T>(value: T, baseUrl?: string): T {
  return rewritePayload(value, baseUrl, true) as T;
}

function rewritePayload(value: unknown, baseUrl: string | undefined, rewriteString: boolean): unknown {
  if (typeof value === "string") return rewriteString ? rewriteCatVodUrl(value, baseUrl) : value;
  if (Array.isArray(value)) return value.map((item) => rewritePayload(item, baseUrl, false));
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRewriteField(key)) output[key] = rewriteFieldValue(item, baseUrl);
    else output[key] = rewritePayload(item, baseUrl, false);
  }
  return output;
}

function rewriteFieldValue(value: unknown, baseUrl?: string): unknown {
  if (typeof value === "string") return rewriteCatVodUrl(value, baseUrl);
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? rewriteCatVodUrl(item, baseUrl) : rewriteCatVodPayload(item, baseUrl));
  return rewriteCatVodPayload(value, baseUrl);
}

function shouldRewriteField(key: string): boolean {
  return /^(?:url|pic|vod_pic|poster|cover|image|subtitle|subt|danmaku|proxy|playUrl)$/i.test(key);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function isCatVodProxyPath(pathname: string): boolean {
  return /^\/(?:imageProxy|proxy|lrcproxy|danmu|website|spider\/[^/]+\/(?:proxy|lrcproxy))\b/i.test(pathname);
}
