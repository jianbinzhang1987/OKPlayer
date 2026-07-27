import { build } from "esbuild";
import electron from "electron";
import { execFileSync, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const outfile = path.join(tmpdir(), `fongmi-embedded-player-smoke-${process.pid}.mjs`);
const resultFile = path.join(tmpdir(), `fongmi-embedded-player-smoke-${process.pid}.json`);

function resolveElectronExecutable() {
  const explicit = process.env.ELECTRON_EXECUTABLE?.trim();
  if (explicit) return explicit;

  const version = process.env.ELECTRON_SMOKE_VERSION?.trim();
  if (!version) return electron;

  return execFileSync(
    "npm",
    ["exec", "--yes", `--package=electron@${version}`, "--", "which", "electron"],
    { encoding: "utf8" },
  ).trim();
}

try {
  await build({
    entryPoints: ["scripts/smoke-embedded-player.ts"],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["electron"],
    sourcemap: "inline",
  });

  await rm(resultFile, { force: true });
  const executable = resolveElectronExecutable();
  let code = 1;

  if (process.env.ELECTRON_SMOKE_DETACHED === "1") {
    const appBundle = path.resolve(path.dirname(executable), "../..");
    execFileSync("/usr/bin/open", [
      "-n",
      "-a",
      appBundle,
      "--args",
      outfile,
      `--smoke-result=${resultFile}`,
    ], { stdio: "inherit" });

    const deadline = Date.now() + 60_000;
    let result;
    while (Date.now() < deadline) {
      try {
        result = JSON.parse(await readFile(resultFile, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!result) {
      try {
        execFileSync("/usr/bin/pkill", ["-f", outfile], { stdio: "ignore" });
      } catch {
        // The process may already have exited.
      }
      throw new Error("detached embedded player smoke did not produce a result within 60 seconds");
    }
    console.log(JSON.stringify(result));
    code = result.status === "passed" ? 0 : 1;
  } else {
    code = await new Promise((resolve, reject) => {
      const args = process.env.ELECTRON_SMOKE_HEADLESS === "1"
        ? ["--headless", "--disable-gpu", outfile, `--smoke-result=${resultFile}`]
        : [outfile, `--smoke-result=${resultFile}`];
      const child = spawn(executable, args, { stdio: "inherit", env: process.env });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        if (signal) reject(new Error(`embedded player smoke terminated by ${signal}`));
        else resolve(exitCode ?? 1);
      });
    });
  }

  if (code !== 0) process.exitCode = code;
} finally {
  await Promise.all([
    rm(outfile, { force: true }),
    rm(resultFile, { force: true }),
  ]);
}
