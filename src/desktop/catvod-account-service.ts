export type PanProviderId = "quark" | "uc" | "baidu" | "pan115" | "pan189" | "pan139";
export type PanLoginProviderId = "quark" | "ucCookie" | "ucToken" | "baidu" | "pan115" | "pan189" | "pan139";
export type PanLoginState = "waiting" | "success" | "expired" | "error" | "cancelled";
export type PanAccountState = "connected" | "expired" | "not-configured" | "unavailable";
export type PanCredentialMode = "cookie" | "tv-token" | "scan" | "account-password" | "unknown";

export const PAN_PROVIDER_IDS: readonly PanProviderId[] = ["quark", "uc", "baidu", "pan115", "pan189", "pan139"];

export interface PanProviderStatus {
  provider: PanProviderId;
  name: string;
  configured: boolean;
  login: boolean;
  accountState: PanAccountState;
  credentialMode: PanCredentialMode;
  state: string;
  label: string;
  checkedAt: number;
}

export interface PanLoginResult {
  provider: PanLoginProviderId;
  taskId?: string;
  status: PanLoginState;
  terminal: boolean;
  message: string;
  qrImage?: string;
}

export type CatVodAccountFetch = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const PROVIDER_NAMES: Record<PanProviderId, string> = {
  quark: "夸克网盘",
  uc: "UC 网盘",
  baidu: "百度网盘",
  pan115: "115 网盘",
  pan189: "天翼云盘",
  pan139: "移动云盘",
};

export class CatVodAccountService {
  private readonly baseUrlProvider: () => string | undefined;
  private readonly fetchImpl: CatVodAccountFetch;
  private readonly activeLoginProviders = new Map<string, PanLoginProviderId>();
  private readonly activeLoginTasksByProvider = new Map<PanLoginProviderId, string>();

  constructor(baseUrlProvider: () => string | undefined, fetchImpl: CatVodAccountFetch = (input, init) => fetch(input, init)) {
    this.baseUrlProvider = baseUrlProvider;
    this.fetchImpl = fetchImpl;
  }

  async status(provider: PanProviderId = "quark"): Promise<PanProviderStatus> {
    assertProvider(provider);
    return (await this.statuses([provider]))[0]!;
  }

  async statuses(providerIds: readonly PanProviderId[] = PAN_PROVIDER_IDS): Promise<PanProviderStatus[]> {
    const requested = providerIds.map((provider) => {
      assertProvider(provider);
      return provider;
    });
    const response = await this.request("/website/api/status", { method: "GET" });
    const data = asRecord(response.data);
    const providers = asRecord(data.providers);
    const checkedAt = Date.now();
    return requested.map((provider) => {
      const raw = asRecord(providers[provider]);
      const configured = raw.configured === true;
      const login = raw.login === true;
      return {
        provider,
        name: PROVIDER_NAMES[provider],
        configured,
        login,
        accountState: normalizeAccountState(raw.accountState ?? raw.status, configured, login),
        credentialMode: normalizeCredentialMode(raw.credentialMode ?? raw.loginMode ?? raw.mode, raw.state, raw.label),
        state: safeText(raw.state, login ? "已登录" : configured ? "登录已失效" : "未登录"),
        label: safeText(raw.label, PROVIDER_NAMES[provider]),
        checkedAt,
      };
    });
  }

