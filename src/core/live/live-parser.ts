import { createHash } from "node:crypto";
import type { HeadersMap } from "../models.ts";
import type {
  LiveCatchup,
  LiveChannel,
  LiveGroup,
  LiveLine,
  LiveSource,
  LiveSourceDefinition,
  LiveSourceFormat,
} from "./live-models.ts";

interface ChannelDraft {
  name: string;
  number?: string;
  logo?: string;
  epgUrl?: string;
  tvgId?: string;
  tvgName?: string;
  catchup?: LiveCatchup;
  lines: Array<{
    name?: string;
    url: string;
    headers?: HeadersMap;
    format?: string;
    parse?: boolean;
    click?: string;
  }>;
}

interface GroupDraft {
  name: string;
  passwordProtected?: boolean;
  channels: ChannelDraft[];
}

interface DirectiveState {
  headers: HeadersMap;
  format?: string;
  parse?: boolean;
  click?: string;
  catchup?: LiveCatchup;
}

const SUPPORTED_STREAM_PROTOCOLS = new Set(["http:", "https:", "rtmp:", "rtsp:", "udp:", "rtp:"]);

export function detectLiveFormat(text: string): LiveSourceFormat {
  const source = text.replace(/^\uFEFF/, "").trimStart();
  if (source.startsWith("[") || source.startsWith("{")) return "json";
  if (/^\s*#EXTM3U\b/im.test(source) && !/#genre#/i.test(source)) return "m3u";
  return "txt";
}

export function parseLiveText(
  text: string,
  definition: LiveSourceDefinition,
  resolvedSourceUrl = definition.url,
): LiveSource {
  const format = detectLiveFormat(text);
  const groups = format === "m3u"
    ? parseM3u(text, definition, resolvedSourceUrl)
    : format === "json"
      ? parseJson(text, definition, resolvedSourceUrl)
      : parseTxt(text, definition, resolvedSourceUrl);
  return buildLiveSource(definition, format, groups, resolvedSourceUrl);
}

export function parseEmbeddedLive(definition: LiveSourceDefinition): LiveSource {
  const groups = parseJsonGroups(definition.groups ?? [], definition, definition.url);
  return buildLiveSource(definition, "embedded", groups, definition.url);
}

function buildLiveSource(
  definition: LiveSourceDefinition,
  format: LiveSourceFormat,
  drafts: GroupDraft[],
  sourceUrl?: string,
): LiveSource {
  const groups = normalizeGroups(drafts, definition);
  return {
    id: definition.id,
    name: definition.name,
    ...(sourceUrl ? { sourceUrl } : {}),
    format,
    epgUrls: [...definition.epgUrls],
    ...(definition.logo ? { logoTemplate: definition.logo } : {}),
    headers: sourceHeaders(definition),
    ...(definition.timeZone ? { timeZone: definition.timeZone } : {}),
    boot: Boolean(definition.boot),
    groups,
    loadedAt: Date.now(),
  };
}

function parseJson(text: string, definition: LiveSourceDefinition, sourceUrl?: string): GroupDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`直播 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (Array.isArray(parsed)) return parseJsonGroups(parsed, definition, sourceUrl);
  if (!parsed || typeof parsed !== "object") throw new Error("直播 JSON 根节点必须是数组或对象");
  const object = parsed as Record<string, unknown>;
  if (Array.isArray(object.groups)) return parseJsonGroups(object.groups, definition, sourceUrl);
  if (Array.isArray(object.lives)) {
    const matched = object.lives.find((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      return String((item as Record<string, unknown>).name ?? "").trim() === definition.name;
    }) ?? object.lives[0];
    if (matched && typeof matched === "object" && !Array.isArray(matched)) {
      const groups = (matched as Record<string, unknown>).groups;
      if (Array.isArray(groups)) return parseJsonGroups(groups, definition, sourceUrl);
    }
  }
  throw new Error("直播 JSON 中没有可用的 groups");
}

function parseJsonGroups(input: unknown[], definition: LiveSourceDefinition, sourceUrl?: string): GroupDraft[] {
  const groups: GroupDraft[] = [];
  for (const rawGroup of input) {
    if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) continue;
    const group = rawGroup as Record<string, unknown>;
    const name = String(group.name ?? "未分组").trim() || "未分组";
    const passwordProtected = typeof group.pass === "string" && group.pass.trim().length > 0;
    const channelsInput = Array.isArray(group.channel)
      ? group.channel
      : Array.isArray(group.channels)
        ? group.channels
        : [];
    const channels: ChannelDraft[] = [];
    for (const rawChannel of channelsInput) {
      if (!rawChannel || typeof rawChannel !== "object" || Array.isArray(rawChannel)) continue;
      const channel = rawChannel as Record<string, unknown>;
      const channelName = String(channel.name ?? "").trim();
      if (!channelName) continue;
      const channelHeaders = mergeHeaders(
        sourceHeaders(definition),
        directiveHeaders(channel),
      );
      const rawUrls = Array.isArray(channel.urls)
        ? channel.urls
        : typeof channel.url === "string"
          ? [channel.url]
          : [];
      const lines = rawUrls.flatMap((value, index) => {
        if (typeof value !== "string") return [];
        const parsed = parseLineValue(value, sourceUrl);
        if (!parsed) return [];
        return [{
          name: parsed.name ?? `线路 ${index + 1}`,
          url: parsed.url,
          headers: mergeHeaders(channelHeaders, parsed.headers),
          ...(typeof channel.format === "string" && channel.format.trim() ? { format: channel.format.trim() } : {}),
          parse: Number(channel.parse ?? 0) === 1,
          ...(typeof channel.click === "string" && channel.click.trim() ? { click: channel.click.trim() } : {}),
        }];
      });
      if (!lines.length) continue;
      channels.push({
        name: channelName,
        ...(stringValue(channel.number) ? { number: stringValue(channel.number) } : {}),
        ...(stringValue(channel.logo) ? { logo: resolveMaybeUrl(stringValue(channel.logo), sourceUrl) } : {}),
        ...(stringValue(channel.epg) ? { epgUrl: resolveMaybeUrl(stringValue(channel.epg), sourceUrl) } : {}),
        ...(stringValue(channel.tvgId) ? { tvgId: stringValue(channel.tvgId) } : {}),
        ...(stringValue(channel.tvgName) ? { tvgName: stringValue(channel.tvgName) } : {}),
        ...(normalizeCatchup(channel.catchup) ?? definition.catchup ? { catchup: normalizeCatchup(channel.catchup) ?? definition.catchup } : {}),
        lines,
      });
    }
    if (channels.length) groups.push({ name, passwordProtected, channels });
  }
  return groups;
}

function parseM3u(text: string, definition: LiveSourceDefinition, sourceUrl?: string): GroupDraft[] {
  if (sourceUrl && /^#EXT-X-(?:TARGETDURATION|MEDIA-SEQUENCE|STREAM-INF|PLAYLIST-TYPE|ENDLIST)\b/im.test(text)) {
    return [{
      name: "未分组",
      channels: [{
        name: definition.name,
        lines: [{
          name: "默认线路",
          url: sourceUrl,
          headers: sourceHeaders(definition),
          format: "hls",
          parse: false,
        }],
      }],
    }];
  }
  const lines = normalizedLines(text);
  const groups = new Map<string, GroupDraft>();
  let pendingChannel: ChannelDraft | undefined;
  let pendingDirectives = emptyDirectives();
  let globalCatchup = definition.catchup;
  const globalHeaders = sourceHeaders(definition);

  for (const line of lines) {
    if (!line) continue;
    if (/^#EXTM3U\b/i.test(line)) {
      const attrs = parseAttributes(line.slice(line.indexOf(" ") + 1));
      globalCatchup = mergeCatchup(globalCatchup, catchupFromAttributes(attrs));
      continue;
    }
    if (/^#EXTINF:/i.test(line)) {
      const comma = findUnquotedComma(line);
      const metadata = comma >= 0 ? line.slice(0, comma) : line;
      const name = comma >= 0 ? line.slice(comma + 1).trim() : "未命名频道";
      const attrs = parseAttributes(metadata);
      pendingChannel = {
        name: name || attrs["tvg-name"] || "未命名频道",
        ...(attrs["tvg-chno"] ? { number: attrs["tvg-chno"] } : {}),
        ...(attrs["tvg-logo"] ? { logo: resolveMaybeUrl(attrs["tvg-logo"], sourceUrl) } : {}),
        ...(attrs["tvg-id"] ? { tvgId: attrs["tvg-id"] } : {}),
        ...(attrs["tvg-name"] ? { tvgName: attrs["tvg-name"] } : {}),
        catchup: mergeCatchup(globalCatchup, catchupFromAttributes(attrs)),
        lines: [],
      };
      (pendingChannel as ChannelDraft & { groupName?: string }).groupName = attrs["group-title"] || "未分组";
      pendingDirectives = emptyDirectives();
      if (attrs["http-user-agent"]) pendingDirectives.headers["User-Agent"] = attrs["http-user-agent"];
      continue;
    }
    if (!pendingChannel) continue;
    if (line.startsWith("#")) {
      applyM3uDirective(pendingDirectives, line);
      continue;
    }
    if (isDirectiveLine(line)) {
      applyDirective(pendingDirectives, line);
      continue;
    }
    const parsed = parseLineValue(line, sourceUrl);
    if (!parsed) continue;
    pendingChannel.lines.push({
      name: parsed.name,
      url: parsed.url,
      headers: mergeHeaders(globalHeaders, pendingDirectives.headers, parsed.headers),
      ...(pendingDirectives.format ? { format: pendingDirectives.format } : {}),
      parse: Boolean(pendingDirectives.parse),
      ...(pendingDirectives.click ? { click: pendingDirectives.click } : {}),
    });
    pendingChannel.catchup = mergeCatchup(pendingChannel.catchup, pendingDirectives.catchup);
    const groupName = (pendingChannel as ChannelDraft & { groupName?: string }).groupName ?? "未分组";
    const group = groups.get(groupName) ?? { name: groupName, channels: [] };
    mergeChannelDraft(group.channels, pendingChannel);
    groups.set(groupName, group);
    pendingChannel = undefined;
    pendingDirectives = emptyDirectives();
  }
  return [...groups.values()];
}

function parseTxt(text: string, definition: LiveSourceDefinition, sourceUrl?: string): GroupDraft[] {
  const groups: GroupDraft[] = [];
  let current: GroupDraft = { name: "未分组", channels: [] };
  let directives = emptyDirectives();
  const inheritedHeaders = sourceHeaders(definition);

  const commitCurrent = () => {
    if (current.channels.length && !groups.includes(current)) groups.push(current);
  };

  for (const line of normalizedLines(text)) {
    if (!line || line.startsWith("//") || line.startsWith(";")) continue;
    const comma = line.indexOf(",");
    if (comma >= 0 && /#genre#/i.test(line.slice(comma + 1))) {
      commitCurrent();
      const parsedName = parseProtectedGroupName(line.slice(0, comma).trim() || "未分组");
      current = { name: parsedName.name, passwordProtected: parsedName.passwordProtected, channels: [] };
      directives = emptyDirectives();
      continue;
    }
    if (isDirectiveLine(line)) {
      applyDirective(directives, line);
      continue;
    }
    if (comma < 0) continue;
    const name = line.slice(0, comma).trim();
    const value = line.slice(comma + 1).trim();
    if (!name || !value.includes(":")) continue;
    const urlParts = splitTxtLines(value);
    const channelLines = urlParts.flatMap((part, index) => {
      const parsed = parseLineValue(part, sourceUrl);
      if (!parsed) return [];
      return [{
        name: parsed.name ?? `线路 ${index + 1}`,
        url: parsed.url,
        headers: mergeHeaders(inheritedHeaders, directives.headers, parsed.headers),
        ...(directives.format ? { format: directives.format } : {}),
        parse: Boolean(directives.parse),
        ...(directives.click ? { click: directives.click } : {}),
      }];
    });
    if (!channelLines.length) continue;
    mergeChannelDraft(current.channels, {
      name,
      catchup: mergeCatchup(definition.catchup, directives.catchup),
      lines: channelLines,
    });
  }
  commitCurrent();
  return groups;
}

function normalizeGroups(drafts: GroupDraft[], definition: LiveSourceDefinition): LiveGroup[] {
  return drafts.flatMap((draft, groupIndex) => {
    if (draft.passwordProtected && !definition.revealProtectedGroups) return [];
    const groupId = stableId(definition.id, draft.name || `group-${groupIndex}`);
    const channels = draft.channels.flatMap((channel, channelIndex): LiveChannel[] => {
      const normalizedName = channel.name.trim();
      if (!normalizedName) return [];
      const channelId = stableId(definition.id, draft.name, channel.tvgId ?? channel.tvgName ?? normalizedName, channel.number ?? "");
      const dedupedLines = dedupeLines(channel.lines);
      const displayNames = normalizeLineDisplayNames(dedupedLines);
      const lines = dedupedLines.map((line, lineIndex): LiveLine => ({
        id: stableId(channelId, line.url, line.name ?? "", String(lineIndex)),
        name: displayNames[lineIndex]!,
        url: line.url,
        headers: mergeHeaders(sourceHeaders(definition), line.headers),
        ...(line.format ? { format: normalizeFormat(line.format) } : {}),
        parse: Boolean(line.parse),
        ...(line.click ? { click: line.click } : {}),
        priority: lineIndex,
      }));
      if (!lines.length) return [];
      return [{
        id: channelId,
        sourceId: definition.id,
        groupId,
        name: normalizedName,
        ...(channel.number ? { number: channel.number } : {}),
        ...(resolveLogo(channel.logo, definition, channel) ? { logo: resolveLogo(channel.logo, definition, channel) } : {}),
        ...(channel.epgUrl ? { epgUrl: channel.epgUrl } : {}),
        ...(channel.tvgId ? { tvgId: channel.tvgId } : {}),
        ...(channel.tvgName ? { tvgName: channel.tvgName } : {}),
        lines,
        ...(channel.catchup ? { catchup: channel.catchup } : {}),
      }];
    });
    return channels.length ? [{
      id: groupId,
      sourceId: definition.id,
      name: draft.name || "未分组",
      passwordProtected: Boolean(draft.passwordProtected),
      channels,
    }] : [];
  });
}

function mergeChannelDraft(channels: ChannelDraft[], next: ChannelDraft): void {
  const identity = normalizeIdentity(next.tvgId ?? next.tvgName ?? next.name);
  const existing = channels.find((item) => normalizeIdentity(item.tvgId ?? item.tvgName ?? item.name) === identity);
  if (!existing) {
    channels.push(next);
    return;
  }
  existing.lines.push(...next.lines);
  existing.number ??= next.number;
  existing.logo ??= next.logo;
  existing.epgUrl ??= next.epgUrl;
  existing.tvgId ??= next.tvgId;
  existing.tvgName ??= next.tvgName;
  existing.catchup ??= next.catchup;
}

function dedupeLines(lines: ChannelDraft["lines"]): ChannelDraft["lines"] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = `${line.url}\u0000${JSON.stringify(Object.entries(line.headers ?? {}).sort())}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLineDisplayNames(lines: ChannelDraft["lines"]): string[] {
  const rawNames = lines.map((line) => line.name?.trim() ?? "");
  const totals = new Map<string, number>();
  for (const name of rawNames) {
    if (!name) continue;
    const identity = normalizeIdentity(name);
    totals.set(identity, (totals.get(identity) ?? 0) + 1);
  }

  const occurrences = new Map<string, number>();
  return rawNames.map((name, index) => {
    if (!name) return `线路 ${index + 1}`;
    const identity = normalizeIdentity(name);
    const total = totals.get(identity) ?? 1;
    if (total === 1) return name;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    if (/^线路\s*(?:[一二三四五六七八九十百千零〇两\d]+)?$/u.test(name)) return `线路 ${index + 1}`;
    return `${name}（${occurrence}）`;
  });
}

function parseLineValue(value: string, sourceUrl?: string): { url: string; name?: string; headers: HeadersMap } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const pipeIndex = trimmed.indexOf("|");
  const rawUrlAndName = pipeIndex >= 0 ? trimmed.slice(0, pipeIndex).trim() : trimmed;
  const headers = pipeIndex >= 0 ? parseHeaderQuery(trimmed.slice(pipeIndex + 1)) : {};
  const named = splitLineName(rawUrlAndName);
  const url = resolveMaybeUrl(named.url, sourceUrl);
  try {
    const parsed = new URL(url);
    if (!SUPPORTED_STREAM_PROTOCOLS.has(parsed.protocol)) return undefined;
  } catch {
    return undefined;
  }
  return { url, ...(named.name ? { name: named.name } : {}), headers };
}

