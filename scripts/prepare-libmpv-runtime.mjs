import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderNativeRuntimeNotice, runtimeLicensingFromEnvironment } from "./lib/native-runtime-license.mjs";

const root = process.cwd();
const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const requestedArch = String(process.env.FONGMI_NATIVE_ARCH || process.arch).trim();
const arch = requestedArch === "arm64" ? "arm64" : "x64";
const sourceInput = String(process.env.FONGMI_LIBMPV_SOURCE || process.env.FONGMI_LIBMPV_LIBRARY || "").trim();
const outputDirectory = path.resolve(
  process.env.FONGMI_LIBMPV_OUTPUT_DIR
    || path.join(root, "build", "native-runtime", "libmpv", `${platform}-${arch}`),
);

if (!sourceInput) {
  throw new Error("缺少 FONGMI_LIBMPV_SOURCE，请指定经过确认的 libmpv 动态库绝对路径");
}
if (!path.isAbsolute(sourceInput) || !existsSync(sourceInput)) {
  throw new Error(`libmpv 源文件不存在或不是绝对路径：${sourceInput}`);
}

const sourcePath = realpathSync(sourceInput);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, ".gitkeep"), "", "utf8");

const result = platform === "darwin"
  ? await prepareDarwinRuntime(sourcePath, outputDirectory)
  : platform === "win32"
    ? await prepareWindowsRuntime(sourcePath, outputDirectory)
    : await prepareLinuxRuntime(sourcePath, outputDirectory);
await ensureCanonicalEntryLibrary(result, outputDirectory, platform);
const licensing = runtimeLicensingFromEnvironment(result.files);

const manifest = {
  schemaVersion: 1,
  preparedAt: new Date().toISOString(),
  platform,
  arch,
  source: {
    fileName: path.basename(sourcePath),
    sha256: await sha256(sourcePath),
  },
  entryLibrary: result.entryLibrary,
  files: await Promise.all(result.files.map(async (file) => ({
    name: path.basename(file),
    bytes: (await stat(file)).size,
    sha256: await sha256(file),
  }))),
  unresolvedDependencies: result.unresolvedDependencies,
  externalSystemDependencies: result.externalSystemDependencies || [],
  signing: result.signing,
  hashStage: platform === "linux" ? "final" : "prepared-before-application-signing",
  hashPurpose: platform === "linux" ? "packaged-runtime-integrity" : "prepared-runtime-integrity",
  licensing,
};

await writeFile(path.join(outputDirectory, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDirectory, "NATIVE_RUNTIME_NOTICES.md"), renderNativeRuntimeNotice(licensing), "utf8");
console.log(JSON.stringify(manifest, null, 2));
if (manifest.unresolvedDependencies.length > 0) process.exitCode = 1;

async function prepareDarwinRuntime(entry, output) {
  const queue = [entry];
  const visited = new Set();
  const records = new Map();
  const basenameOwners = new Map();
  const unresolvedDependencies = [];

  while (queue.length) {
    const current = realpathSync(queue.shift());
    if (visited.has(current)) continue;
    visited.add(current);
    const basename = path.basename(current);
    const previousOwner = basenameOwners.get(basename);
    if (previousOwner && previousOwner !== current) {
      throw new Error(`动态库文件名冲突：${basename}\n${previousOwner}\n${current}`);
    }
    basenameOwners.set(basename, current);

    const dependencies = inspectDarwinDependencies(current);
    const resolved = [];
    for (const dependency of dependencies) {
      if (isDarwinSystemDependency(dependency.reference)) continue;
      const target = resolveDarwinDependency(current, dependency.reference);
      if (!target) {
        unresolvedDependencies.push({ file: current, dependency: dependency.reference });
        continue;
      }
      resolved.push({ reference: dependency.reference, target });
      queue.push(target);
    }
    records.set(current, resolved);
  }

  const copied = new Map();
  for (const original of records.keys()) {
    const destination = path.join(output, path.basename(original));
    await copyFile(original, destination);
    await chmod(destination, 0o755);
    copied.set(original, destination);
  }

  for (const [original, dependencies] of records) {
    const destination = copied.get(original);
    run("install_name_tool", ["-id", `@loader_path/${path.basename(destination)}`, destination]);
    for (const dependency of dependencies) {
      run("install_name_tool", [
        "-change",
        dependency.reference,
        `@loader_path/${path.basename(dependency.target)}`,
        destination,
      ]);
    }
  }

  const signing = await signDarwinRuntime([...copied.values()]);
  const packagedUnresolved = [];
  for (const destination of copied.values()) {
    for (const dependency of inspectDarwinDependencies(destination)) {
      if (isDarwinSystemDependency(dependency.reference)) continue;
      if (!dependency.reference.startsWith("@loader_path/")) {
        packagedUnresolved.push({ file: destination, dependency: dependency.reference });
        continue;
      }
      const target = path.resolve(path.dirname(destination), dependency.reference.slice("@loader_path/".length));
      if (!existsSync(target)) packagedUnresolved.push({ file: destination, dependency: dependency.reference });
    }
  }

  return {
    entryLibrary: path.basename(entry),
    files: [...copied.values()].sort(),
    unresolvedDependencies: [...unresolvedDependencies, ...packagedUnresolved],
    signing,
  };
}