  async start(provider: PanLoginProviderId = "quark"): Promise<PanLoginResult> {
    assertLoginProvider(provider);
    const previousTaskId = this.activeLoginTasksByProvider.get(provider);
    if (previousTaskId) await this.cancel(previousTaskId).catch(() => this.forgetTask(previousTaskId));
    const response = await this.request("/website/api/login/start", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    const result = normalizeLoginResult(provider, response);
    if (!result.taskId) throw new Error("CatVod 未返回有效登录任务");
    if (!result.qrImage) throw new Error("CatVod 未返回有效登录二维码");
    this.activeLoginProviders.set(result.taskId, provider);
    this.activeLoginTasksByProvider.set(provider, result.taskId);
    return result;
  }

  async poll(provider: PanLoginProviderId, taskId: string): Promise<PanLoginResult> {
    assertLoginProvider(provider);
    const safeTaskId = validateTaskId(taskId);
    const owner = this.activeLoginProviders.get(safeTaskId);
    if (!owner) throw new Error("登录任务不存在或已结束");
    if (owner !== provider) throw new Error("登录任务与网盘不匹配");
    const response = await this.request("/website/api/login/poll", {
      method: "POST",
      body: JSON.stringify({ provider, taskId: safeTaskId }),
    });
    const result = normalizeLoginResult(provider, response, safeTaskId);
    if (result.terminal) this.forgetTask(safeTaskId);
    return result;
  }

  async cancel(taskId: string): Promise<PanLoginResult> {
    const safeTaskId = validateTaskId(taskId);
    const provider = this.activeLoginProviders.get(safeTaskId);
    if (!provider) throw new Error("登录任务不存在或已结束");
    await this.request("/website/api/login/cancel", {
      method: "POST",
      body: JSON.stringify({ taskId: safeTaskId }),
    });
    this.forgetTask(safeTaskId);
    return {
      provider,
      taskId: safeTaskId,
      status: "cancelled",
      terminal: true,
      message: "已取消登录",
    };
  }

  async clear(provider: PanProviderId): Promise<PanProviderStatus> {
    assertProvider(provider);
    await this.request("/website/api/account/clear", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    const relatedTasks = [...this.activeLoginProviders.entries()]
      .filter(([, loginProvider]) => accountProviderForLogin(loginProvider) === provider)
      .map(([taskId]) => taskId);
    await Promise.allSettled(relatedTasks.map((taskId) => this.cancel(taskId)));
    relatedTasks.forEach((taskId) => this.forgetTask(taskId));
    return {
      provider,
      name: PROVIDER_NAMES[provider],
      configured: false,
      login: false,
      accountState: "not-configured",
      credentialMode: "unknown",
      state: "已清除凭据",
      label: PROVIDER_NAMES[provider],
      checkedAt: Date.now(),
    };
  }

  async cancelAll(): Promise<void> {
    const taskIds = [...this.activeLoginProviders.keys()];
    await Promise.allSettled(taskIds.map((taskId) => this.cancel(taskId)));
    this.activeLoginProviders.clear();
    this.activeLoginTasksByProvider.clear();
  }

  activeTaskCount(): number {
    return this.activeLoginProviders.size;
  }

  private forgetTask(taskId: string): void {
    const provider = this.activeLoginProviders.get(taskId);
    this.activeLoginProviders.delete(taskId);
    if (provider && this.activeLoginTasksByProvider.get(provider) === taskId) {
      this.activeLoginTasksByProvider.delete(provider);
    }
  }

  private async request(pathname: string, init: RequestInit): Promise<Record<string, unknown>> {
    const baseUrl = validateLoopbackBaseUrl(this.baseUrlProvider());
    const url = new URL(pathname, `${baseUrl}/`).toString();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await this.fetchImpl(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        ...headersToRecord(init.headers),
      },
      redirect: "error",
    });
    if (!response.ok) throw new Error(`CatVod 网盘接口请求失败：HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("CatVod 网盘接口响应过大");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("CatVod 网盘接口响应过大");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("CatVod 网盘接口返回了无效数据");
    }
    const record = asRecord(payload);
    if (Number(record.code ?? 0) !== 0) throw new Error(safeText(record.msg, "CatVod 网盘操作失败"));
    return record;
  }
}

export function validateLoopbackBaseUrl(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("CatVod 服务尚未启动");
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:") throw new Error("CatVod 网盘接口仅允许本机 HTTP 服务");
  const hostname = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) {
    throw new Error("CatVod 网盘接口仅允许访问本机服务");
  }
  if (parsed.username || parsed.password) throw new Error("CatVod 服务地址不允许包含凭据");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeLoginResult(provider: PanLoginProviderId, raw: Record<string, unknown>, fallbackTaskId = ""): PanLoginResult {
  const status = normalizeLoginState(raw.status, raw.terminal === true);
  const taskId = safeTaskId(raw.taskId) || fallbackTaskId || undefined;
  const qrImage = normalizeQrImage(raw.qrImage ?? raw.qrUrl);
  return {
    provider,
    ...(taskId ? { taskId } : {}),
    status,
    terminal: raw.terminal === true || ["success", "expired", "error", "cancelled"].includes(status),
    message: safeText(raw.msg, defaultLoginMessage(status)),
    ...(qrImage ? { qrImage } : {}),
  };
}

function normalizeLoginState(value: unknown, terminal: boolean): PanLoginState {
  const state = String(value ?? "").trim().toLowerCase();
  if (state === "success") return "success";
  if (state === "expired") return "expired";
  if (state === "cancelled" || state === "canceled") return "cancelled";
  if (state === "error" || terminal) return "error";
  return "waiting";
}

function normalizeQrImage(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2_500_000) return undefined;
  if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:") return parsed.toString();
  } catch {
    return undefined;
  }
  return undefined;
}

function validateTaskId(value: string): string {
  const taskId = safeTaskId(value);
  if (!taskId) throw new Error("登录任务标识无效");
  return taskId;
}

function safeTaskId(value: unknown): string {
  const taskId = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(taskId) ? taskId : "";
}

function assertProvider(provider: string): asserts provider is PanProviderId {
  if (!PAN_PROVIDER_IDS.includes(provider as PanProviderId)) throw new Error("不支持的网盘类型");
}

function assertLoginProvider(provider: string): asserts provider is PanLoginProviderId {
  if (!["quark", "ucCookie", "ucToken", "baidu", "pan115", "pan189", "pan139"].includes(provider)) {
    throw new Error("当前网盘暂不支持应用内扫码登录");
  }
}

function normalizeAccountState(value: unknown, configured: boolean, login: boolean): PanAccountState {
  const state = String(value ?? "").trim().toLowerCase();
  if (["connected", "login", "logged-in", "success", "已登录"].includes(state)) return "connected";
  if (["expired", "invalid", "auth-expired", "登录已失效", "已过期"].includes(state)) return "expired";
  if (["unavailable", "error", "offline", "failed", "检查失败"].includes(state)) return "unavailable";
  if (["not-configured", "not_configured", "missing", "未配置", "未登录"].includes(state)) return "not-configured";
  if (login) return "connected";
  return configured ? "expired" : "not-configured";
}

function normalizeCredentialMode(...values: unknown[]): PanCredentialMode {
  const text = values.map((value) => String(value ?? "")).join(" ").toLowerCase();
  if (/tv\s*token|tv-token|电视.*token/.test(text)) return "tv-token";
  if (/cookie/.test(text)) return "cookie";
  if (/账号|密码|password|account/.test(text)) return "account-password";
  if (/扫码|qr|scan/.test(text)) return "scan";
  return "unknown";
}

function accountProviderForLogin(provider: PanLoginProviderId): PanProviderId {
  return provider === "ucCookie" || provider === "ucToken" ? "uc" : provider;
}

function safeText(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return (text || fallback).slice(0, 180);
}

function defaultLoginMessage(state: PanLoginState): string {
  if (state === "success") return "登录成功";
  if (state === "expired") return "二维码已过期";
  if (state === "cancelled") return "已取消登录";
  if (state === "error") return "登录失败";
  return "等待扫码确认";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function headersToRecord(value: HeadersInit | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(new Headers(value).entries());
}
