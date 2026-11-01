import type { EpgProgramme } from "./epg-models.ts";
import type { LiveChannel, LiveLine } from "./live-models.ts";

export interface LiveCatchupPlayback {
  channel: LiveChannel;
  line: LiveLine;
  programme: EpgProgramme;
}

export function supportsLiveCatchup(channel: Pick<LiveChannel, "catchup">): boolean {
  const catchup = channel.catchup;
  if (!catchup) return false;
  const type = String(catchup.type ?? "").trim().toLowerCase();
  if (type === "replace") return Boolean(catchup.regex && catchup.replace);
  if (["flussonic", "fs"].includes(type)) return true;
  return Boolean(catchup.source);
}

export function buildLiveCatchupPlayback(
  channel: LiveChannel,
  line: LiveLine,
  programme: EpgProgramme,
  now = Date.now(),
): LiveCatchupPlayback {
  if (!supportsLiveCatchup(channel)) throw new Error("当前频道未配置可用的回看规则");
  if (!Number.isFinite(programme.startAt) || !Number.isFinite(programme.endAt) || programme.endAt <= programme.startAt) {
    throw new Error("节目时间范围无效，无法生成回看地址");
  }
  if (programme.startAt > now + 60_000) throw new Error("未来节目不能回看");

  const catchup = channel.catchup!;
  const type = String(catchup.type ?? "custom").trim().toLowerCase();
  const variables = catchupVariables(channel, programme, now);
  let url = "";

  if (type === "replace") {
    const pattern = String(catchup.regex ?? "").trim();
    const replacement = expandCatchupTemplate(String(catchup.replace ?? ""), variables);
    if (!pattern || !replacement) throw new Error("回看 replace 规则不完整");
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw new Error("回看 replace 正则表达式无效");
    }
    url = line.url.replace(regex, replacement);
    if (url === line.url) throw new Error("回看 replace 规则未命中当前线路");
  } else if (["flussonic", "fs"].includes(type) && !String(catchup.source ?? "").trim()) {
    url = buildFlussonicCatchupUrl(line.url, variables.utc ?? "");
  } else {
    const template = String(catchup.source ?? "").trim();
    if (!template) throw new Error("回看规则缺少 catchup-source");
    const expanded = expandCatchupTemplate(template, variables);
    if (type === "append") url = `${line.url}${expanded}`;
    else if (type === "query") url = appendQuery(line.url, expanded);
    else if (type === "shift") url = expanded.includes("://") ? expanded : appendQuery(line.url, expanded);
    else url = expanded;
  }

  const normalizedUrl = validateCatchupUrl(url, line.url);
  const { health: _liveHealth, ...lineWithoutHealth } = line;
  const catchupLine: LiveLine = {
    ...lineWithoutHealth,
    id: `${line.id}-catchup-${programme.startAt}`,
    name: `回看 · ${programme.title}`,
    url: normalizedUrl,
    headers: { ...line.headers },
    priority: 0,
  };
  return {
    programme: { ...programme, categories: [...programme.categories] },
    line: catchupLine,
    channel: {
      ...channel,
      name: `${channel.name} · ${programme.title}`,
      lines: [catchupLine],
    },
  };
}

export function expandCatchupTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\$?\{(utcend|utc|lutcend|lutc|duration|offset|start|end|name|title)\}/gi, (_match, key: string) => variables[key.toLowerCase()] ?? "");
}

function catchupVariables(channel: LiveChannel, programme: EpgProgramme, now: number): Record<string, string> {
  const startSeconds = Math.floor(programme.startAt / 1_000);
  const endSeconds = Math.floor(programme.endAt / 1_000);
  return {
    utc: String(startSeconds),
    utcend: String(endSeconds),
    lutc: compactLocalDate(programme.startAt),
    lutcend: compactLocalDate(programme.endAt),
    duration: String(Math.max(1, endSeconds - startSeconds)),
    offset: String(Math.max(0, Math.floor((now - programme.startAt) / 1_000))),
    start: encodeURIComponent(new Date(programme.startAt).toISOString()),
    end: encodeURIComponent(new Date(programme.endAt).toISOString()),
    name: encodeURIComponent(channel.name),
    title: encodeURIComponent(programme.title),
  };
}

function compactLocalDate(value: number): string {
  const date = new Date(value);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ];
  return parts.join("");
}

function appendQuery(base: string, value: string): string {
  if (!value) return base;
  if (value.startsWith("?")) return `${base}${base.includes("?") ? "&" : "?"}${value.slice(1)}`;
  if (value.startsWith("&")) return `${base}${base.includes("?") ? "" : "?"}${value.slice(base.includes("?") ? 0 : 1)}`;
  return `${base}${base.includes("?") ? "&" : "?"}${value}`;
}

function buildFlussonicCatchupUrl(baseUrl: string, utc: string): string {
  const url = new URL(baseUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const fileName = parts.pop() ?? "index.m3u8";
  const extension = /\.ts(?:$|\?)/i.test(fileName) ? "ts" : "m3u8";
  url.pathname = `/${[...parts, `timeshift_abs-${utc}.${extension}`].join("/")}`;
  return url.toString();
}

function validateCatchupUrl(value: string, baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new Error("生成的回看地址无效");
  }
  if (!["http:", "https:", "rtmp:", "rtsp:"].includes(url.protocol)) {
    throw new Error(`回看地址协议不受支持：${url.protocol}`);
  }
  return url.toString();
}
