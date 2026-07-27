import { redactSensitiveText } from "../../core/log-redaction.ts";

export type RendererErrorContext =
  | "home"
  | "search"
  | "source"
  | "config"
  | "library"
  | "detail"
  | "records"
  | "account"
  | "settings"
  | "playback"
  | "generic";

export type RendererRecoveryAction =
  | "retry-home"
  | "retry-search"
  | "repair-sources"
  | "retry-configs"
  | "retry-library"
  | "retry-records"
  | "retry-account"
  | "back"
  | "";

export interface RendererErrorPresentation {
  message: string;
  technicalDetail: string;
  recoveryAction: RendererRecoveryAction;
  recoveryLabel: string;
}

const CONTEXT_COPY: Record<RendererErrorContext, { message: string; action: RendererRecoveryAction; label: string }> = {
  home: { message: "首页内容暂时无法加载。", action: "retry-home", label: "重新加载" },
  search: { message: "搜索暂时没有完成。", action: "retry-search", label: "重新搜索" },
  source: { message: "内容来源操作没有完成。", action: "repair-sources", label: "检查并修复" },
  config: { message: "内容来源配置没有处理成功。", action: "retry-configs", label: "重新加载配置" },
  library: { message: "片库内容暂时无法加载。", action: "retry-library", label: "重新加载片库" },
  detail: { message: "影片详情暂时无法打开。", action: "back", label: "返回上一页" },
  records: { message: "本地收藏或观看记录操作没有完成。", action: "retry-records", label: "刷新记录" },
  account: { message: "账号操作没有完成。", action: "retry-account", label: "重新检查账号" },
  settings: { message: "设置操作没有完成。", action: "", label: "" },
  playback: { message: "播放没有成功，可以重试或更换线路。", action: "", label: "" },
  generic: { message: "操作没有完成，请稍后重试。", action: "", label: "" },
};

export function presentRendererError(
  value: unknown,
  context: RendererErrorContext,
  userMessage?: string,
): RendererErrorPresentation {
  const raw = extractErrorMessage(value);
  const detail = normalizeTechnicalDetail(raw);
  const fallback = CONTEXT_COPY[context];
  const structuredUserMessage = structuredMessage(value, "userMessage");
  let message = userMessage?.trim() || structuredUserMessage || contextSpecificMessage(detail, context) || fallback.message;
  message = redactSensitiveText(message).trim() || fallback.message;
  return {
    message,
    technicalDetail: detail && detail !== message ? detail : "",
    recoveryAction: fallback.action,
    recoveryLabel: fallback.label,
  };
}

export function normalizeTechnicalDetail(value: unknown): string {
  return redactSensitiveText(String(value ?? ""))
    .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function extractErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["technicalDetail", "message", "error", "reason"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key];
    }
  }
  return String(value ?? "");
}

function structuredMessage(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function contextSpecificMessage(detail: string, context: RendererErrorContext): string {
  if (!detail) return "";
  if (/AUTH_REQUIRED|AUTH_EXPIRED|未登录|登录.*(?:失效|过期)|Cookie.*(?:失效|过期)/i.test(detail)) {
    return "账号登录状态已失效，请重新登录或换一个来源。";
  }
  if (/timeout|timed out|超时|等待时间过长/i.test(detail)) {
    if (context === "search") return "搜索等待时间过长，已保留其他来源返回的结果。";
    if (context === "playback") return "播放地址准备时间过长，可以重试或更换线路。";
    return "连接等待时间过长，请稍后重试。";
  }
  if (/network|fetch failed|ECONN|ENOTFOUND|HTTP 5\d\d|网络|连接失败/i.test(detail)) {
    if (context === "source" || context === "config") return "内容来源暂时无法连接。";
    return "网络连接暂时不可用，请检查网络后重试。";
  }
  if (/配置|config|JSON|格式|解析/i.test(detail) && context === "config") {
    return "配置未能导入，请检查地址、文件格式或兼容性。";
  }
  if (/不存在|not found|404/i.test(detail) && context === "detail") {
    return "该影片在原来源中已不存在，可以查找其他来源。";
  }
  return "";
}
