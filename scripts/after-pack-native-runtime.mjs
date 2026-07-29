import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export default async function afterPackNativeRuntime(context) {
  const platform = context.electronPlatformName || process.platform;
  const resourcesDirectory = resolveResourcesDirectory(context.appOutDir, platform, context.packager?.appInfo?.productFilename);
  if (!resourcesDirectory || !existsSync(resourcesDirectory)) return;

  const nativeRoot = path.join(resourcesDirectory, "native");
  const libmpvRoot = path.join(resourcesDirectory, "libmpv");
  const files = [
    ...(existsSync(nativeRoot) ? await collectFiles(nativeRoot) : []),
    ...(existsSync(libmpvRoot) ? await collectFiles(libmpvRoot) : []),
  ].filter(isNativeRuntimeFile).sort();

  const dependencyAudit = platform === "darwin"
    ? auditDarwinDependencies(files.filter((file) => file.endsWith(".dylib")))
    : platform === "win32"
      ? auditWindowsDependencies(files.filter((file) => file.toLowerCase().endsWith(".dll")))
      : auditLinuxDependencies(files.filter((file) => path.basename(file).includes(".so")), resourcesDirectory);
  if (dependencyAudit.unresolved.length > 0) {
    throw new Error(`打包后的 libmpv 仍有未闭合依赖：\n${dependencyAudit.unresolved.map((item) => `${item.file}: ${item.dependency}`).join("\n")}`);
  }

  const signing = platform === "darwin" ? signDarwinNativeRuntime(files) : { mode: platform === "linux" ? "not-applicable" : "electron-builder" };
  const normalizedArch = normalizeBuilderArch(context.arch);
  const preparedManifest = await readPreparedRuntimeManifest(libmpvRoot, platform, normalizedArch);
  const manifestDependencyAudit = sanitizeDependencyAudit(dependencyAudit, resourcesDirectory);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform,
    arch: normalizedArch,
    dependencyAudit: manifestDependencyAudit,
    signing,
    hashStage: platform === "linux" ? "final" : "after-pack-before-platform-signing",
    hashPurpose: platform === "linux" ? "packaged-runtime-integrity" : "pre-sign-runtime-integrity",
    licensing: preparedManifest?.licensing,
    preparedRuntimeManifest: preparedManifest ? path.relative(resourcesDirectory, preparedManifest.path) : undefined,
    files: await Promise.all(files.map(async (file) => ({
      path: path.relative(resourcesDirectory, file),
      bytes: (await stat(file)).size,
      sha256: await sha256(file),
      architecture: inspectArchitecture(file, platform),
    }))),
  };
  await writeFile(path.join(resourcesDirectory, "native-runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Native runtime afterPack verified: ${files.length} files, signing=${signing.mode}`);
}

function sanitizeDependencyAudit(audit, resourcesDirectory) {
  return {
    ...audit,
    unresolved: (audit.unresolved || []).map((item) => ({
      file: path.relative(resourcesDirectory, item.file),
      dependency: item.dependency,
    })),
  };
}

async function readPreparedRuntimeManifest(libmpvRoot, platform, arch) {
  const platformName = platform === "darwin" ? "darwin" : platform === "win32" ? "win32" : "linux";
  const manifestPath = path.join(libmpvRoot, `${platformName}-${arch}`, "runtime-manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return { ...manifest, path: manifestPath };
}

function normalizeBuilderArch(value) {
  const names = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
  return names[value] || String(value);
}

function resolveResourcesDirectory(appOutDir, platform, productFilename) {
  if (platform !== "darwin") return path.join(appOutDir, "resources");
  const appName = productFilename ? `${productFilename}.app` : undefined;
  if (appName && existsSync(path.join(appOutDir, appName))) {
    return path.join(appOutDir, appName, "Contents", "Resources");
  }
  const entries = execFileSync("find", [appOutDir, "-maxdepth", "1", "-name", "*.app", "-print"], { encoding: "utf8" })
    .split("\n").map((item) => item.trim()).filter(Boolean);
  return entries[0] ? path.join(entries[0], "Contents", "Resources") : undefined;
}

async function collectFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

function isNativeRuntimeFile(file) {
  const name = path.basename(file).toLowerCase();
  return name.endsWith(".node") || name.endsWith(".dylib") || name.endsWith(".dll") || name.includes(".so");
}

function auditDarwinDependencies(files) {
  const unresolved = [];
  for (const file of files) {
    const dependencies = inspectDarwinDependencies(file);
    for (const dependency of dependencies) {
      if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")) continue;
      if (!dependency.startsWith("@loader_path/")) {
        unresolved.push({ file, dependency });
        continue;
      }
      const target = path.resolve(path.dirname(file), dependency.slice("@loader_path/".length));
      if (!existsSync(target)) unresolved.push({ file, dependency });
    }
  }
  return { checked: files.length, unresolved };
}

function inspectDarwinDependencies(file) {
  return execFileSync("otool", ["-L", file], { encoding: "utf8" })
    .split("\n").slice(1)
    .map((line) => /^\s*(.+?)\s+\(compatibility version/.exec(line)?.[1])
    .filter(Boolean);
}

function auditWindowsDependencies(files) {
  const unresolved = [];
  const packagedNames = new Set(files.map((file) => path.basename(file).toLowerCase()));
  for (const file of files) {
    for (const dependency of inspectWindowsDependencies(file)) {
      const normalized = dependency.toLowerCase();
      if (!isWindowsSystemDependency(normalized) && !packagedNames.has(normalized)) {
        unresolved.push({ file, dependency });
      }
    }
  }
  return { checked: files.length, unresolved: deduplicateDependencyIssues(unresolved), externalSystemDependencies: [] };
}

function inspectWindowsDependencies(file) {
  if (commandExists("dumpbin")) {
    return [...new Set(execFileSync("dumpbin", ["/nologo", "/dependents", file], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => /^\s*([A-Za-z0-9._+-]+\.dll)\s*$/i.exec(line)?.[1])
      .filter(Boolean))];
  }
  for (const tool of ["llvm-objdump", "objdump"]) {
    if (!commandExists(tool)) continue;
    return [...new Set(execFileSync(tool, ["-p", file], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => /DLL Name:\s*([^\s]+\.dll)/i.exec(line)?.[1])
      .filter(Boolean))];
  }
  throw new Error("Windows 打包后依赖审计需要 dumpbin、llvm-objdump 或 objdump");
}

function isWindowsSystemDependency(name) {
  if (name.startsWith("api-ms-win-") || name.startsWith("ext-ms-win-")) return true;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (systemRoot && ["System32", "SysWOW64"].some((directory) => existsSync(path.join(systemRoot, directory, name)))) return true;
  }
  return new Set([
    "advapi32.dll", "bcrypt.dll", "cfgmgr32.dll", "comctl32.dll", "comdlg32.dll",
    "crypt32.dll", "d3d11.dll", "d3d12.dll", "dbghelp.dll", "dnsapi.dll",
    "dwmapi.dll", "dxgi.dll", "gdi32.dll", "imm32.dll", "iphlpapi.dll",
    "kernel32.dll", "mf.dll", "mfplat.dll", "mfreadwrite.dll", "mfuuid.dll",
    "ntdll.dll", "ole32.dll", "oleaut32.dll", "opengl32.dll", "powrprof.dll",
    "propsys.dll", "psapi.dll", "rpcrt4.dll", "secur32.dll", "setupapi.dll",
    "shell32.dll", "shlwapi.dll", "user32.dll", "userenv.dll", "uxtheme.dll",
    "version.dll", "winhttp.dll", "winmm.dll", "wintrust.dll", "ws2_32.dll",
    "wtsapi32.dll", "node.exe", "electron.exe",
  ]).has(name);
}

function auditLinuxDependencies(files, resourcesDirectory) {
  const unresolved = [];
  const externalSystemDependencies = new Set();
  for (const file of files) {
    const environment = { ...process.env, LD_LIBRARY_PATH: path.dirname(file) };
    for (const dependency of inspectLinuxDependencies(file, environment)) {
      if (dependency.virtual) continue;
      if (dependency.missing) {
        unresolved.push({ file, dependency: dependency.name });
        continue;
      }
      if (!dependency.path) continue;
      if (isLinuxSystemDependency(dependency.path)) {
        externalSystemDependencies.add(dependency.name);
        continue;
      }
      const resolved = path.resolve(dependency.path);
      if (!resolved.startsWith(`${path.resolve(resourcesDirectory)}${path.sep}`)) {
        unresolved.push({ file, dependency: dependency.path });
      }
    }
  }
  return {
    checked: files.length,
    unresolved: deduplicateDependencyIssues(unresolved),
    externalSystemDependencies: [...externalSystemDependencies].sort(),
  };
}

function inspectLinuxDependencies(file, environment) {
  if (!commandExists("ldd")) throw new Error("Linux 打包后依赖审计需要 ldd");
  let output;
  try {
    output = execFileSync("ldd", [file], { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
    if (!output.trim()) throw error;
  }
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    if (/^linux-vdso\.so/.test(line)) return { name: line.split(/\s+/)[0], virtual: true };
    const missing = /^([^\s]+)\s+=>\s+not found$/.exec(line);
    if (missing) return { name: missing[1], missing: true };
    const resolved = /^([^\s]+)\s+=>\s+(\/[^\s]+)\s+\(/.exec(line);
    if (resolved) return { name: resolved[1], path: resolved[2] };
    const direct = /^(\/[^\s]+)\s+\(/.exec(line);
    if (direct) return { name: path.basename(direct[1]), path: direct[1] };
    return { name: line.split(/\s+/)[0] };
  });
}

function isLinuxSystemDependency(file) {
  const normalized = path.resolve(file);
  return normalized.startsWith("/lib/")
    || normalized.startsWith("/lib64/")
    || normalized.startsWith("/usr/lib/")
    || normalized.startsWith("/usr/lib64/");
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function deduplicateDependencyIssues(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.file}\u0000${item.dependency}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function signDarwinNativeRuntime(files) {
  if (process.env.FONGMI_SIGN_NATIVE_RUNTIME === "0") return { mode: "disabled" };
  const identity = String(process.env.FONGMI_NATIVE_CODESIGN_IDENTITY || process.env.CSC_NAME || "-").trim() || "-";
  const ordered = [
    ...files.filter((file) => file.endsWith(".dylib")),
    ...files.filter((file) => !file.endsWith(".dylib")),
  ];
  for (const file of ordered) {
    const args = ["--force", "--sign", identity];
    if (identity === "-") args.push("--timestamp=none");
    else args.push("--options", "runtime", "--timestamp");
    args.push(file);
    execFileSync("codesign", args, { stdio: "pipe" });
    execFileSync("codesign", ["--verify", "--strict", file], { stdio: "pipe" });
  }
  return { mode: identity === "-" ? "ad-hoc" : "developer-id", identity, signedFiles: ordered.length };
}

function inspectArchitecture(file, platform) {
  try {
    if (platform === "darwin") return execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim();
    if (platform === "win32") return "pe";
    return execFileSync("file", [file], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}
