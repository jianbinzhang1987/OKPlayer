import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ExternalPlayerPreference = "iina" | "vlc" | "system";

export interface ExternalPlayerOpenResult {
  status: "opened";
  player: ExternalPlayerPreference;
}

export interface ExternalPlayerLauncher {
  open(url: string, preference: ExternalPlayerPreference): Promise<ExternalPlayerOpenResult>;
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { windowsHide: boolean; timeout: number },
) => Promise<unknown>;

const execFileAsync = promisify(execFile) as unknown as ExecFile;

export class ExternalPlayerService implements ExternalPlayerLauncher {
  private readonly platform: NodeJS.Platform;
  private readonly run: ExecFile;

  constructor(platform: NodeJS.Platform = process.platform, run: ExecFile = execFileAsync) {
    this.platform = platform;
    this.run = run;
  }

  async open(url: string, preference: ExternalPlayerPreference): Promise<ExternalPlayerOpenResult> {
    const target = validateExternalMediaUrl(url);
    const command = externalPlayerCommand(this.platform, preference, target);
    await this.run(command.file, command.args, { windowsHide: true, timeout: 15_000 });
    return { status: "opened", player: preference };
  }
}

export function validateExternalMediaUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("外部播放器地址无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("外部播放器仅允许打开 HTTP 或 HTTPS 媒体地址");
  }
  return parsed.toString();
}

export function externalPlayerCommand(
  platform: NodeJS.Platform,
  preference: ExternalPlayerPreference,
  url: string,
): { file: string; args: string[] } {
  if (platform === "darwin") {
    if (preference === "iina") return { file: "open", args: ["-a", "IINA", url] };
    if (preference === "vlc") return { file: "open", args: ["-a", "VLC", url] };
    return { file: "open", args: [url] };
  }

  if (platform === "linux") {
    if (preference === "iina") throw new Error("IINA 仅适用于 macOS，请改用 VLC 或系统默认播放器");
    if (preference === "vlc") return { file: "vlc", args: ["--one-instance", url] };
    return { file: "xdg-open", args: [url] };
  }

  if (platform === "win32") {
    if (preference === "iina") throw new Error("IINA 仅适用于 macOS，请改用 VLC 或系统默认播放器");
    if (preference === "vlc") return { file: "vlc.exe", args: ["--one-instance", url] };
    return {
      file: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }

  throw new Error(`当前系统暂不支持外部播放器：${platform}`);
}
