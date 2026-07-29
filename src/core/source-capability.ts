import type { SiteConfig } from "./models.ts";
import { STANDARD_CAPABILITIES, UNSUPPORTED_CAPABILITIES, type SourceCapabilities } from "./source-adapter.ts";

export type SourceRuntime =
  | "http"
  | "javascript"
  | "drpy"
  | "t4"
  | "appysv2"
  | "xbpq"
  | "xyq"
  | "catopen"
  | "alist"
  | "catvod-node"
  | "android-dex"
  | "unknown";

export interface SourceCapability {
  supported: boolean;
  runtime: SourceRuntime;
  capabilities: SourceCapabilities;
  reason?: string;
}

function resourceUrl(value?: string): string {
  return (value ?? "").split(";md5;")[0]?.trim() ?? "";
}

function standard(capabilities: Partial<SourceCapabilities> = {}): SourceCapabilities {
  return { ...STANDARD_CAPABILITIES, ...capabilities };
}

function unavailable(runtime: SourceRuntime, reason: string): SourceCapability {
  return {
    supported: false,
    runtime,
    capabilities: { ...UNSUPPORTED_CAPABILITIES },
    reason,
  };
}

function appYsV2(site: SiteConfig): SourceCapability {
  const ext = site.ext?.trim() ?? "";
  if (!/^https?:\/\//i.test(ext)) {
    return unavailable("appysv2", "AppYsV2 播放源需要在 ext 中配置 HTTP/HTTPS API 地址");
  }
  return {
    supported: true,
    runtime: "appysv2",
    capabilities: standard(),
  };
}

function xyq(site: SiteConfig): SourceCapability {
  if (!site.ext?.trim()) return unavailable("xyq", "XYQ 播放源缺少 ext 规则");
  return {
    supported: true,
    runtime: "xyq",
    capabilities: standard(),
  };
}

function xbpq(site: SiteConfig): SourceCapability {
  if (!site.ext?.trim()) return unavailable("xbpq", "XBPQ 播放源缺少 ext 规则");
  return {
    supported: true,
    runtime: "xbpq",
    capabilities: standard(),
  };
}

function alist(site: SiteConfig): SourceCapability {
  if (!site.ext?.trim()) return unavailable("alist", "Alist 播放源缺少 ext 配置");
  return {
    supported: true,
    runtime: "alist",
    capabilities: standard(),
  };
}

function catopen(site: SiteConfig): SourceCapability {
  const scriptUrl = /^https?:\/\//i.test(site.api.trim())
    ? site.api.trim()
    : /^csp_catopen$/i.test(site.api.trim()) && /^https?:\/\//i.test(site.ext?.trim() ?? "")
      ? site.ext!.trim()
      : "";
  if (!scriptUrl) return unavailable("catopen", "CatOpen 播放源缺少可访问的 JavaScript 脚本 URL");
  return {
    supported: true,
    runtime: "catopen",
    capabilities: standard({ proxy: true }),
  };
}

export function getSiteCapability(site: SiteConfig): SourceCapability {
  if (site.type === 15 || /^catvod:\/\//i.test(site.api.trim())) {
    return {
      supported: true,
      runtime: "catvod-node",
      capabilities: standard({
        search: site.searchable !== 0 && !["tool", "discovery", "pan"].includes(site.contentType ?? ""),
        detail: site.contentType !== "tool" && site.contentType !== "discovery",
        player: site.contentType !== "tool" && site.contentType !== "discovery",
        proxy: true,
        health: true,
      }),
    };
  }

  if ([0, 1].includes(site.type)) {
    return {
      supported: true,
      runtime: "http",
      capabilities: standard(),
    };
  }

  if ([4, 6, 8].includes(site.type)) {
    if (/^https?:\/\//i.test(site.api.trim())) {
      return {
        supported: true,
        runtime: "t4",
        capabilities: standard({ proxy: true, health: true }),
      };
    }
    return {
      supported: false,
      runtime: "t4",
      capabilities: { ...UNSUPPORTED_CAPABILITIES },
      reason: "T4 播放源必须配置可访问的 HTTP/HTTPS 服务地址",
    };
  }

  if (site.type === 7) {
    if (!site.ext?.trim()) return unavailable("drpy", "Drpy 播放源缺少 ext 规则脚本");
    return { supported: true, runtime: "drpy", capabilities: standard() };
  }
  if (site.type === 9) return xbpq(site);
  if (site.type === 10) return xyq(site);
  if (site.type === 11) return appYsV2(site);
  if (site.type === 13) return alist(site);
  if (site.type === 14) return catopen(site);

  if (site.type !== 3) {
    return unavailable("unknown", `暂不支持 type=${site.type} 播放源`);
  }

  const api = site.api.trim();
  const ext = site.ext?.trim() ?? "";
  if (/^csp_appysv2$/i.test(api)) return appYsV2(site);
  if (/^csp_xbpq$/i.test(api)) return xbpq(site);
  if (/^csp_xyq(?:hiker)?$/i.test(api)) return xyq(site);
  if (/^csp_alist$/i.test(api)) return alist(site);
  if (/^csp_catopen$/i.test(api)) return catopen(site);

  const apiIsScript = /^https?:\/\//i.test(api) && /(?:\.js)(?:$|[?#])/i.test(api);
  const extIsRuleScript = /^(?:https?:\/\/|file:)/i.test(ext) && /(?:\.js)(?:$|[?#])/i.test(ext)
    || /(?:^|\s)(?:var|let|const)\s+rule\b|module\.exports|export\s+default/i.test(ext);
  const drpyRuntime = ext !== "" && (/drpy/i.test(api) || (apiIsScript && extIsRuleScript));
  if (drpyRuntime || /^csp_drpy\d*$/i.test(api)) {
    if (!ext) {
      return unavailable("drpy", "Drpy 播放源缺少 ext 规则脚本");
    }
    return {
      supported: true,
      runtime: "drpy",
      capabilities: standard(),
    };
  }

  if (/^https?:\/\//i.test(api) && /(?:\.js)(?:$|[?#])/i.test(api)) {
    return {
      supported: true,
      runtime: "javascript",
      capabilities: standard(),
    };
  }

  if (/^csp_/i.test(api)) {
    const jar = resourceUrl(site.jar);
    const detail = jar ? `，插件：${jar}` : "";
    return {
      supported: false,
      runtime: "android-dex",
      capabilities: { ...UNSUPPORTED_CAPABILITIES },
      reason: `依赖 Android Dex/JAR Spider（${api}）${detail}；该运行时不能在 macOS 进程中直接执行`,
    };
  }

  return unavailable("unknown", "无法识别该 type=3 Spider 的执行格式");
}

export function withSiteCapability(site: SiteConfig) {
  return { ...site, ...getSiteCapability(site) };
}
