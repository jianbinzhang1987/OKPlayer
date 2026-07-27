import type { ConfigRecord } from "../../../core/sqlite-storage.ts";

export interface SettingsApi {
  listConfigs(): Promise<ConfigRecord[]>;
  saveConfig(config: ConfigRecord): Promise<void>;
  getSetting<T>(key: string, fallback: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<void>;
}

export interface SettingsPageState {
  configs: ConfigRecord[];
  defaultSpeed: number;
  loading: boolean;
  error: string;
}

export class SettingsPageController {
  readonly state: SettingsPageState = { configs: [], defaultSpeed: 1, loading: false, error: "" };
  private readonly api: SettingsApi;

  constructor(api: SettingsApi) {
    this.api = api;
  }

  async load() {
    this.state.loading = true;
    this.state.error = "";
    try {
      const [configs, speed] = await Promise.all([
        this.api.listConfigs(),
        this.api.getSetting("defaultSpeed", 1),
      ]);
      this.state.configs = configs;
      this.state.defaultSpeed = speed;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : "加载设置失败";
    } finally {
      this.state.loading = false;
    }
  }

  async addConfig(name: string, url: string) {
    const trimmedUrl = url.trim();
    if (trimmedUrl === "") throw new Error("配置地址不能为空");
    const config: ConfigRecord = { name: name.trim() || "未命名配置", url: trimmedUrl, enabled: true, updatedAt: Date.now() };
    await this.api.saveConfig(config);
    this.state.configs = await this.api.listConfigs();
  }

  async setDefaultSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 5) throw new Error("播放速度范围应为0.25到5");
    await this.api.setSetting("defaultSpeed", speed);
    this.state.defaultSpeed = speed;
  }
}
