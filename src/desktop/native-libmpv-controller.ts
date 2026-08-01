import type { PlaybackController } from "../core/player-service.ts";
import {
  createNativeLibmpvPlayer,
  getNativeLibmpvAvailability,
  type NativeLibmpvPlayerHandle,
} from "./native-libmpv-addon.ts";

export class NativeLibmpvController implements PlaybackController {
  private player?: NativeLibmpvPlayerHandle;
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastStopped = true;

  getBackend() {
    return "native-libmpv";
  }

  async start(): Promise<void> {
    if (this.player) return;
    const availability = getNativeLibmpvAvailability();
    if (!availability.available) {
      throw new Error(availability.reason ?? "libmpv 原生内嵌插件不可用");
    }
    const player = createNativeLibmpvPlayer();
    if (!player) throw new Error("libmpv 原生内嵌插件未能创建播放器实例");
    this.player = player;
    this.startPolling();
    this.emitSnapshot();
  }

  load(url: string, headers: Record<string, string> = {}) {
    this.requirePlayer().load(url, headers);
    // libmpv commonly reports `stopped` for one or more snapshots while a
    // newly loaded network stream is still opening.  Treat that as the
    // baseline state; otherwise the first poll manufactures an end-file event
    // and the renderer immediately abandons a visible original-quality frame.
    this.lastStopped = true;
    this.emitSnapshot();
  }

  play() {
    this.requirePlayer().play();
    this.emit("pause", false);
    this.emitSnapshot();
  }

  pause() {
    this.requirePlayer().pause();
    this.emit("pause", true);
    this.emitSnapshot();
  }

  stop() {
    this.requirePlayer().stop();
    this.emitSnapshot();
  }

  seek(seconds: number) {
    this.requirePlayer().seek(seconds);
    this.emit("time-pos", seconds);
    this.emitSnapshot();
  }

  setSpeed(speed: number) {
    this.requirePlayer().setSpeed(speed);
    this.emitSnapshot();
  }

  setVolume(volume: number) {
    this.requirePlayer().setVolume(volume);
    this.emit("volume", volume);
    this.emitSnapshot();
  }

  setMuted(muted: boolean) {
    this.requirePlayer().setMuted(muted);
    this.emit("mute", muted);
    this.emitSnapshot();
  }

  async attachNativeView(parentHandle: bigint, rect: { x: number; y: number; width: number; height: number }) {
    if (process.env.FONGMI_NATIVE_VIEW_FORCE_FAILURE === "1") {
      throw new Error("已按测试开关模拟原生视频视图挂载失败");
    }
    await this.start();
    const result = this.requirePlayer().attachView(parentHandle, rect.x, rect.y, rect.width, rect.height);
    if (!result.ok) throw new Error(result.message || "libmpv 原生视频视图挂载失败");
    return result;
  }

  resizeNativeView(rect: { x: number; y: number; width: number; height: number }) {
    this.requirePlayer().resizeView(rect.x, rect.y, rect.width, rect.height);
  }

  detachNativeView() {
    this.player?.detachView();
  }

  release() {
    this.stopPolling();
    this.player?.detachView();
    this.player?.destroy();
    this.player = undefined;
    this.lastStopped = true;
    this.emit("exit", { event: "exit" });
  }

  on(event: string, callback: (value: unknown) => void) {
    const callbacks = this.listeners.get(event) ?? new Set<(value: unknown) => void>();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(callback);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.emitSnapshot(), 500);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private requirePlayer(): NativeLibmpvPlayerHandle {
    if (!this.player) throw new Error("libmpv 原生播放器尚未启动");
    return this.player;
  }

  private emitSnapshot(): void {
    if (!this.player) return;
    const state = this.player.getState();
    this.emit("time-pos", state.position);
    this.emit("duration", state.duration);
    this.emit("pause", state.paused);
    this.emit("volume", state.volume);
    this.emit("mute", state.muted);
    if (state.stopped && !this.lastStopped) this.emit("end-file", { event: "end-file" });
    this.lastStopped = state.stopped;
  }

  private emit(event: string, value: unknown): void {
    this.listeners.get(event)?.forEach((callback) => callback(value));
  }
}
