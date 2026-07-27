export type FontSizePreference = "compact" | "standard" | "large" | "extra-large";

export const FONT_SIZE_OPTIONS: ReadonlyArray<{ value: FontSizePreference; label: string }> = [
  { value: "compact", label: "紧凑" },
  { value: "standard", label: "标准（默认）" },
  { value: "large", label: "大" },
  { value: "extra-large", label: "特大" },
];

export function normalizeFontSize(value: unknown): FontSizePreference {
  const normalized = String(value);
  return FONT_SIZE_OPTIONS.some((option) => option.value === normalized)
    ? normalized as FontSizePreference
    : "standard";
}

export function fontSizeClass(value: FontSizePreference): string {
  return `font-${value}`;
}
