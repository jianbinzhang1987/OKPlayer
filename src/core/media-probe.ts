import type { RankedMediaCandidate } from "./media-sniffer.ts";
import type { HeadersMap } from "./models.ts";

export interface MediaProbeOptions {
  headers?: HeadersMap;
  expectedFormat?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface MediaProbeResult {
  ok: boolean;
  url: string;
  statusCode: number;
  mimeType: string;
  bytesRead: number;
  format?: string;
  reason: string;
}

export interface VerifiedMediaCandidate {
  candidate: RankedMediaCandidate;
  headers: HeadersMap;
  verified: boolean;
  probe?: MediaProbeResult;
}

export interface CandidateVerificationOptions {
  getHeaders: (candidate: RankedMediaCandidate) => HeadersMap | Promise<HeadersMap>;
  probe?: typeof probeMediaUrl;
  maxCandidates?: number;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 6_000;

export async function probeMediaUrl(url: string, options: MediaProbeOptions = {}): Promise<MediaProbeResult> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("媒体探测仅支持 HTTP/HTTPS 地址");

  const maxBytes = Math.max(32, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, 512 * 1024));
  const timeoutSignal = AbortSignal.timeout(Math.max(500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const headers = new Headers(options.headers ?? {});
  if (!headers.has("Range")) headers.set("Range", `bytes=0-${maxBytes - 1}`);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/vnd.apple.mpegurl, application/dash+xml, video/*, audio/*, */*;q=0.5");
  }

  const response = await fetch(parsed, {
    method: "GET",
    headers,
    redirect: "follow",
    signal,
  });
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!response.ok) {
    return {
      ok: false,
      url: response.url || url,
      statusCode: response.status,
      mimeType,
      bytesRead: 0,
      reason: `HTTP ${response.status}`,
    };
  }

  const prefix = await readBodyPrefix(response.body, maxBytes);
  const format = detectMediaFormat(prefix, mimeType, response.url || url);
  const html = looksLikeHtml(prefix, mimeType);
  if (html) {
    return {
      ok: false,
      url: response.url || url,
      statusCode: response.status,
      mimeType,
      bytesRead: prefix.length,
      reason: "响应内容是 HTML，不是媒体资源",
    };
  }

  const expectedFormat = options.expectedFormat?.toLowerCase();
  if (expectedFormat && format && !formatsCompatible(expectedFormat, format)) {
    return {
      ok: false,
      url: response.url || url,
      statusCode: response.status,
      mimeType,
      bytesRead: prefix.length,
      format,
      reason: `媒体格式不匹配：期望 ${expectedFormat}，实际 ${format}`,
    };
  }

  if (!format) {
    return {
      ok: false,
      url: response.url || url,
      statusCode: response.status,
      mimeType,
      bytesRead: prefix.length,
      reason: "未识别出媒体格式",
    };
  }

  return {
    ok: true,
    url: response.url || url,
    statusCode: response.status,
    mimeType,
    bytesRead: prefix.length,
    format,
    reason: "媒体内容验证通过",
  };
}

export async function selectVerifiedMediaCandidate(
  candidates: RankedMediaCandidate[],
  options: CandidateVerificationOptions,
): Promise<VerifiedMediaCandidate | undefined> {
  const probe = options.probe ?? probeMediaUrl;
  const limit = Math.max(1, options.maxCandidates ?? 5);
  const uncertain: Array<{ candidate: RankedMediaCandidate; headers: HeadersMap }> = [];

  for (const candidate of candidates.slice(0, limit)) {
    const headers = await options.getHeaders(candidate);
    try {
      const result = await probe(candidate.url, {
        headers,
        ...(candidate.format ? { expectedFormat: candidate.format } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (result.ok) {
        return {
          candidate: {
            ...candidate,
            url: result.url,
            ...(result.format ? { format: result.format } : {}),
          },
          headers,
          verified: true,
          probe: result,
        };
      }
      if (!isDefinitiveProbeFailure(result)) uncertain.push({ candidate, headers });
    } catch {
      uncertain.push({ candidate, headers });
    }
  }

  const fallback = uncertain[0];
  if (fallback) return { ...fallback, verified: false };
  const unprobed = candidates[limit];
  if (!unprobed) return undefined;
  return {
    candidate: unprobed,
    headers: await options.getHeaders(unprobed),
    verified: false,
  };
}

function isDefinitiveProbeFailure(result: MediaProbeResult): boolean {
  return /HTML|格式不匹配/i.test(result.reason) || result.statusCode === 404 || result.statusCode === 410;
}

async function readBodyPrefix(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = maxBytes - total;
      const chunk = result.value.length > remaining ? result.value.subarray(0, remaining) : result.value;
      chunks.push(chunk);
      total += chunk.length;
      if (result.value.length > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function detectMediaFormat(prefix: Uint8Array, mimeType: string, url: string): string | undefined {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(prefix.subarray(0, Math.min(prefix.length, 16 * 1024))).trimStart();
  const extension = extensionOf(url);

  if (/mpegurl|x-mpegurl/i.test(mimeType) || text.startsWith("#EXTM3U")) return "hls";
  if (/dash\+xml/i.test(mimeType) || /<(?:[\w-]+:)?MPD(?:\s|>)/i.test(text)) return "dash";
  if (/video\/mp4/i.test(mimeType) || extension === "mp4" || ascii(prefix, 4, 4) === "ftyp") return "mp4";
  if (/video\/(?:x-)?flv/i.test(mimeType) || extension === "flv" || ascii(prefix, 0, 3) === "FLV") return "flv";
  if (/video\/webm/i.test(mimeType) || extension === "webm" || hasBytes(prefix, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (/video\/mp2t/i.test(mimeType) || extension === "ts" || prefix[0] === 0x47) return "mpeg-ts";
  if (mimeType.startsWith("video/")) return extension || "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return undefined;
}

function looksLikeHtml(prefix: Uint8Array, mimeType: string): boolean {
  if (/text\/html|application\/xhtml\+xml/i.test(mimeType)) return true;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(prefix.subarray(0, Math.min(prefix.length, 2_048))).trimStart();
  return /^(?:<!doctype\s+html|<html|<head|<body)(?:\s|>)/i.test(text);
}

function extensionOf(value: string): string {
  try {
    return new URL(value).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  } catch {
    return "";
  }
}

function formatsCompatible(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === "video" && ["mp4", "flv", "webm", "mpeg-ts", "video"].includes(actual)) return true;
  if (expected === "audio" && actual === "audio") return true;
  return false;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + length));
}

function hasBytes(value: Uint8Array, expected: number[]): boolean {
  return expected.every((byte, index) => value[index] === byte);
}