async function prepareWindowsRuntime(entry, output) {
  const searchDirectories = runtimeSearchDirectories(path.dirname(entry));
  const available = await indexRuntimeFiles(searchDirectories, (name) => name.toLowerCase().endsWith(".dll"));
  const queue = [entry];
  const visited = new Map();
  const unresolvedDependencies = [];

  while (queue.length > 0) {
    const current = realpathSync(queue.shift());
    const key = current.toLowerCase();
    if (visited.has(key)) continue;
    visited.set(key, current);
    for (const dependency of inspectWindowsDependencies(current)) {
      const normalized = dependency.toLowerCase();
      if (isWindowsSystemDependency(normalized)) continue;
      const target = available.get(normalized);
      if (!target) {
        unresolvedDependencies.push({ file: current, dependency });
        continue;
      }
      queue.push(target);
    }
  }

  const copied = [];
  for (const source of visited.values()) {
    const destination = path.join(output, path.basename(source));
    await copyFile(source, destination);
    copied.push(destination);
  }

  const packagedNames = new Set(copied.map((file) => path.basename(file).toLowerCase()));
  for (const file of copied) {
    for (const dependency of inspectWindowsDependencies(file)) {
      const normalized = dependency.toLowerCase();
      if (!isWindowsSystemDependency(normalized) && !packagedNames.has(normalized)) {
        unresolvedDependencies.push({ file, dependency });
      }
    }
  }

  return {
    entryLibrary: path.basename(entry),
    files: copied.sort(),
    unresolvedDependencies: deduplicateDependencyIssues(unresolvedDependencies),
    signing: { mode: "electron-builder" },
  };
}

async function prepareLinuxRuntime(entry, output) {
  const searchDirectories = runtimeSearchDirectories(path.dirname(entry));
  const available = await indexRuntimeFiles(searchDirectories, (name) => name.includes(".so"));
  const queue = [entry];
  const visited = new Map();
  const unresolvedDependencies = [];
  const externalSystemDependencies = new Set();

  while (queue.length > 0) {
    const current = realpathSync(queue.shift());
    if (visited.has(current)) continue;
    visited.set(current, current);
    for (const dependency of inspectLinuxDependencies(current)) {
      if (dependency.virtual) continue;
      if (dependency.missing) {
        const local = available.get(dependency.name);
        if (local) queue.push(local);
        else unresolvedDependencies.push({ file: current, dependency: dependency.name });
        continue;
      }
      if (!dependency.path) continue;
      if (isLinuxSystemDependency(dependency.path)) {
        externalSystemDependencies.add(dependency.name);
        continue;
      }
      const local = available.get(dependency.name) || (existsSync(dependency.path) ? dependency.path : undefined);
      if (local) queue.push(local);
      else unresolvedDependencies.push({ file: current, dependency: dependency.name });
    }
  }

  const copied = [];
  const copiedNames = new Set();
  for (const source of visited.values()) {
    const name = path.basename(source);
    if (copiedNames.has(name)) throw new Error(`Linux 动态库文件名冲突：${name}`);
    copiedNames.add(name);
    const destination = path.join(output, name);
    await copyFile(source, destination);
    await chmod(destination, 0o755);
    copied.push(destination);
  }

  if (commandExists("patchelf")) {
    for (const file of copied) {
      for (const needed of inspectLinuxNeeded(file)) {
        if (!needed.includes("/")) continue;
        const basename = path.basename(needed);
        if (copiedNames.has(basename)) run("patchelf", ["--replace-needed", needed, basename, file]);
      }
      run("patchelf", ["--set-rpath", "$ORIGIN", file]);
    }
  } else if (copied.length > 1 && process.env.FONGMI_ALLOW_UNAUDITED_RUNTIME !== "1") {
    throw new Error("Linux 自包含 libmpv 运行时要求安装 patchelf；仅测试时可设置 FONGMI_ALLOW_UNAUDITED_RUNTIME=1");
  }

  const packagedEnvironment = { ...process.env, LD_LIBRARY_PATH: output };
  for (const file of copied) {
    for (const dependency of inspectLinuxDependencies(file, packagedEnvironment)) {
      if (dependency.virtual || (!dependency.missing && dependency.path && isLinuxSystemDependency(dependency.path))) continue;
      if (dependency.missing) {
        unresolvedDependencies.push({ file, dependency: dependency.name });
        continue;
      }
      if (dependency.path && !path.resolve(dependency.path).startsWith(`${path.resolve(output)}${path.sep}`)) {
        unresolvedDependencies.push({ file, dependency: dependency.path });
      }
    }
  }

  return {
    entryLibrary: path.basename(entry),
    files: copied.sort(),
    unresolvedDependencies: deduplicateDependencyIssues(unresolvedDependencies),
    externalSystemDependencies: [...externalSystemDependencies].sort(),
    signing: { mode: "not-applicable" },
  };
}

