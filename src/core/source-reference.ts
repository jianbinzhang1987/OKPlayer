const PREFIX = "cfg:";
const MAX_PART_LENGTH = 16_384;

export interface SourceReference {
  configSource: string;
  siteKey: string;
}

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string): string {
  if (!value || value.length > MAX_PART_LENGTH) throw new Error("来源引用格式无效");
  return Buffer.from(value, "base64url").toString("utf8");
}

export function encodeSourceReference(configSource: string, siteKey: string): string {
  const source = configSource.trim();
  const key = siteKey.trim();
  if (!source || !key) throw new Error("来源引用缺少配置地址或站点标识");
  return `${PREFIX}${encodePart(source)}:${encodePart(key)}`;
}

export function decodeSourceReference(value: string): SourceReference | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 2) throw new Error("来源引用格式无效");
  const configSource = decodePart(parts[0]!);
  const siteKey = decodePart(parts[1]!);
  if (!configSource || !siteKey) throw new Error("来源引用内容无效");
  return { configSource, siteKey };
}

export function isSourceReference(value: string): boolean {
  return value.startsWith(PREFIX);
}
