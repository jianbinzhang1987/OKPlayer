export type DanmakuMode = "scroll" | "top" | "bottom";

export interface DanmakuItem {
  time: number;
  text: string;
  mode: DanmakuMode;
  color?: string;
}

const MAX_DANMAKU_ITEMS = 8_000;
const MAX_DANMAKU_TEXT_LENGTH = 120;

export function parseDanmakuPayload(payload: string, contentType = ""): DanmakuItem[] {
  const text = String(payload ?? "").trim();
  if (!text) return [];
  if (/json/i.test(contentType) || /^[\[{]/.test(text)) return parseJsonDanmaku(text);
  if (/xml|html/i.test(contentType) || /^</.test(text)) return parseXmlDanmaku(text);
  return parseJsonDanmaku(text);
}

export function parseJsonDanmaku(payload: string): DanmakuItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return [];
  }
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? (raw as { data: unknown[] }).data
      : Array.isArray((raw as { list?: unknown })?.list)
        ? (raw as { list: unknown[] }).list
        : Array.isArray((raw as { danmaku?: unknown })?.danmaku)
          ? (raw as { danmaku: unknown[] }).danmaku
          : [];
  return normalizeDanmakuItems(source.map(normalizeJsonDanmakuItem));
}

export function parseXmlDanmaku(payload: string): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  const matches = payload.matchAll(/<d\b([^>]*)>([\s\S]*?)<\/d>/gi);
  for (const match of matches) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const p = /\bp=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    const [time, modeCode, , colorCode] = p.split(",");
    const item = normalizeDanmakuItem({
      time: Number(time),
      text: decodeEntities(stripTags(body)).trim(),
      mode: normalizeDanmakuMode(modeCode),
      color: normalizeColor(colorCode),
    });
    if (item) items.push(item);
  }
  if (items.length) return normalizeDanmakuItems(items);

  const comments = payload.matchAll(/<(?:comment|danmaku|item)\b([^>]*)>([\s\S]*?)<\/(?:comment|danmaku|item)>/gi);
  for (const match of comments) {
    const attrs = match[1] ?? "";
    const time = /\b(?:time|stime|at)=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "0";
    const mode = /\b(?:mode|type)=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "scroll";
    const color = /\bcolor=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    const item = normalizeDanmakuItem({
      time: Number(time),
      text: decodeEntities(stripTags(match[2] ?? "")).trim(),
      mode: normalizeDanmakuMode(mode),
      color: normalizeColor(color),
    });
    if (item) items.push(item);
  }
  return normalizeDanmakuItems(items);
}

function normalizeJsonDanmakuItem(value: unknown): DanmakuItem | undefined {
  if (Array.isArray(value)) {
    return normalizeDanmakuItem({
      time: Number(value[0] ?? 0),
      text: String(value[4] ?? value[3] ?? value[1] ?? ""),
      mode: normalizeDanmakuMode(value[1] ?? value[2]),
      color: normalizeColor(value[3] ?? value[2]),
    });
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return normalizeDanmakuItem({
    time: Number(record.time ?? record.t ?? record.stime ?? record.at ?? 0),
    text: String(record.text ?? record.content ?? record.msg ?? record.message ?? record.m ?? ""),
    mode: normalizeDanmakuMode(record.mode ?? record.type ?? record.position),
    color: normalizeColor(record.color ?? record.c),
  });
}

function normalizeDanmakuItem(value: Partial<DanmakuItem> | undefined): DanmakuItem | undefined {
  const time = Number(value?.time ?? 0);
  const text = sanitizeText(value?.text ?? "");
  if (!Number.isFinite(time) || time < 0 || !text) return undefined;
  return {
    time: Math.round(time * 100) / 100,
    text,
    mode: value?.mode ?? "scroll",
    ...(value?.color ? { color: value.color } : {}),
  };
}

function normalizeDanmakuItems(items: Array<DanmakuItem | undefined>): DanmakuItem[] {
  return items
    .filter((item): item is DanmakuItem => Boolean(item))
    .sort((left, right) => left.time - right.time)
    .slice(0, MAX_DANMAKU_ITEMS);
}

function normalizeDanmakuMode(value: unknown): DanmakuMode {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["5", "top", "顶部", "top-fixed"].includes(raw)) return "top";
  if (["4", "bottom", "底部", "bottom-fixed"].includes(raw)) return "bottom";
  return "scroll";
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return `#${Math.max(0, Math.min(0xffffff, value)).toString(16).padStart(6, "0")}`;
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`;
  if (/^\d+$/.test(raw)) return normalizeColor(Number(raw));
  return undefined;
}

function sanitizeText(value: unknown): string {
  return decodeEntities(stripTags(String(value ?? "")))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DANMAKU_TEXT_LENGTH);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}
