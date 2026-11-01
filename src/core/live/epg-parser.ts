import { createHash } from "node:crypto";
import type { EpgChannelDefinition, EpgProgramme, ParsedXmlTv } from "./epg-models.ts";

const MAX_XMLTV_BYTES = 64 * 1024 * 1024;
const MAX_CHANNELS = 100_000;
const MAX_PROGRAMMES = 300_000;
const DEFAULT_PAST_WINDOW_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_FUTURE_WINDOW_MS = 8 * 24 * 60 * 60 * 1_000;

export interface ParseXmlTvOptions {
  now?: number;
  timeZone?: string;
  pastWindowMs?: number;
  futureWindowMs?: number;
}

export function parseXmlTv(text: string, options: ParseXmlTvOptions = {}): ParsedXmlTv {
  if (Buffer.byteLength(text, "utf8") > MAX_XMLTV_BYTES) throw new Error("XMLTV 文件超过 64 MB 安全上限");
  if (!/<tv(?:\s|>)/i.test(text)) throw new Error("内容不是有效的 XMLTV 文档");

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const minimumStart = now - Math.max(0, options.pastWindowMs ?? DEFAULT_PAST_WINDOW_MS);
  const maximumEnd = now + Math.max(60 * 60 * 1_000, options.futureWindowMs ?? DEFAULT_FUTURE_WINDOW_MS);
  const channels: EpgChannelDefinition[] = [];
  const channelIds = new Set<string>();
  const programmes: EpgProgramme[] = [];
  const programmeIds = new Set<string>();

  const channelExpression = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let channelMatch: RegExpExecArray | null;
  while ((channelMatch = channelExpression.exec(text)) !== null) {
    if (channels.length >= MAX_CHANNELS) break;
    const id = decodeXml(attributeValue(channelMatch[1] ?? "", "id")).trim();
    if (!id || channelIds.has(id)) continue;
    const body = channelMatch[2] ?? "";
    const names = unique(extractTagValues(body, "display-name").map(cleanXmlText).filter(Boolean));
    const icon = firstTagAttribute(body, "icon", "src");
    channelIds.add(id);
    channels.push({ id, names: names.length ? names : [id], ...(icon ? { icon: resolveXmlValue(icon) } : {}) });
  }

  const programmeExpression = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let programmeMatch: RegExpExecArray | null;
  while ((programmeMatch = programmeExpression.exec(text)) !== null) {
    if (programmes.length >= MAX_PROGRAMMES) break;
    const attributes = programmeMatch[1] ?? "";
    const channelId = decodeXml(attributeValue(attributes, "channel")).trim();
    const startAt = parseXmlTvDate(attributeValue(attributes, "start"), options.timeZone);
    const endAt = parseXmlTvDate(attributeValue(attributes, "stop"), options.timeZone);
    if (!channelId || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) continue;
    if (endAt < minimumStart || startAt > maximumEnd) continue;
    const body = programmeMatch[2] ?? "";
    const title = firstTagText(body, "title") || "未命名节目";
    const subtitle = firstTagText(body, "sub-title");
    const description = firstTagText(body, "desc");
    const categories = unique(extractTagValues(body, "category").map(cleanXmlText).filter(Boolean));
    const icon = firstTagAttribute(body, "icon", "src");
    const id = stableId(channelId, String(startAt), String(endAt), title);
    if (programmeIds.has(id)) continue;
    programmeIds.add(id);
    programmes.push({
      id,
      channelId,
      startAt,
      endAt,
      title,
      ...(subtitle ? { subtitle } : {}),
      ...(description ? { description } : {}),
      categories,
      ...(icon ? { icon: resolveXmlValue(icon) } : {}),
    });
  }

  programmes.sort((left, right) => left.channelId.localeCompare(right.channelId) || left.startAt - right.startAt);
  return { channels, programmes };
}

export function parseXmlTvDate(value: string, timeZone?: string): number {
  const normalized = String(value ?? "").trim();
  const match = normalized.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2}):?(\d{2})|\s*(Z))?/i);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (match[10]) return utc;
  if (match[7]) {
    const direction = match[7] === "+" ? 1 : -1;
    const offsetMinutes = direction * (Number(match[8]) * 60 + Number(match[9]));
    return utc - offsetMinutes * 60_000;
  }
  return timeZone ? localTimeInZoneToUtc(year, month, day, hour, minute, second, timeZone) : utc;
}

function localTimeInZoneToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    let guess = target;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(guess));
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const represented = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second),
      );
      guess -= represented - target;
    }
    return guess;
  } catch {
    return target;
  }
}

function attributeValue(attributes: string, name: string): string {
  const expression = new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = attributes.match(expression);
  return match?.[1] ?? match?.[2] ?? "";
}

function firstTagText(body: string, tag: string): string {
  return extractTagValues(body, tag).map(cleanXmlText).find(Boolean) ?? "";
}

function extractTagValues(body: string, tag: string): string[] {
  const expression = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, "gi");
  return [...body.matchAll(expression)].map((match) => match[1] ?? "");
}

function firstTagAttribute(body: string, tag: string, attribute: string): string {
  const expression = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*)\\/?\\s*>`, "i");
  const match = body.match(expression);
  return match ? attributeValue(match[1] ?? "", attribute) : "";
}

function cleanXmlText(value: string): string {
  return decodeXml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function resolveXmlValue(value: string): string {
  return decodeXml(value).trim();
}

function decodeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, code: string) => {
    const normalized = code.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const numeric = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
  });
}

function stableId(...values: string[]): string {
  return createHash("sha1").update(values.join("\u0000")).digest("hex").slice(0, 24);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
