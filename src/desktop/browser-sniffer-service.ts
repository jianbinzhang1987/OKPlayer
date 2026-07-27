import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import { selectVerifiedMediaCandidate } from "../core/media-probe.ts";
import {
  forwardMediaHeaders,
  rankMediaCandidates,
  type MediaCandidateInput,
  type RankedMediaCandidate,
} from "../core/media-sniffer.ts";
import type { HeadersMap, ResolvedMedia } from "../core/models.ts";

export interface BrowserSniffOptions {
  headers?: HeadersMap;
  adPatterns?: string[];
  timeoutMs?: number;
  settleMs?: number;
  verifyCandidates?: boolean;
  probeTimeoutMs?: number;
  autoActivate?: boolean;
  activationDelaysMs?: number[];
  activationScript?: string;
  signal?: AbortSignal;
}

const DEFAULT_ACTIVATION_SCRIPT = String.raw`
(() => {
  const results = { media: 0, played: 0, clicked: 0 };
  const media = Array.from(document.querySelectorAll('video, audio'));
  results.media = media.length;
  for (const element of media) {
    try {
      element.muted = true;
      element.autoplay = true;
      const promise = element.play();
      if (promise && typeof promise.catch === 'function') promise.catch(() => undefined);
      results.played += 1;
    } catch {}
  }

  const selectors = [
    '.vjs-big-play-button',
    '.plyr__control--overlaid',
    '[data-plyr="play"]',
    '.dplayer-play-icon',
    '.jw-icon-playback',
    '.art-control-playAndPause',
    'button[aria-label*="play" i]',
    'button[title*="play" i]',
    '[role="button"][aria-label*="play" i]'
  ];
  const controls = Array.from(document.querySelectorAll(selectors.join(',')));
  const labelPattern = /^(?:play|播放|开始播放|点击播放)$/i;
  for (const element of Array.from(document.querySelectorAll('button,[role="button"]'))) {
    const label = (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim();
    if (labelPattern.test(label)) controls.push(element);
  }
  for (const control of Array.from(new Set(controls)).slice(0, 3)) {
    try {
      const rect = control.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      results.clicked += 1;
    } catch {}
  }
  return results;
})()
`;

export class BrowserSnifferCancelledError extends Error {
  constructor() {
    super("网页媒体嗅探已取消");
    this.name = "BrowserSnifferCancelledError";
  }
}

export class BrowserSnifferService {
  private cancelCurrent?: () => void;

  async sniff(pageUrl: string, options: BrowserSniffOptions = {}): Promise<ResolvedMedia> {
    const page = new URL(pageUrl);
    if (!["http:", "https:"].includes(page.protocol)) throw new Error("网页嗅探仅支持 HTTP/HTTPS 地址");
    this.cancel();

    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);
    const settleMs = Math.max(200, options.settleMs ?? 900);
    const partition = `temp:tv-sniffer-${randomUUID()}`;
    const isolatedSession = session.fromPartition(partition, { cache: false });
    const sniffWindow = new BrowserWindow({
      show: false,
      width: 960,
      height: 640,
      webPreferences: {
        session: isolatedSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: "no-user-gesture-required",
      },
    });

    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    sniffWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const candidates: MediaCandidateInput[] = [];
    const requestHeadersById = new Map<number, HeadersMap>();
    const injectedHeaders = forwardMediaHeaders(options.headers ?? {});

    return new Promise<ResolvedMedia>((resolve, reject) => {
      let settled = false;
      let resolving = false;
      let settleTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      const activationTimers: NodeJS.Timeout[] = [];

      const cleanup = async () => {
        if (settleTimer) clearTimeout(settleTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        for (const timer of activationTimers) clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        isolatedSession.webRequest.onBeforeSendHeaders(null);
        isolatedSession.webRequest.onBeforeRedirect(null);
        isolatedSession.webRequest.onCompleted(null);
        isolatedSession.webRequest.onErrorOccurred(null);
        if (!sniffWindow.isDestroyed()) sniffWindow.destroy();
        await isolatedSession.clearStorageData().catch(() => undefined);
        if (this.cancelCurrent === cancel) this.cancelCurrent = undefined;
      };

      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        void cleanup().finally(() => reject(error));
      };

      const candidateHeaders = async (candidate: RankedMediaCandidate): Promise<HeadersMap> => {
        const cookies = await isolatedSession.cookies.get({ url: candidate.url });
        const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
        return forwardMediaHeaders({
          ...injectedHeaders,
          ...(candidate.requestHeaders ?? {}),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        });
      };

      const resolveBest = async () => {
        if (settled || resolving) return;
        resolving = true;
        const ranked = rankMediaCandidates(candidates, options.adPatterns ?? []);
        const best = ranked[0];
        if (!best) {
          rejectOnce(new Error("网页已加载，但未发现可播放的媒体请求"));
          return;
        }
        try {
          const selection = options.verifyCandidates === false
            ? { candidate: best, headers: await candidateHeaders(best), verified: false }
            : await selectVerifiedMediaCandidate(ranked, {
              getHeaders: candidateHeaders,
              maxCandidates: 5,
              timeoutMs: Math.max(1_000, options.probeTimeoutMs ?? Math.min(6_000, Math.floor(timeoutMs / 2))),
              maxBytes: 64 * 1024,
              ...(options.signal ? { signal: options.signal } : {}),
            });
          if (settled) return;
          if (!selection) {
            rejectOnce(new Error("发现了疑似媒体请求，但内容验证均未通过"));
            return;
          }
          settled = true;
          await cleanup();
          resolve({
            url: selection.candidate.url,
            headers: selection.headers,
            ...(selection.candidate.format ? { format: selection.candidate.format } : {}),
            resolvedBy: "browser-sniffer",
          });
        } catch (error) {
          if (!settled) {
            settled = true;
            await cleanup();
            reject(error);
          }
        }
      };

      const scheduleResolve = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => void resolveBest(), settleMs);
        settleTimer.unref();
      };

