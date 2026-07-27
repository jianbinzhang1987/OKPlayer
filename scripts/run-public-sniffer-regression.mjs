import { build } from "esbuild";
import electronPath from "electron";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const appDirectory = path.join(os.tmpdir(), "fongmi-public-sniffer-regression-app");
const output = path.join(appDirectory, "main.cjs");
const resultPath = path.join(os.tmpdir(), "fongmi-public-sniffer-regression.json");

await rm(appDirectory, { recursive: true, force: true });
await rm(resultPath, { force: true });
await mkdir(appDirectory, { recursive: true });
await writeFile(path.join(appDirectory, "package.json"), JSON.stringify({
  name: "fongmi-public-sniffer-regression",
  version: "1.0.0",
  private: true,
  main: "main.cjs",
}), "utf8");

await build({
  entryPoints: ["scripts/regress-browser-sniffer-public.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
});

const result = spawnSync(electronPath, ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", appDirectory], {
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    SNIFFER_REGRESSION_RESULT: resultPath,
  },
  timeout: 120_000,
});

if (result.error) throw result.error;
let reportRead = false;
try {
  const report = JSON.parse(await readFile(resultPath, "utf8"));
  reportRead = true;
  console.table(report.results);
  console.log(`Public BrowserSniffer regression: ${report.passed} passed, ${report.failed} failed.`);
} catch (error) {
  console.error(`Unable to read public regression report: ${error instanceof Error ? error.message : String(error)}`);
}

if (result.status !== 0) console.error(`Public BrowserSniffer regression failed with status ${result.status ?? "unknown"}.`);
process.exitCode = reportRead && result.status === 0 ? 0 : 1;