async function ensureCanonicalEntryLibrary(result, output, targetPlatform) {
  const canonicalNames = targetPlatform === "darwin"
    ? ["libmpv.2.dylib", "libmpv.dylib"]
    : targetPlatform === "win32"
      ? ["mpv-2.dll", "libmpv-2.dll", "libmpv.dll"]
      : ["libmpv.so.2", "libmpv.so"];
  if (canonicalNames.includes(result.entryLibrary)) return;
  const source = result.files.find((file) => path.basename(file) === result.entryLibrary);
  if (!source) throw new Error(`无法定位已准备的 libmpv 入口文件：${result.entryLibrary}`);
  const canonical = canonicalNames[0];
  const destination = path.join(output, canonical);
  await copyFile(source, destination);
  if (targetPlatform !== "win32") await chmod(destination, 0o755);
  if (targetPlatform === "darwin") {
    run("install_name_tool", ["-id", `@loader_path/${canonical}`, destination]);
    const identity = String(process.env.FONGMI_NATIVE_CODESIGN_IDENTITY || "-").trim() || "-";
    const args = ["--force", "--sign", identity];
    if (identity === "-") args.push("--timestamp=none");
    else args.push("--options", "runtime", "--timestamp");
    args.push(destination);
    run("codesign", args);
  }
  result.files.push(destination);
  result.files.sort();
  result.entryLibrary = canonical;
}

function runtimeSearchDirectories(entryDirectory) {
  const entry = { directory: realpathSync(entryDirectory), recursive: false };
  const configured = String(process.env.FONGMI_LIBMPV_DEPENDENCY_DIRS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => path.isAbsolute(item) && existsSync(item))
    .map((item) => ({ directory: realpathSync(item), recursive: true }));
  const seen = new Set([entry.directory]);
  return [entry, ...configured.filter((item) => {
    if (seen.has(item.directory)) return false;
    seen.add(item.directory);
    return true;
  })];
}

async function indexRuntimeFiles(directories, predicate) {
  const index = new Map();
  for (const item of directories) {
    for (const file of await collectRuntimeFiles(item.directory, predicate, item.recursive)) {
      const key = path.basename(file).toLowerCase();
      const previous = index.get(key);
      if (previous && previous !== file) {
        throw new Error(`运行时依赖文件名冲突：${path.basename(file)}\n${previous}\n${file}`);
      }
      index.set(key, file);
    }
  }
  return index;
}

async function collectRuntimeFiles(directory, predicate, recursive) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) result.push(...await collectRuntimeFiles(target, predicate, true));
    else if (entry.isFile() && predicate(entry.name)) result.push(realpathSync(target));
  }
  return result;
}

