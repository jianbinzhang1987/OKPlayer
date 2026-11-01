export type LiveFailureCategory = "authentication" | "geo-restriction" | "rate-limit" | "origin" | "network" | "invalid-media" | "drm" | "unsupported-protocol" | "unknown";

export interface LiveFailureClassification {
  category: LiveFailureCategory;
  label: string;
  userMessage: string;
  definitive: boolean;
}

export function classifyLiveFailure(reason: unknown, statusCode?: number): LiveFailureClassification {
  const message = String(reason ?? "").trim();
  const status = Number.isFinite(Number(statusCode)) ? Number(statusCode) : httpStatusFromText(message);

  if (status === 401 || /(?:鉴权|认证|登录|token|cookie|unauthori[sz]ed|credentials?)/i.test(message)) {
    return {
      category: "authentication",
      label: "鉴权失败",
      userMessage: "直播线路需要有效的 Cookie、Token 或专用请求头，请更新直播源授权信息。",
      definitive: true,
    };
  }
  if (status === 451 || /(?:地区限制|区域限制|geo.?block|not available in your (?:country|region)|法律限制)/i.test(message)) {
    return {
      category: "geo-restriction",
      label: "地区限制",
      userMessage: "该直播线路受到地区或服务区域限制，请选择其他线路。",
      definitive: true,
    };
  }
  if (status === 429 || /(?:too many requests|rate.?limit|请求过于频繁|限流)/i.test(message)) {
    return {
      category: "rate-limit",
      label: "服务限流",
      userMessage: "直播服务当前请求过多，已保留为备用线路，请稍后重试。",
      definitive: false,
    };
  }
  if ((status >= 500 && status <= 599) || /(?:bad gateway|service unavailable|gateway timeout|源站故障|上游服务)/i.test(message)) {
    return {
      category: "origin",
      label: "源站故障",
      userMessage: "直播源服务器暂时异常，正在尝试其他线路。",
      definitive: false,
    };
  }
  if ([400, 404, 410].includes(status) || /(?:不是有效 HLS|无效.*清单|无效.*分片|返回内容.*HTML|媒体格式不匹配)/i.test(message)) {
    return {
      category: "invalid-media",
      label: "媒体地址失效",
      userMessage: "直播地址或媒体清单已经失效，请刷新直播源或选择其他线路。",
      definitive: true,
    };
  }
  if (/(?:DRM|Widevine|FairPlay|PlayReady|SAMPLE-AES|ContentProtection)/i.test(message)) {
    return {
      category: "drm",
      label: "DRM 保护",
      userMessage: "该直播线路使用受保护的 DRM 内容，当前播放器不能绕过授权系统播放。",
      definitive: true,
    };
  }
  if (/暂不支持协议|unsupported protocol|协议不受支持/i.test(message)) {
    return {
      category: "unsupported-protocol",
      label: "协议不受支持",
      userMessage: "当前播放内核不支持这条线路的协议，请选择其他线路。",
      definitive: true,
    };
  }
  if (/timeout|timed out|超时|network|socket|dns|econn|enotfound|连接中断|connection reset/i.test(message)) {
    return {
      category: "network",
      label: "网络异常",
      userMessage: "当前网络或直播服务器响应较慢，正在尝试备用线路。",
      definitive: false,
    };
  }
  return {
    category: "unknown",
    label: "播放异常",
    userMessage: message || "直播线路暂时无法播放，正在尝试其他线路。",
    definitive: false,
  };
}

function httpStatusFromText(message: string): number {
  const matched = message.match(/\bHTTP\s*(\d{3})\b/i);
  return matched ? Number(matched[1]) : 0;
}
