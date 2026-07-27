import { build } from "esbuild";
import electron from "electron";
import { execFileSync, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const outfile = path.join(tmpdir(), `fongmi-catvod-smoke-${process.pid}.mjs`);
const resultFile = path.join(tmpdir(), `fongmi-catvod-smoke-${process.pid}.json`);

try {
  await build({
    entryPoints: ["scripts/smoke-catvod.ts"],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["electron"],
    sourcemap: "inline",
  });
  await rm(resultFile, { force: true });

  let code = 1;
  let result;
  if (process.env.ELECTRON_SMOKE_DETACHED === "1") {
    const appBundle = path.resolve(path.dirname(electron), "../..");
    execFileSync("/usr/bin/open", [
      "-n",
      "-a",
      appBundle,
      "--args",
      outfile,
      `--smoke-result=${resultFile}`,
    ], { stdio: "inherit" });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        result = JSON.parse(await readFile(resultFile, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!result) {
      try { execFileSync("/usr/bin/pkill", ["-f", outfile], { stdio: "ignore" }); } catch {}
      throw new Error("Detached CatVod Electron smoke did not produce a result within 120 seconds");
    }
    code = result.status === "passed" ? 0 : 1;
  } else {
    code = await new Promise((resolve, reject) => {
      const args = process.env.ELECTRON_SMOKE_HEADLESS === "1"
        ? ["--headless", "--disable-gpu", outfile, `--smoke-result=${resultFile}`]
        : [outfile, `--smoke-result=${resultFile}`];
      const child = spawn(electron, args, {
        cwd: process.cwd(),
        stdio: "inherit",
        env: process.env,
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("CatVod Electron smoke exceeded 90 seconds"));
      }, 90_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (exitCode, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error(`CatVod Electron smoke terminated by ${signal}`));
        else resolve(exitCode ?? 1);
      });
    });
    try {
      result = JSON.parse(await readFile(resultFile, "utf8"));
    } catch {
      result = { status: code === 0 ? "passed" : "failed", message: "Smoke result file was not created" };
    }
  }
  console.log(JSON.stringify(result, null, 2));
  if (code !== 0 || result.status !== "passed") process.exitCode = 1;
} finally {
  await Promise.all([
    rm(outfile, { force: true }),
    rm(resultFile, { force: true }),
  ]);
}
