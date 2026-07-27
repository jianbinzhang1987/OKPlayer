export interface DanmakuPresentationSettings {
  opacity: number;
  fontScale: number;
  speed: number;
  blockedWords: string[];
  maxActive: number;
}

export interface SubtitlePresentationSettings {
  fontScale: number;
  delaySeconds: number;
  backgroundOpacity: number;
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuPresentationSettings = {
  opacity: 0.9,
  fontScale: 1,
  speed: 1,
  blockedWords: [],
  maxActive: 36,
};

export const DEFAULT_SUBTITLE_SETTINGS: SubtitlePresentationSettings = {
  fontScale: 1,
  delaySeconds: 0,
  backgroundOpacity: 0.45,
};

export function normalizeDanmakuSettings(value: unknown): DanmakuPresentationSettings {
  const record = asRecord(value);
  return {
    opacity: clampNumber(record.opacity, 0.2, 1, DEFAULT_DANMAKU_SETTINGS.opacity),
    fontScale: clampNumber(record.fontScale, 0.7, 1.8, DEFAULT_DANMAKU_SETTINGS.fontScale),
    speed: clampNumber(record.speed, 0.5, 2, DEFAULT_DANMAKU_SETTINGS.speed),
    blockedWords: normalizeBlockedWords(record.blockedWords),
    maxActive: Math.round(clampNumber(record.maxActive, 12, 72, DEFAULT_DANMAKU_SETTINGS.maxActive)),
  };
}

export function normalizeSubtitleSettings(value: unknown): SubtitlePresentationSettings {
  const record = asRecord(value);
  return {
    fontScale: clampNumber(record.fontScale, 0.7, 1.8, DEFAULT_SUBTITLE_SETTINGS.fontScale),
    delaySeconds: clampNumber(record.delaySeconds, -10, 10, DEFAULT_SUBTITLE_SETTINGS.delaySeconds),
    backgroundOpacity: clampNumber(record.backgroundOpacity, 0, 0.9, DEFAULT_SUBTITLE_SETTINGS.backgroundOpacity),
  };
}

export function parseBlockedWords(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeBlockedWords(value);
  return normalizeBlockedWords(String(value ?? "").split(/[\n,，;；]+/));
}

function normalizeBlockedWords(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, 40)))]
    .slice(0, 100);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
