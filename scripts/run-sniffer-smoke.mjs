import { build } from "esbuild";
import electronPath from "electron";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const appDirectory = path.join(os.tmpdir(), "fongmi-browser-sniffer-smoke-app");
const output = path.join(appDirectory, "main.cjs");
const resultPath = path.join(os.tmpdir(), "fongmi-browser-sniffer-smoke.json");

await rm(appDirectory, { recursive: true, force: true });
await rm(resultPath, { force: true });
await mkdir(appDirectory, { recursive: true });
await writeFile(path.join(appDirectory, "package.json"), JSON.stringify({
  name: "fongmi-browser-sniffer-smoke",
  version: "1.0.0",
  private: true,
  main: "main.cjs",
}), "utf8");

await build({
  entryPoints: ["scripts/smoke-browser-sniffer.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
});

const result = spawnSync(electronPath, [appDirectory], {
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    SNIFFER_SMOKE_RESULT: resultPath,
  },
  timeout: 60_000,
});

if (result.error) throw result.error;
let report;
try {
  report = JSON.parse(await readFile(resultPath, "utf8"));
  console.log("BrowserSniffer smoke report:", report);
} catch (error) {
  console.error(`Unable to read BrowserSniffer smoke report: ${error instanceof Error ? error.message : String(error)}`);
}

if (result.status !== 0) console.error(`BrowserSniffer smoke failed with status ${result.status ?? "unknown"}.`);
process.exitCode = report?.ok === true && result.status === 0 ? 0 : 1;
