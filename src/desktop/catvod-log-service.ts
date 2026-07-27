import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "../core/log-redaction.ts";

export const DEFAULT_CATVOD_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_CATVOD_LOG_RETENTION = 3;

export async function appendCatVodLog(
  logFile: string,
  value: string,
  maxBytes = DEFAULT_CATVOD_LOG_MAX_BYTES,
  retention = DEFAULT_CATVOD_LOG_RETENTION,
): Promise<void> {
  await mkdir(path.dirname(logFile), { recursive: true });
  const payload = maskCatVodLogSecrets(value);
  const size = Buffer.byteLength(payload);
  const currentSize = await stat(logFile).then((entry) => entry.size).catch(() => 0);
  if (currentSize > 0 && currentSize + size > Math.max(1, maxBytes)) {
    await rotateCatVodLogs(logFile, Math.max(1, Math.floor(retention)));
  }
  await appendFile(logFile, payload, { mode: 0o600 });
}

async function rotateCatVodLogs(logFile: string, retention: number): Promise<void> {
  for (let index = retention; index >= 1; index -= 1) {
    const source = index === 1 ? logFile : `${logFile}.${index - 1}`;
    const target = `${logFile}.${index}`;
    await rm(target, { force: true }).catch(() => undefined);
    await rename(source, target).catch(() => undefined);
  }
}

export function maskCatVodLogSecrets(value: string): string {
  return redactSensitiveText(value);
}
