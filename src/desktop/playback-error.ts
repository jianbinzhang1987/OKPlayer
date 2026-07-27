export type PlaybackFailureCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "SOURCE_RESOLVE_FAILED"
  | "MEDIA_URL_EXPIRED"
  | "MEDIA_HEADER_REQUIRED"
  | "RANGE_PROXY_FAILED"
  | "WEB_ENGINE_UNSUPPORTED"
  | "COMPAT_ENGINE_FAILED"
  | "EXTERNAL_PLAYER_UNSAFE"
  | "EXTERNAL_PLAYER_FAILED"
  | "LINE_UNAVAILABLE"
  | "PREPARATION_TIMEOUT"
  | "CANCELLED"
  | "UNKNOWN";

export type PlaybackSourceImpact = "none" | "degraded" | "blocked";

export interface SerializedPlaybackFailure {
  code: PlaybackFailureCode;
  message: string;
  userMessage: string;
  retryable: boolean;
  sourceImpact: PlaybackSourceImpact;
}

interface PlaybackFailureOptions {
  userMessage?: string;
  retryable?: boolean;
  sourceImpact?: PlaybackSourceImpact;
  cause?: unknown;
}

export class PlaybackFailure extends Error {
  readonly code: PlaybackFailureCode;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly sourceImpact: PlaybackSourceImpact;

  constructor(code: PlaybackFailureCode, message: string, options: PlaybackFailureOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PlaybackFailure";
    this.code = code;
    this.userMessage = options.userMessage ?? defaultUserMessage(code);
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.sourceImpact = options.sourceImpact ?? defaultSourceImpact(code);
  }
}

export function classifyPlaybackFailure(error: unknown, fallbackCode: PlaybackFailureCode = "UNKNOWN"): PlaybackFailure {
  if (error instanceof PlaybackFailure) return error;
  const message = error instanceof Error ? error.message : String(error ?? "未知播放错误");

  if (/取消|aborted|aborterror/i.test(message)) {
    return new PlaybackFailure("CANCELLED", message, { cause: error });
  }
  if (/超过\s*15\s*秒|解析超时|准备超时|timeout|timed out/i.test(message)) {
    return new PlaybackFailure("PREPARATION_TIMEOUT", message, { cause: error });
  }
  if (/未登录|尚未登录|需要登录|请先登录|cookie\s*(?:为空|缺失|不存在)|token\s*(?:为空|缺失|不存在)/i.test(message)) {
    return new PlaybackFailure("AUTH_REQUIRED", message, { cause: error });
  }
  if (/登录.*(?:失效|过期)|cookie.*(?:失效|过期)|token.*(?:失效|过期)|凭据.*(?:失效|过期)|授权.*(?:失效|过期)/i.test(message)) {
    return new PlaybackFailure("AUTH_EXPIRED", message, { cause: error });
  }
  if (/range|content-range|http\s*206|分片|chunk|incomplete|代理.*(?:失败|异常)|proxy.*(?:failed|error)/i.test(message)) {
    return new PlaybackFailure("RANGE_PROXY_FAILED", message, { cause: error });
  }
  if (/referer|user-agent|请求头|header|防盗链/i.test(message)) {
    return new PlaybackFailure("MEDIA_HEADER_REQUIRED", message, { cause: error });
  }
  if (/链接.*(?:失效|过期)|地址.*(?:失效|过期)|签名.*(?:失效|过期)|http\s*(?:403|410)/i.test(message)) {
    return new PlaybackFailure("MEDIA_URL_EXPIRED", message, { cause: error });
  }
  if (/media source extensions|\bmse\b|hls\.js|内置.*(?:不支持|失败)|媒体加载失败|错误代码\s*[1-4]/i.test(message)) {
    return new PlaybackFailure("WEB_ENGINE_UNSUPPORTED", message, { cause: error });
  }
  if (/\bmpv\b|兼容播放器|兼容模式|播放器.*(?:启动失败|不可用)|spawn.*(?:failed|error)/i.test(message)) {
    return new PlaybackFailure("COMPAT_ENGINE_FAILED", message, { cause: error });
  }
  if (/未返回有效播放地址|没有可播放剧集|无可播放剧集|线路.*(?:失效|不可用)|媒体直链不可用|http\s*(?:404|451)|响应内容是\s*html|格式不匹配/i.test(message)) {
    return new PlaybackFailure("LINE_UNAVAILABLE", message, { cause: error });
  }
  if (/解析失败|嗅探失败|未发现可播放|播放器接口|player.*(?:failed|error)/i.test(message)) {
    return new PlaybackFailure("SOURCE_RESOLVE_FAILED", message, { cause: error });
  }

  return new PlaybackFailure(fallbackCode, message, { cause: error });
}

export function serializePlaybackFailure(error: unknown): SerializedPlaybackFailure {
  const failure = classifyPlaybackFailure(error);
  return {
    code: failure.code,
    message: failure.message,
    userMessage: failure.userMessage,
    retryable: failure.retryable,
    sourceImpact: failure.sourceImpact,
  };
}

export function isSerializedPlaybackFailure(value: unknown): value is SerializedPlaybackFailure {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SerializedPlaybackFailure>;
  return typeof record.code === "string"
    && typeof record.message === "string"
    && typeof record.userMessage === "string"
    && typeof record.retryable === "boolean"
    && ["none", "degraded", "blocked"].includes(String(record.sourceImpact));
}

function defaultUserMessage(code: PlaybackFailureCode): string {
  switch (code) {
    case "AUTH_REQUIRED": return "该内容需要先登录对应网盘。";
    case "AUTH_EXPIRED": return "网盘登录已失效，请重新登录。";
    case "MEDIA_URL_EXPIRED": return "播放地址已过期，请重新解析或更换线路。";
    case "MEDIA_HEADER_REQUIRED": return "当前媒体需要完整的访问凭据，请重试或切换高兼容播放器。";
    case "RANGE_PROXY_FAILED": return "媒体分段传输异常，请重试或切换高兼容播放器。";
    case "WEB_ENGINE_UNSUPPORTED": return "内置播放器无法播放该媒体，正在尝试高兼容播放器。";
    case "COMPAT_ENGINE_FAILED": return "高兼容播放器启动失败，可尝试其他线路或外部播放器。";
    case "EXTERNAL_PLAYER_UNSAFE": return "该媒体需要受保护的访问凭据，不能安全交给外部播放器，请继续使用应用内播放或更换线路。";
    case "EXTERNAL_PLAYER_FAILED": return "外部播放器未能打开媒体，请检查播放器是否已安装或改用系统默认播放器。";
    case "LINE_UNAVAILABLE": return "当前播放线路不可用，可以尝试其他线路或来源。";
    case "SOURCE_RESOLVE_FAILED": return "当前来源暂时无法解析播放地址，可以重试或更换来源。";
    case "PREPARATION_TIMEOUT": return "播放地址解析超时，可以重试或更换来源。";
    case "CANCELLED": return "播放准备已取消。";
    default: return "播放失败，可以重试或更换线路。";
  }
}

function defaultRetryable(code: PlaybackFailureCode): boolean {
  return !["CANCELLED", "AUTH_REQUIRED", "AUTH_EXPIRED"].includes(code);
}

function defaultSourceImpact(code: PlaybackFailureCode): PlaybackSourceImpact {
  switch (code) {
    case "SOURCE_RESOLVE_FAILED":
    case "LINE_UNAVAILABLE":
    case "PREPARATION_TIMEOUT":
      return "degraded";
    default:
      return "none";
  }
}
