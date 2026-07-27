import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const projectRoot = path.resolve(".");

function resolveHlsEntry(): string {
  const explicit = process.env.HLS_JS_ENTRY?.trim();
  const candidates = [
    explicit,
    path.join(projectRoot, "node_modules", "hls.js", "dist", "hls.mjs"),
  ].filter((value): value is string => Boolean(value));

  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  if (fs.existsSync(npxRoot)) {
    const cached = fs.readdirSync(npxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(npxRoot, entry.name, "node_modules", "hls.js", "dist", "hls.mjs"))
      .filter((entry) => fs.existsSync(entry))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    candidates.push(...cached);
  }

  const resolved = candidates.find((entry) => fs.existsSync(entry));
  if (!resolved) {
    throw new Error("未找到 hls.js@1.6.16。请先执行 npm install，或通过 HLS_JS_ENTRY 指定 hls.mjs 路径。");
  }
  return resolved;
}

const hlsEntry = resolveHlsEntry();

export default defineConfig({
  root: path.resolve("src/desktop/renderer"),
  publicDir: path.resolve("public"),
  plugins: [vue()],
  base: "./",
  resolve: {
    alias: {
      "hls.js": hlsEntry,
    },
  },
  server: {
    fs: {
      allow: [projectRoot, path.dirname(hlsEntry)],
    },
  },
  build: {
    outDir: path.resolve("dist/renderer"),
    emptyOutDir: true,
  },
});
