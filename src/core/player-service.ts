import { MpvController } from "./mpv-controller.ts";

export interface PlayerState {
  position: number;
  duration: number;
  paused: boolean;
  stopped: boolean;
  speed: number;
  volume: number;
  muted: boolean;
}

export interface NativePlayerViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaybackController {
  start(): Promise<void>;
  load(url: string, headers?: Record<string, string>): Promise<unknown> | unknown;
  play(): Promise<unknown> | unknown;
  pause(): Promise<unknown> | unknown;
  stop(): Promise<unknown> | unknown;
  seek(seconds: number): Promise<unknown> | unknown;
  setSpeed(speed: number): Promise<unknown> | unknown;
  setVolume(volume: number): Promise<unknown> | unknown;
  setMuted(muted: boolean): Promise<unknown> | unknown;
  release(): Promise<unknown> | unknown;
  getIpcPath?(): string | undefined;
  getBackend?(): string;
  attachNativeView?(parentHandle: bigint, rect: NativePlayerViewRect): Promise<unknown> | unknown;
  resizeNativeView?(rect: NativePlayerViewRect): Promise<unknown> | unknown;
  detachNativeView?(): Promise<unknown> | unknown;
  on?(event: string, callback: (value: unknown) => void): unknown;
}

export class PlayerService {
  private readonly mpv: PlaybackController;
  private readonly listeners = new Set<(state: PlayerState) => void>();
  private state: PlayerState = { position: 0, duration: 0, paused: false, stopped: true, speed: 1, volume: 100, muted: false };

  constructor(mpv: PlaybackController = new MpvController()) {
    this.mpv = mpv;
    const eventSource = this.mpv;
    if (typeof eventSource.on !== "function") return;
    eventSource.on("time-pos", (value) => {
      if (typeof value === "number" && Number.isFinite(value)) this.patch({ position: Math.max(0, value), stopped: false });
    });
    eventSource.on("duration", (value) => {
      if (typeof value === "number" && Number.isFinite(value)) this.patch({ duration: Math.max(0, value) });
    });
    eventSource.on("pause", (value) => {
      if (typeof value === "boolean") this.patch({ paused: value });
    });
    eventSource.on("volume", (value) => {
      if (typeof value === "number" && Number.isFinite(value)) this.patch({ volume: Math.max(0, Math.min(100, value)) });
    });
    eventSource.on("mute", (value) => {
      if (typeof value === "boolean") this.patch({ muted: value });
    });
    eventSource.on("end-file", () => this.patch({ stopped: true }));
    eventSource.on("exit", () => this.patch({ stopped: true }));
  }

  async open(url: string, headers: Record<string, string> = {}) {
    await this.mpv.start();
    await this.mpv.load(url, headers);
    this.patch({ position: 0, duration: 0, paused: false, stopped: false });
    const ipcPath = this.mpv.getIpcPath?.();
    return {
      url,
      ...(ipcPath ? { ipcPath } : {}),
      backend: this.mpv.getBackend?.() ?? "mpv-ipc",
      status: "started",
    };
  }

  async pause() {
    await this.mpv.pause();
    this.patch({ paused: true });
  }

  async play() {
    await this.mpv.play();
    this.patch({ paused: false, stopped: false });
  }

  async stop() {
    await this.mpv.stop();
    this.patch({ stopped: true });
  }

  seek(seconds: number) {
    return this.mpv.seek(seconds);
  }

  async setSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 5) throw new Error("播放速度范围应为0.25到5");
    await this.mpv.setSpeed(speed);
    this.patch({ speed });
  }

  async setVolume(volume: number) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error("音量范围应为0到100");
    await this.mpv.setVolume(volume);
    this.patch({ volume: Math.max(0, Math.min(100, volume)) });
  }

  async setMuted(muted: boolean) {
    await this.mpv.setMuted(muted);
    this.patch({ muted });
  }

  getBackend(): string {
    return this.mpv.getBackend?.() ?? "mpv-ipc";
  }

  async attachNativeView(parentHandle: bigint, rect: NativePlayerViewRect) {
    if (!this.mpv.attachNativeView) return { ok: false, backend: this.getBackend(), message: "当前播放后端不支持原生视图" };
    return this.mpv.attachNativeView(parentHandle, rect);
  }

  async resizeNativeView(rect: NativePlayerViewRect) {
    if (!this.mpv.resizeNativeView) return { ok: false, backend: this.getBackend() };
    await this.mpv.resizeNativeView(rect);
    return { ok: true, backend: this.getBackend() };
  }

  async detachNativeView() {
    if (this.mpv.detachNativeView) await this.mpv.detachNativeView();
    return { ok: true, backend: this.getBackend() };
  }

  getState(): PlayerState {
    return { ...this.state };
  }

  onState(callback: (state: PlayerState) => void) {
    this.listeners.add(callback);
    callback(this.getState());
    return () => this.listeners.delete(callback);
  }

  async close() {
    if (this.mpv.detachNativeView) await this.mpv.detachNativeView();
    await this.mpv.release();
    this.patch({ stopped: true });
  }

  private patch(partial: Partial<PlayerState>) {
    this.state = { ...this.state, ...partial };
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
