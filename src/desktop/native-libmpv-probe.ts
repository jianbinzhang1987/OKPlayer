import { writeSync } from "node:fs";
import { createRequire } from "node:module";

interface NativeLibmpvBuildInfo {
  name?: string;
  api?: string;
  platform?: string;
  linkedLibmpv?: boolean;
  renderReady?: boolean;
  libmpvPath?: string;
  libmpvError?: string;
  clientApiVersion?: number;
}

interface NativeLibmpvAddon {
  getBuildInfo(): NativeLibmpvBuildInfo;
  createPlayer(): {
    getState(): unknown;
    destroy(): void;
  };
}

function writeResult(payload: unknown): void {
  writeSync(1, `${JSON.stringify(payload)}\n`);
}

function fail(message: string): never {
  writeResult({ ok: false, error: message });
  process.exit(1);
}

const addonPath = process.argv[2]?.trim();
const libraryPath = process.argv[3]?.trim();
if (!addonPath || !libraryPath) fail("缺少 native addon 或 libmpv 动态库路径");

process.env.FONGMI_LIBMPV_LIBRARY = libraryPath;

try {
  const requireNative = createRequire(process.argv[1] || process.cwd());
  const addon = requireNative(addonPath) as NativeLibmpvAddon;
  if (typeof addon?.getBuildInfo !== "function" || typeof addon?.createPlayer !== "function") {
    fail("native addon 未导出预期接口");
  }

  const buildInfo = addon.getBuildInfo();
  if (buildInfo.linkedLibmpv !== true) {
    fail(buildInfo.libmpvError || "native addon 未成功链接受控 libmpv");
  }
  if (buildInfo.renderReady !== true) {
    fail("libmpv core 已加载，但原生视图与 render API 尚未就绪");
  }

  const player = addon.createPlayer();
  const state = player.getState();
  player.destroy();
  writeResult({ ok: true, buildInfo, state });
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
