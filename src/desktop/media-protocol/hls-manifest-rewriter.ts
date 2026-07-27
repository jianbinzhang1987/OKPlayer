import type { PlaybackResourceKind } from "./playback-session-store.ts";

export interface RegisteredManifestResource {
  url: string;
  kind: PlaybackResourceKind;
  parentUrl: string;
}

export type ManifestResourceRegistrar = (resource: RegisteredManifestResource) => string;

const URI_ATTRIBUTE_PATTERN = /URI=(?:"([^"]*)"|([^,\s]*))/g;

export function rewriteHlsManifest(
  manifest: string,
  manifestUrl: string,
  register: ManifestResourceRegistrar,
): string {
  const newline = manifest.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = manifest.endsWith("\n");
  const lines = manifest.split(/\r?\n/);
  if (trailingNewline && lines.at(-1) === "") lines.pop();

  const rewritten = lines.map((line) => rewriteManifestLine(line, manifestUrl, register));
  return `${rewritten.join(newline)}${trailingNewline ? newline : ""}`;
}

function rewriteManifestLine(
  line: string,
  manifestUrl: string,
  register: ManifestResourceRegistrar,
): string {
  const trimmed = line.trim();
  if (!trimmed) return line;

  if (!trimmed.startsWith("#")) {
    const replacement = registerResolvedUri(trimmed, manifestUrl, classifyResource(trimmed), register);
    if (!replacement) return line;
    const prefixLength = line.indexOf(trimmed);
    return `${line.slice(0, prefixLength)}${replacement}${line.slice(prefixLength + trimmed.length)}`;
  }

  if (!line.includes("URI=")) return line;
  const kindHint = kindForTag(trimmed);
  return line.replace(URI_ATTRIBUTE_PATTERN, (match, quoted: string | undefined, unquoted: string | undefined) => {
    const original = quoted ?? unquoted ?? "";
    if (!original) return match;
    const kind = kindHint ?? classifyResource(original);
    const replacement = registerResolvedUri(original, manifestUrl, kind, register);
    if (!replacement) return match;
    return quoted !== undefined ? `URI="${replacement}"` : `URI=${replacement}`;
  });
}

function registerResolvedUri(
  value: string,
  manifestUrl: string,
  kind: PlaybackResourceKind,
  register: ManifestResourceRegistrar,
): string | undefined {
  let resolved: URL;
  try {
    resolved = new URL(value, manifestUrl);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(resolved.protocol)) return undefined;
  return register({ url: resolved.href, kind, parentUrl: manifestUrl });
}

function kindForTag(tag: string): PlaybackResourceKind | undefined {
  const name = tag.slice(0, tag.indexOf(":") >= 0 ? tag.indexOf(":") : tag.length).toUpperCase();
  if (name === "#EXT-X-KEY" || name === "#EXT-X-SESSION-KEY") return "key";
  if (name === "#EXT-X-MAP") return "initialization";
  if (name === "#EXT-X-STREAM-INF" || name === "#EXT-X-I-FRAME-STREAM-INF" || name === "#EXT-X-RENDITION-REPORT") return "manifest";
  if (name === "#EXT-X-PART" || name === "#EXT-X-PRELOAD-HINT") {
    return /TYPE=MAP(?:,|$)/i.test(tag) ? "initialization" : "segment";
  }
  if (name === "#EXT-X-MEDIA") {
    if (/TYPE=SUBTITLES(?:,|$)/i.test(tag)) return "subtitle";
    return "manifest";
  }
  return undefined;
}

function classifyResource(value: string): PlaybackResourceKind {
  let pathname = value;
  try {
    pathname = new URL(value, "https://placeholder.invalid/").pathname;
  } catch {
    // Keep the original value for extension inspection.
  }
  const extension = pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (extension === "m3u8") return "manifest";
  if (["vtt", "srt", "ass", "ssa", "ttml", "xml"].includes(extension)) return "subtitle";
  if (["key", "bin"].includes(extension)) return "key";
  if (["mp4", "m4s", "cmfv", "cmfa"].includes(extension)) return "segment";
  return "segment";
}
