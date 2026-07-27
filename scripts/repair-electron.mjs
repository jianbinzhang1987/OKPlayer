import extractZip from "@electron-internal/extract-zip";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const version = lock.packages?.["node_modules/electron"]?.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error("无法从 package-lock.json 读取 Electron 锁定版本");
}

const platform = process.platform;
const arch = process.arch;
const zipName = `electron-v${version}-${platform}-${arch}.zip`;
const cacheRoots = electronCacheRoots(platform);
const zipPath = cacheRoots.map((cacheRoot) => findZip(cacheRoot, zipName)).find(Boolean);
if (!zipPath) {
  throw new Error(`未找到完整 Electron 缓存包：${zipName}；已检查 ${cacheRoots.filter(Boolean).join("、")}`);
}

const electronRoot = path.join(root, "node_modules", "electron");
const electronPackagePath = path.join(electronRoot, "package.json");
const distPath = path.join(electronRoot, "dist");
rmSync(distPath, { recursive: true, force: true });
await extractZip(zipPath, { dir: distPath });

const runtime = electronRuntimeLayout(platform, distPath);
writeFileSync(path.join(electronRoot, "path.txt"), runtime.relativeExecutable, "utf8");

if (!existsSync(electronPackagePath)) throw new Error("node_modules/electron/package.json 不存在");
const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
electronPackage.version = version;
writeFileSync(electronPackagePath, `${JSON.stringify(electronPackage, null, 2)}\n`, "utf8");

for (const requiredPath of runtime.requiredPaths) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Electron runtime 修复失败：缺少 ${path.relative(distPath, requiredPath)}`);
  }
}

console.log(JSON.stringify({
  status: "passed",
  version,
  platform,
  arch,
  zipPath,
  executable: runtime.relativeExecutable,
}));

export function electronRuntimeLayout(targetPlatform, distDirectory) {
  if (targetPlatform === "darwin") {
    return {
      relativeExecutable: "Electron.app/Contents/MacOS/Electron",
      requiredPaths: [
        path.join(distDirectory, "Electron.app", "Contents", "MacOS", "Electron"),
        path.join(distDirectory, "Electron.app", "Contents", "Frameworks", "Electron Framework.framework"),
      ],
    };
  }
  if (targetPlatform === "win32") {
    return {
      relativeExecutable: "electron.exe",
      requiredPaths: [
        path.join(distDirectory, "electron.exe"),
        path.join(distDirectory, "resources", "default_app.asar"),
      ],
    };
  }
  return {
    relativeExecutable: "electron",
    requiredPaths: [
      path.join(distDirectory, "electron"),
      path.join(distDirectory, "resources", "default_app.asar"),
    ],
  };
}

export function electronCacheRoots(targetPlatform, env = process.env, home = os.homedir()) {
  const roots = [env.ELECTRON_CACHE?.trim()].filter(Boolean);
  if (targetPlatform === "darwin") {
    roots.push(path.join(home, "Library", "Caches", "electron"));
  } else if (targetPlatform === "win32") {
    if (env.LOCALAPPDATA) {
      roots.push(path.join(env.LOCALAPPDATA, "electron", "Cache"));
      roots.push(path.join(env.LOCALAPPDATA, "electron"));
    }
    if (env.APPDATA) roots.push(path.join(env.APPDATA, "electron"));
  }
  roots.push(path.join(home, ".cache", "electron"));
  return [...new Set(roots.filter(Boolean))];
}

export function findZip(rootDirectory, expectedName, maxDepth = 4) {
  if (!rootDirectory || !existsSync(rootDirectory)) return undefined;
  const queue = [{ directory: rootDirectory, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name === expectedName && statSync(candidate).size > 20 * 1024 * 1024) {
        return candidate;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ directory: candidate, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
}