      const activatePage = async () => {
        if (options.autoActivate === false || sniffWindow.isDestroyed()) return;
        const script = options.activationScript?.trim() || DEFAULT_ACTIVATION_SCRIPT;
        type SnifferFrame = typeof sniffWindow.webContents.mainFrame;
        const collectFrames = (frame: SnifferFrame): SnifferFrame[] => [
          frame,
          ...frame.frames.flatMap((child) => collectFrames(child)),
        ];
        const frames = collectFrames(sniffWindow.webContents.mainFrame).filter((frame) => !frame.isDestroyed());
        await Promise.allSettled(frames.map((frame) => frame.executeJavaScript(script, true)));
      };

      const scheduleActivation = () => {
        if (options.autoActivate === false) return;
        const delays = options.activationDelaysMs ?? [250, 1_200, 3_500];
        for (const rawDelay of delays) {
          const delay = Math.max(0, Math.min(rawDelay, timeoutMs - 100));
          const timer = setTimeout(() => void activatePage(), delay);
          timer.unref();
          activationTimers.push(timer);
        }
      };

      const cancel = () => rejectOnce(new BrowserSnifferCancelledError());
      this.cancelCurrent = cancel;
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) {
        cancel();
        return;
      }

      isolatedSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
        const requestHeaders = normalizeHeaders(details.requestHeaders);
        for (const [key, value] of Object.entries(injectedHeaders)) setHeader(requestHeaders, key, value);
        requestHeadersById.set(details.id, requestHeaders);
        callback({ requestHeaders });
      });

      isolatedSession.webRequest.onBeforeRedirect({ urls: ["<all_urls>"] }, (details) => {
        const responseHeaders = normalizeResponseHeaders(details.responseHeaders);
        const requestHeaders = withReferrer(requestHeadersById.get(details.id) ?? {}, details.referrer);
        candidates.push({
          url: details.redirectURL,
          resourceType: details.resourceType,
          mimeType: headerValue(responseHeaders, "content-type"),
          requestHeaders,
          responseHeaders,
        });
        const best = rankMediaCandidates(candidates, options.adPatterns ?? [])[0];
        if (best && best.score >= 100) scheduleResolve();
      });

      isolatedSession.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
        const responseHeaders = normalizeResponseHeaders(details.responseHeaders);
        const requestHeaders = withReferrer(requestHeadersById.get(details.id) ?? {}, details.referrer);
        candidates.push({
          url: details.url,
          statusCode: details.statusCode,
          resourceType: details.resourceType,
          mimeType: headerValue(responseHeaders, "content-type"),
          requestHeaders,
          responseHeaders,
        });
        requestHeadersById.delete(details.id);
        const best = rankMediaCandidates(candidates, options.adPatterns ?? [])[0];
        if (best && best.score >= 100) scheduleResolve();
      });

      isolatedSession.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => {
        requestHeadersById.delete(details.id);
      });

      sniffWindow.webContents.on("did-finish-load", scheduleActivation);
      sniffWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        rejectOnce(new Error(`嗅探页面加载失败：${errorDescription}（${errorCode}）`));
      });
      sniffWindow.on("closed", () => {
        if (!settled) rejectOnce(new Error("网页嗅探窗口意外关闭"));
      });

      timeoutTimer = setTimeout(() => void resolveBest(), timeoutMs);
      timeoutTimer.unref();

      const extraHeaders = Object.entries(injectedHeaders).map(([key, value]) => `${key}: ${value}`).join("\n");
      void sniffWindow.loadURL(page.toString(), extraHeaders ? { extraHeaders } : undefined).catch(rejectOnce);
    });
  }

  cancel(): void {
    this.cancelCurrent?.();
  }

  close(): void {
    this.cancel();
  }
}

function normalizeHeaders(value: Record<string, string> | undefined): HeadersMap {
  return Object.fromEntries(Object.entries(value ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function normalizeResponseHeaders(value: Record<string, string[] | undefined> | undefined): HeadersMap {
  return Object.fromEntries(Object.entries(value ?? {}).flatMap(([key, values]) => {
    const normalized = values?.filter(Boolean).join(", ").trim() ?? "";
    return normalized ? [[key, normalized]] : [];
  }));
}

function withReferrer(headers: HeadersMap, referrer: string): HeadersMap {
  const output = { ...headers };
  if (referrer && !headerValue(output, "referer")) output.Referer = referrer;
  return output;
}

function setHeader(headers: HeadersMap, key: string, value: string): void {
  const normalized = key.toLowerCase();
  for (const candidate of Object.keys(headers)) {
    if (candidate.toLowerCase() === normalized && candidate !== key) delete headers[candidate];
  }
  headers[key] = value;
}

function headerValue(headers: HeadersMap, key: string): string {
  const normalized = key.toLowerCase();
  return Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === normalized)?.[1] ?? "";
}
