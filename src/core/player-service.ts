import { MpvController } from "./mpv-controller.ts";

export interface PlayerState {
  position: number;
  duration: number;
  paused: boolean;
  stopped: boolean;
  speed: number;
}

export class PlayerService {
  private readonly mpv: MpvController;
  private readonly listeners = new Set<(state: PlayerState) => void>();
  private state: PlayerState = { position: 0, duration: 0, paused: false, stopped: true, speed: 1 };

  constructor(mpv = new MpvController()) {
    this.mpv = mpv;
    const eventSource = this.mpv as MpvController & { on?: (event: string, callback: (value: unknown) => void) => unknown };
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
    eventSource.on("end-file", () => this.patch({ stopped: true }));
    eventSource.on("exit", () => this.patch({ stopped: true }));
  }

  async open(url: string, headers: Record<string, string> = {}) {
    await this.mpv.start();
    await this.mpv.load(url, headers);
    this.patch({ position: 0, duration: 0, paused: false, stopped: false });
    return {
      url,
      ipcPath: this.mpv.getIpcPath(),
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

  getState(): PlayerState {
    return { ...this.state };
  }

  onState(callback: (state: PlayerState) => void) {
    this.listeners.add(callback);
    callback(this.getState());
    return () => this.listeners.delete(callback);
  }

  async close() {
    await this.mpv.release();
    this.patch({ stopped: true });
  }

  private patch(partial: Partial<PlayerState>) {
    this.state = { ...this.state, ...partial };
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
