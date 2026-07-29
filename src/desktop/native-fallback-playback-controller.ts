import type { NativePlayerViewRect, PlaybackController } from "../core/player-service.ts";

export interface NativeFallbackStatus {
  backend: "native-libmpv" | "mpv-ipc";
  fallbackReason?: string;
}

export interface NativeFallbackPlaybackControllerOptions {
  /**
   * Allows falling back to the standalone MPV IPC process. This is useful for
   * low-level tests and diagnostics, but production in-app compatibility mode
   * disables it so playback never escapes into an external MPV window.
   */
  allowWindowFallback?: boolean;
}

export class UnavailablePlaybackController implements PlaybackController {
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  getBackend(): string {
    return "unavailable";
  }

  async start(): Promise<void> {
    throw new Error(this.message());
  }

  async load(): Promise<unknown> {
    throw new Error(this.message());
  }

  async play(): Promise<unknown> { throw new Error(this.message()); }
  async pause(): Promise<unknown> { throw new Error(this.message()); }
  async stop(): Promise<unknown> { return undefined; }
  async seek(): Promise<unknown> { throw new Error(this.message()); }
  async setSpeed(): Promise<unknown> { throw new Error(this.message()); }
  async setVolume(): Promise<unknown> { throw new Error(this.message()); }
  async setMuted(): Promise<unknown> { throw new Error(this.message()); }
  async release(): Promise<unknown> { return undefined; }

  async attachNativeView(): Promise<{ ok: false; backend: string; message: string }> {
    return { ok: false, backend: this.getBackend(), message: this.message() };
  }

  async resizeNativeView(): Promise<{ ok: false; backend: string; message: string }> {
    return { ok: false, backend: this.getBackend(), message: this.message() };
  }

  async detachNativeView(): Promise<{ ok: true; backend: string }> {
    return { ok: true, backend: this.getBackend() };
  }

  private message(): string {
    return `应用内高兼容播放不可用：${this.reason}`;
  }
}

export class NativeFallbackPlaybackController implements PlaybackController {
  private active: "native" | "fallback" = "native";
  private fallbackReason?: string;
  private readonly nativeController: PlaybackController;
  private readonly fallbackController: PlaybackController;
  private readonly allowWindowFallback: boolean;

  constructor(
    nativeController: PlaybackController,
    fallbackController: PlaybackController,
    options: NativeFallbackPlaybackControllerOptions = {},
  ) {
    this.nativeController = nativeController;
    this.fallbackController = fallbackController;
    this.allowWindowFallback = options.allowWindowFallback !== false;
  }

  getBackend(): string {
    return this.active === "native"
      ? this.nativeController.getBackend?.() ?? "native-libmpv"
      : this.fallbackController.getBackend?.() ?? "mpv-ipc";
  }

  getIpcPath(): string | undefined {
    return this.active === "fallback" ? this.fallbackController.getIpcPath?.() : undefined;
  }

  getStatus(): NativeFallbackStatus {
    return {
      backend: this.active === "native" ? "native-libmpv" : "mpv-ipc",
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.active === "fallback") {
      await this.fallbackController.start();
      return;
    }
    try {
      await this.nativeController.start();
    } catch (error) {
      if (!this.allowWindowFallback) await this.rejectInAppFailure(error, "原生播放内核启动失败");
      await this.switchToFallback(error, "原生播放内核启动失败");
      await this.fallbackController.start();
    }
  }

  async load(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    if (this.active === "fallback") return this.fallbackController.load(url, headers);
    try {
      return await this.nativeController.load(url, headers);
    } catch (error) {
      if (!this.allowWindowFallback) await this.rejectInAppFailure(error, "原生播放加载失败");
      await this.switchToFallback(error, "原生播放加载失败");
      await this.fallbackController.start();
      return this.fallbackController.load(url, headers);
    }
  }

  play(): Promise<unknown> | unknown {
    return this.current().play();
  }

  pause(): Promise<unknown> | unknown {
    return this.current().pause();
  }

  stop(): Promise<unknown> | unknown {
    return this.current().stop();
  }

  seek(seconds: number): Promise<unknown> | unknown {
    return this.current().seek(seconds);
  }

  setSpeed(speed: number): Promise<unknown> | unknown {
    return this.current().setSpeed(speed);
  }

  setVolume(volume: number): Promise<unknown> | unknown {
    return this.current().setVolume(volume);
  }