function splitLineName(value: string): { url: string; name?: string } {
  const index = value.lastIndexOf("$");
  if (index <= value.indexOf("://") + 2) return { url: value };
  const suffix = value.slice(index + 1).trim();
  if (!suffix || /[/?#=&]/.test(suffix)) return { url: value };
  return { url: value.slice(0, index).trim(), name: suffix };
}

function splitTxtLines(value: string): string[] {
  return value.split(/#(?=(?:https?|rtmp|rtsp|udp|rtp):\/\/)/i).map((item) => item.trim()).filter(Boolean);
}

function parseHeaderQuery(value: string): HeadersMap {
  const headers: HeadersMap = {};
  for (const part of value.split("&")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = safeDecode(part.slice(0, index).trim());
    const headerValue = safeDecode(part.slice(index + 1).trim());
    if (key && headerValue && !/[\r\n]/.test(`${key}${headerValue}`)) headers[canonicalHeaderName(key)] = headerValue;
  }
  return headers;
}

function sourceHeaders(definition: LiveSourceDefinition): HeadersMap {
  return mergeHeaders(
    definition.header,
    definition.ua ? { "User-Agent": definition.ua } : undefined,
    definition.origin ? { Origin: definition.origin } : undefined,
    definition.referer ? { Referer: definition.referer } : undefined,
  );
}

function directiveHeaders(value: Record<string, unknown>): HeadersMap {
  return mergeHeaders(
    normalizeHeaders(value.header),
    stringValue(value.ua) ? { "User-Agent": stringValue(value.ua)! } : undefined,
    stringValue(value.origin) ? { Origin: stringValue(value.origin)! } : undefined,
    stringValue(value.referer ?? value.referrer) ? { Referer: stringValue(value.referer ?? value.referrer)! } : undefined,
  );
}

function emptyDirectives(): DirectiveState {
  return { headers: {} };
}

function isDirectiveLine(line: string): boolean {
  return /^(?:ua|origin|referer|referrer|header|format|parse|click|catchup|catchup-source|catchup-replace)\s*=/i.test(line);
}

function applyDirective(state: DirectiveState, line: string): void {
  const index = line.indexOf("=");
  if (index <= 0) return;
  const key = line.slice(0, index).trim().toLowerCase();
  const value = line.slice(index + 1).trim();
  if (!value && key !== "parse") return;
  if (key === "ua") state.headers["User-Agent"] = value;
  else if (key === "origin") state.headers.Origin = value;
  else if (key === "referer" || key === "referrer") state.headers.Referer = value;
  else if (key === "header") Object.assign(state.headers, parseJsonHeaders(value));
  else if (key === "format") state.format = value;
  else if (key === "parse") state.parse = Number(value) === 1 || value.toLowerCase() === "true";
  else if (key === "click") state.click = value;
  else if (key === "catchup") state.catchup = { ...(state.catchup ?? {}), type: value };
  else if (key === "catchup-source") state.catchup = { ...(state.catchup ?? {}), source: value };
  else if (key === "catchup-replace") state.catchup = { ...(state.catchup ?? {}), replace: value };
}

function applyM3uDirective(state: DirectiveState, line: string): void {
  if (/^#EXTHTTP:/i.test(line)) {
    Object.assign(state.headers, parseJsonHeaders(line.slice(line.indexOf(":") + 1).trim()));
    return;
  }
  if (/^#EXTVLCOPT:/i.test(line)) {
    const payload = line.slice(line.indexOf(":") + 1);
    const index = payload.indexOf("=");
    if (index <= 0) return;
    const key = payload.slice(0, index).trim().toLowerCase();
    const value = payload.slice(index + 1).trim();
    if (key === "http-user-agent") state.headers["User-Agent"] = value;
    else if (key === "http-referrer" || key === "http-referer") state.headers.Referer = value;
    else if (key === "http-origin") state.headers.Origin = value;
    return;
  }
  if (/^#KODIPROP:/i.test(line)) {
    const payload = line.slice(line.indexOf(":") + 1);
    const index = payload.indexOf("=");
    if (index <= 0) return;
    const key = payload.slice(0, index).trim().toLowerCase();
    const value = payload.slice(index + 1).trim();
    if (key.endsWith("manifest_type")) state.format = value;
    if (key.endsWith("stream_headers") || key.endsWith("common_headers")) Object.assign(state.headers, parseHeaderQuery(value));
  }
}

function parseJsonHeaders(value: string): HeadersMap {
  try {
    return normalizeHeaders(JSON.parse(value));
  } catch {
    return {};
  }
}

function normalizeHeaders(value: unknown): HeadersMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, raw]) => {
    const headerValue = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
    if (!key.trim() || !headerValue || /[\r\n]/.test(`${key}${headerValue}`)) return [];
    return [[canonicalHeaderName(key.trim()), headerValue]];
  }));
}