function inspectWindowsDependencies(file) {
  if (commandExists("dumpbin")) {
    const output = run("dumpbin", ["/nologo", "/dependents", file]);
    return [...new Set(output.split(/\r?\n/)
      .map((line) => /^\s*([A-Za-z0-9._+-]+\.dll)\s*$/i.exec(line)?.[1])
      .filter(Boolean))];
  }
  for (const tool of ["llvm-objdump", "objdump"]) {
    if (!commandExists(tool)) continue;
    const output = run(tool, ["-p", file]);
    return [...new Set(output.split(/\r?\n/)
      .map((line) => /DLL Name:\s*([^\s]+\.dll)/i.exec(line)?.[1])
      .filter(Boolean))];
  }
  if (process.env.FONGMI_ALLOW_UNAUDITED_RUNTIME === "1") return [];
  throw new Error("Windows libmpv 依赖审计需要 dumpbin、llvm-objdump 或 objdump");
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

function inspectLinuxDependencies(file, environment = process.env) {
  if (!commandExists("ldd")) {
    if (process.env.FONGMI_ALLOW_UNAUDITED_RUNTIME === "1") return [];
    throw new Error("Linux libmpv 依赖审计需要 ldd");
  }
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
    if (resolved) return { name: resolved[1], path: resolved[2], missing: false };
    const direct = /^(\/[^\s]+)\s+\(/.exec(line);
    if (direct) return { name: path.basename(direct[1]), path: direct[1], missing: false };
    return { name: line.split(/\s+/)[0], missing: false };
  });
}

function inspectLinuxNeeded(file) {
  if (commandExists("patchelf")) {
    return run("patchelf", ["--print-needed", file]).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  if (commandExists("readelf")) {
    return run("readelf", ["-d", file]).split(/\r?\n/)
      .map((line) => /Shared library:\s*\[([^\]]+)\]/.exec(line)?.[1])
      .filter(Boolean);
  }
  return [];
}

function isLinuxSystemDependency(file) {
  const normalized = path.resolve(file);
  return normalized.startsWith("/lib/")
    || normalized.startsWith("/lib64/")
    || normalized.startsWith("/usr/lib/")
    || normalized.startsWith("/usr/lib64/");
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

function inspectDarwinDependencies(file) {
  const output = run("otool", ["-L", file]);
  return output.split("\n").slice(1).map((line) => {
    const match = /^\s*(.+?)\s+\(compatibility version/.exec(line);
    return match ? { reference: match[1] } : undefined;
  }).filter(Boolean);
}

function inspectDarwinRpaths(file) {
  const output = run("otool", ["-l", file]);
  const lines = output.split("\n");
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "cmd LC_RPATH") continue;
    for (let next = index + 1; next < Math.min(lines.length, index + 8); next += 1) {
      const match = /^\s*path\s+(.+?)\s+\(offset/.exec(lines[next] || "");
      if (match) {
        values.push(match[1]);
        break;
      }
    }
  }
  return values;
}

function resolveDarwinDependency(owner, reference) {
  if (path.isAbsolute(reference)) return existsSync(reference) ? realpathSync(reference) : undefined;
  const ownerDirectory = path.dirname(owner);
  if (reference.startsWith("@loader_path/")) {
    const candidate = path.resolve(ownerDirectory, reference.slice("@loader_path/".length));
    return existsSync(candidate) ? realpathSync(candidate) : undefined;
  }
  if (reference.startsWith("@rpath/")) {
    const suffix = reference.slice("@rpath/".length);
    for (const rawRpath of inspectDarwinRpaths(owner)) {
      const expanded = rawRpath
        .replace(/^@loader_path/, ownerDirectory)
        .replace(/^@executable_path/, ownerDirectory);
      const candidate = path.resolve(expanded, suffix);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
  }
  if (reference.startsWith("@executable_path/")) {
    const candidate = path.resolve(ownerDirectory, reference.slice("@executable_path/".length));
    return existsSync(candidate) ? realpathSync(candidate) : undefined;
  }
  return undefined;
}

function isDarwinSystemDependency(reference) {
  return reference.startsWith("/System/Library/") || reference.startsWith("/usr/lib/");
}

async function signDarwinRuntime(files) {
  const enabled = process.env.FONGMI_LIBMPV_CODESIGN !== "0";
  if (!enabled) return { mode: "disabled" };
  const identity = String(process.env.FONGMI_NATIVE_CODESIGN_IDENTITY || "-").trim() || "-";
  for (const file of files) {
    const args = ["--force", "--sign", identity];
    if (identity === "-") args.push("--timestamp=none");
    else args.push("--options", "runtime", "--timestamp");
    args.push(file);
    run("codesign", args);
    run("codesign", ["--verify", "--strict", file]);
  }
  return { mode: identity === "-" ? "ad-hoc" : "developer-id", identity };
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}
