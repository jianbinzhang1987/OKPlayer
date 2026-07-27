export type CompatibilityFallbackMode = "automatic" | "manual";

export const AUTOMATIC_COMPATIBILITY_FALLBACK_DELAY_MS = 4_000;

export function normalizeCompatibilityFallbackMode(value: unknown): CompatibilityFallbackMode {
  return value === "manual" ? "manual" : "automatic";
}

export function shouldScheduleCompatibilityFallback(input: {
  mode: CompatibilityFallbackMode;
  fallbackTriggered: boolean;
  disposed: boolean;
}): boolean {
  return input.mode === "automatic" && !input.fallbackTriggered && !input.disposed;
}