  setMuted(muted: boolean): Promise<unknown> | unknown {
    return this.current().setMuted(muted);
  }

  async attachNativeView(parentHandle: bigint, rect: NativePlayerViewRect) {
    if (this.active === "fallback" || !this.nativeController.attachNativeView) {
      return {
        ok: false,
        backend: "mpv-ipc",
        fallback: true,
        message: this.fallbackReason ?? "当前已使用 MPV IPC 高兼容后端",
      };
    }
    try {
      const result = await this.nativeController.attachNativeView(parentHandle, rect) as { ok?: boolean; message?: string } | undefined;
      if (result?.ok === false) throw new Error(result.message || "原生视频视图挂载失败");
      return { ok: true, backend: "native-libmpv", message: result?.message ?? "原生视频视图已挂载" };
    } catch (error) {
      if (!this.allowWindowFallback) {
        this.fallbackReason = this.inAppFailureMessage(error, "原生视频视图挂载失败");
        await Promise.resolve(this.nativeController.detachNativeView?.()).catch(() => undefined);
        return {
          ok: false,
          backend: "native-libmpv",
          fallback: false,
          message: this.fallbackReason,
        };
      }
      await this.switchToFallback(error, "原生视频视图挂载失败");
      return {
        ok: false,
        backend: "mpv-ipc",
        fallback: true,
        message: this.fallbackReason,
      };
    }
  }

  async resizeNativeView(rect: NativePlayerViewRect) {
    if (this.active !== "native" || !this.nativeController.resizeNativeView) {
      return { ok: false, backend: "mpv-ipc" };
    }
    try {
      await this.nativeController.resizeNativeView(rect);
      return { ok: true, backend: "native-libmpv" };
    } catch (error) {
      if (!this.allowWindowFallback) {
        this.fallbackReason = this.inAppFailureMessage(error, "原生视频区域调整失败");
        return { ok: false, backend: "native-libmpv", fallback: false, message: this.fallbackReason };
      }
      await this.switchToFallback(error, "原生视频区域调整失败");
      return { ok: false, backend: "mpv-ipc", fallback: true, message: this.fallbackReason };
    }
  }

  async detachNativeView() {
    if (this.nativeController.detachNativeView) {
      await Promise.resolve(this.nativeController.detachNativeView()).catch(() => undefined);
    }
    return { ok: true, backend: this.getBackend() };
  }

  on(event: string, callback: (value: unknown) => void) {
    const removeNative = this.nativeController.on?.(event, (value) => {
      if (this.active === "native") callback(value);
    });
    const removeFallback = this.fallbackController.on?.(event, (value) => {
      if (this.active === "fallback") callback(value);
    });
    return () => {
      if (typeof removeNative === "function") removeNative();
      if (typeof removeFallback === "function") removeFallback();
    };
  }

  async release(): Promise<void> {
    await Promise.resolve(this.nativeController.detachNativeView?.()).catch(() => undefined);
    await Promise.allSettled([
      Promise.resolve(this.nativeController.release()),
      Promise.resolve(this.fallbackController.release()),
    ]);
  }

  private current(): PlaybackController {
    return this.active === "native" ? this.nativeController : this.fallbackController;
  }

  private inAppFailureMessage(error: unknown, prefix: string): string {
    return `${prefix}。应用内高兼容播放需要 libmpv 原生内嵌渲染，已禁用 MPV IPC 外置窗口兜底：${error instanceof Error ? error.message : String(error)}`;
  }

  private async rejectInAppFailure(error: unknown, prefix: string): Promise<never> {
    this.fallbackReason = this.inAppFailureMessage(error, prefix);
    await Promise.resolve(this.nativeController.detachNativeView?.()).catch(() => undefined);
    await Promise.resolve(this.nativeController.release()).catch(() => undefined);
    throw new Error(this.fallbackReason);
  }

  private async switchToFallback(error: unknown, prefix: string): Promise<void> {
    if (this.active === "fallback") return;
    this.fallbackReason = `${prefix}，已自动切换 MPV IPC：${error instanceof Error ? error.message : String(error)}`;
    this.active = "fallback";
    await Promise.resolve(this.nativeController.detachNativeView?.()).catch(() => undefined);
    await Promise.resolve(this.nativeController.release()).catch(() => undefined);
  }
}