function mergeHeaders(...values: Array<HeadersMap | undefined>): HeadersMap {
  return Object.assign({}, ...values.filter(Boolean));
}

function normalizeCatchup(value: unknown): LiveCatchup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: LiveCatchup = {};
  if (stringValue(raw.type)) result.type = stringValue(raw.type);
  if (stringValue(raw.regex)) result.regex = stringValue(raw.regex);
  if (stringValue(raw.source)) result.source = stringValue(raw.source);
  if (stringValue(raw.replace)) result.replace = stringValue(raw.replace);
  return Object.keys(result).length ? result : undefined;
}

function catchupFromAttributes(attrs: Record<string, string>): LiveCatchup | undefined {
  const value: LiveCatchup = {};
  if (attrs.catchup) value.type = attrs.catchup;
  if (attrs["catchup-source"]) value.source = attrs["catchup-source"];
  if (attrs["catchup-replace"]) value.replace = attrs["catchup-replace"];
  return Object.keys(value).length ? value : undefined;
}

function mergeCatchup(base?: LiveCatchup, override?: LiveCatchup): LiveCatchup | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function parseAttributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value)) !== null) {
    result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function findUnquotedComma(value: string): number {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ",") return index;
  }
  return -1;
}

function parseProtectedGroupName(value: string): { name: string; passwordProtected: boolean } {
  const index = value.lastIndexOf("_");
  if (index <= 0 || index === value.length - 1) return { name: value || "未分组", passwordProtected: false };
  return { name: value.slice(0, index).trim() || "未分组", passwordProtected: true };
}

