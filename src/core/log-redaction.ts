const SENSITIVE_KEY_PATTERN = [
  "authorization",
  "proxy[-_]?authorization",
  "cookie",
  "set[-_]?cookie",
  "token",
  "access[-_]?token",
  "refresh[-_]?token",
  "auth[-_]?key",
  "api[-_]?key",
  "client[-_]?secret",
  "password",
  "passwd",
  "passcode",
  "pwd",
  "account",
  "username",
  "share[-_]?pwd",
  "share[-_]?password",
  "share[-_]?code",
].join("|");

const SENSITIVE_QUERY_PATTERN = new RegExp(
  `([?&](?:${SENSITIVE_KEY_PATTERN})=)[^&#\\s]+`,
  "gi",
);
const SENSITIVE_HEADER_PATTERN = new RegExp(
  `(^|[\\r\\n,;]\\s*)((?:${SENSITIVE_KEY_PATTERN})\\s*[:=]\\s*)(?:bearer\\s+)?[^\\r\\n,;]+`,
  "gi",
);
const SENSITIVE_INLINE_PATTERN = new RegExp(
  `(["']?(?:${SENSITIVE_KEY_PATTERN})["']?\\s*[:=]\\s*)(["']?)(?!\\*{3})([^"'\\s,;}&]+)(\\2)`,
  "gi",
);
const CHINESE_SHARE_CODE_PATTERN = /((?:提取码|分享口令|访问口令|分享码|访问码)\s*[:：=]?\s*)(?!\*{3})[A-Za-z0-9_-]{3,}/gi;
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

/**
 * Removes credentials and share codes from text that may reach logs, reports,
 * renderer-facing errors, or console output. The function intentionally keeps
 * key names and URL structure so diagnostics remain useful without exposing
 * secrets.
 */
export function redactSensitiveText(value: unknown): string {
  return String(value ?? "")
    .replace(URL_CREDENTIAL_PATTERN, "$1***:***@")
    .replace(SENSITIVE_QUERY_PATTERN, "$1***")
    .replace(SENSITIVE_HEADER_PATTERN, "$1$2***")
    .replace(SENSITIVE_INLINE_PATTERN, "$1$2***$4")
    .replace(CHINESE_SHARE_CODE_PATTERN, "$1***");
}

export function redactSensitiveError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.stack || error.message || error.name);
  }
  return redactSensitiveText(error);
}

export function redactSensitiveValue<T>(value: T): T {
  return redactUnknown(value, new WeakSet()) as T;
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, seen));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (new RegExp(`^(?:${SENSITIVE_KEY_PATTERN})$`, "i").test(key)) {
      result[key] = "***";
    } else {
      result[key] = redactUnknown(item, seen);
    }
  }
  return result;
}
