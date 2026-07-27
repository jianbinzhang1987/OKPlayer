import type { HeadersMap, ParseConfig, PlayerResult, ResolvedMedia } from "./models.ts";

function extractHeaders(payload: Record<string, unknown>, fallback: HeadersMap): HeadersMap {
  const headers = { ...fallback };
  for (const [key, value] of Object.entries(payload)) {
    const normalized = key.toLowerCase();
    if (["user-agent", "referer", "cookie", "ua"].includes(normalized) && typeof value === "string") {
      headers[normalized === "ua" ? "User-Agent" : key] = value;
    }
  }
  return headers;
}

function playerExtras(result: PlayerResult): Partial<ResolvedMedia> {
  return {
    ...(result.subtitleUrl ? { subtitleUrl: result.subtitleUrl } : {}),
    ...(result.danmakuUrl ? { danmakuUrl: result.danmakuUrl } : {}),
    ...(result.contentKind ? { contentKind: result.contentKind } : {}),
  };
}

function chooseJsonParser(parses: ParseConfig[], flag: string): ParseConfig | undefined {
  const jsonParsers = parses.filter((item) => item.type === 1);
  return jsonParsers.find((item) => item.ext?.flag?.includes(flag)) ?? jsonParsers[0];
}

export async function resolvePlayerResult(result: PlayerResult, parses: ParseConfig[], signal?: AbortSignal): Promise<ResolvedMedia> {
  if (result.parse === 0) {
    return {
      url: result.url,
      headers: { ...result.header },
      ...(result.format !== undefined ? { format: result.format } : {}),
      ...playerExtras(result),
      resolvedBy: "direct",
    };
  }

  if (result.playUrl !== "" && !result.playUrl.startsWith("json:") && !result.playUrl.startsWith("parse:")) {
    return {
      url: result.playUrl + result.url,
      headers: { ...result.header },
      ...(result.format !== undefined ? { format: result.format } : {}),
      ...playerExtras(result),
      resolvedBy: "prefix",
    };
  }

  let parser: ParseConfig | undefined;
  if (result.playUrl.startsWith("json:")) {
    parser = { name: "site-json", type: 1, url: result.playUrl.slice(5) };
  } else if (result.playUrl.startsWith("parse:")) {
    const name = result.playUrl.slice(6);
    parser = parses.find((item) => item.name === name && item.type === 1);
  } else {
    parser = chooseJsonParser(parses, result.flag);
  }

  if (parser === undefined) throw new Error(`播放地址需要解析，但没有可用的 JSON 解析器：${result.flag}`);
  const timeoutSignal = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(parser.url + result.url, {
    headers: { ...(parser.ext?.header ?? {}), ...result.header },
    redirect: "follow",
    signal: requestSignal,
  });
  if (!response.ok) throw new Error(`解析器 ${parser.name} 请求失败：HTTP ${response.status}`);

  const payload = await response.json() as Record<string, unknown>;
  const data = typeof payload.data === "object" && payload.data !== null ? payload.data as Record<string, unknown> : {};
  const url = typeof payload.url === "string" ? payload.url : typeof data.url === "string" ? data.url : "";
  if (url.length < 8) throw new Error(`解析器 ${parser.name} 未返回有效播放地址`);

  return {
    url,
    headers: extractHeaders(payload, { ...(parser.ext?.header ?? {}), ...result.header }),
    ...(result.format !== undefined ? { format: result.format } : {}),
    ...playerExtras(result),
    resolvedBy: "json-api",
  };
}