function normalizedLines(text: string): string[] {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());
}

function normalizeFormat(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["m3u8", "hls", "application/x-mpegurl", "application/vnd.apple.mpegurl"].includes(normalized)) return "hls";
  if (["mpd", "dash", "application/dash+xml"].includes(normalized)) return "dash";
  if (["ts", "video/mp2t"].includes(normalized)) return "ts";
  if (["flv", "video/x-flv"].includes(normalized)) return "flv";
  return normalized;
}

function resolveLogo(value: string | undefined, definition: LiveSourceDefinition, channel: ChannelDraft): string | undefined {
  const template = value || definition.logo;
  if (!template) return undefined;
  const id = channel.tvgId ?? channel.tvgName ?? channel.name;
  const rendered = template
    .replaceAll("{id}", encodeURIComponent(id))
    .replaceAll("{name}", encodeURIComponent(channel.name))
    .replaceAll("{logo}", encodeURIComponent(value ?? ""));
  return resolveMaybeUrl(rendered, definition.url);
}

function resolveMaybeUrl(value: string | undefined, baseUrl?: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    return baseUrl ? new URL(trimmed, baseUrl).toString() : new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function stableId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 20);
}

function normalizeIdentity(value: string): string {
  return value.toLowerCase().replace(/[\s_\-—–·（）()\[\]]+/g, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

function canonicalHeaderName(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "user-agent" || normalized === "ua") return "User-Agent";
  if (normalized === "referer" || normalized === "referrer") return "Referer";
  if (normalized === "origin") return "Origin";
  if (normalized === "authorization") return "Authorization";
  if (normalized === "cookie") return "Cookie";
  return value;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result || undefined;
}
