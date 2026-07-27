import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const root = process.cwd();
const artifactDirectory = path.join(root, "artifacts", "cross-platform-package-audit");
await mkdir(artifactDirectory, { recursive: true });

const targets = [
  {
    platform: "mac",
    executable: path.join(root, "release", "mac", "FongMi Desktop.app", "Contents", "MacOS", "FongMi Desktop"),
    asarPath: path.join(root, "release", "mac", "FongMi Desktop.app", "Contents", "Resources", "app.asar"),
    resourcesPath: path.join(root, "release", "mac", "FongMi Desktop.app", "Contents", "Resources"),
    architecturePattern: /Mach-O 64-bit executable x86_64/,
    expectedMpv: path.join("mpv", "macos", "x64", "mpv"),
  },
  {
    platform: "windows",
    executable: path.join(root, "release", "win-unpacked", "FongMi Desktop.exe"),
    asarPath: path.join(root, "release", "win-unpacked", "resources", "app.asar"),
    resourcesPath: path.join(root, "release", "win-unpacked", "resources"),
    architecturePattern: /PE32\+ executable \(GUI\) x86-64/,
    expectedMpv: path.join("mpv", "windows", "x64", "mpv.exe"),
  },
  {
    platform: "linux",
    executable: path.join(root, "release", "linux-unpacked", "fongmi-desktop"),
    asarPath: path.join(root, "release", "linux-unpacked", "resources", "app.asar"),
    resourcesPath: path.join(root, "release", "linux-unpacked", "resources"),
    architecturePattern: /ELF 64-bit LSB pie executable, x86-64/,
    expectedMpv: path.join("mpv", "linux", "x64", "mpv"),
  },
];

const results = [];
for (const target of targets) {
  const executableInfo = await stat(target.executable);
  const asarInfo = await stat(target.asarPath);
  const architecture = execFileSync("file", [target.executable], { encoding: "utf8" }).trim();
  if (!target.architecturePattern.test(architecture)) {
    throw new Error(`${target.platform} 可执行文件架构异常：${architecture}`);
  }

  const entries = asar.listPackage(target.asarPath);
  const normalized = entries.map((entry) => entry.replace(/^\//, ""));
  const hlsChunks = normalized.filter((entry) => /dist\/renderer\/assets\/hls-.+\.js$/.test(entry));
  const artPlayerChunks = normalized.filter((entry) => /dist\/renderer\/assets\/ArtPlayerHost-.+\.js$/.test(entry));
  if (hlsChunks.length !== 1) throw new Error(`${target.platform} HLS 分块数量异常：${hlsChunks.length}`);
  if (artPlayerChunks.length !== 1) throw new Error(`${target.platform} ArtPlayer 分块数量异常：${artPlayerChunks.length}`);
  if (!normalized.includes("THIRD_PARTY_NOTICES.md")) throw new Error(`${target.platform} 缺少第三方许可证声明`);

  const packageJson = JSON.parse(asar.extractFile(target.asarPath, "package.json").toString("utf8"));
  if (packageJson.name !== "fongmi-desktop" || packageJson.productName !== "FongMi Desktop") {
    throw new Error(`${target.platform} 产品标识异常`);
  }
  const rendererHtml = asar.extractFile(target.asarPath, "dist/renderer/index.html").toString("utf8");
  if (!rendererHtml.includes("FongMi Desktop")) throw new Error(`${target.platform} 页面标题未迁移`);
  if (/cdn\.jsdelivr|unpkg\.com/i.test(rendererHtml)) throw new Error(`${target.platform} 仍包含外部播放器 CDN`);

  const mpvReadmePath = path.join(target.resourcesPath, "mpv", "README.md");
  const mpvReadme = await readFile(mpvReadmePath, "utf8");
  const bundledMpvPath = path.join(target.resourcesPath, target.expectedMpv);
  const bundledMpvExecutable = await stat(bundledMpvPath).then((info) => info.isFile(), () => false);

  results.push({
    platform: target.platform,
    executable: path.relative(root, target.executable),
    executableBytes: executableInfo.size,
    architecture,
    asar: path.relative(root, target.asarPath),
    asarBytes: asarInfo.size,
    productName: packageJson.productName,
    hlsChunk: hlsChunks[0],
    artPlayerChunk: artPlayerChunks[0],
    thirdPartyNotices: true,
    mpvResourceLayout: mpvReadme.includes("FONGMI_MPV_PATH"),
    bundledMpvExecutable,
    nativeRuntimeTested: target.platform === "mac",
  });
}

const report = {
  auditedAt: new Date().toISOString(),
  summary: {
    total: results.length,
    structurallyValid: results.length,
    nativeRuntimeTested: results.filter((item) => item.nativeRuntimeTested).length,
    bundledMpvExecutable: results.filter((item) => item.bundledMpvExecutable).length,
  },
  results,
  limitations: [
    "Windows 和 Linux 产物由 macOS 交叉生成，仅完成结构审计，尚未在目标系统启动。",
    "mpv 目录结构已纳入安装包，但当前尚未放入三端 mpv 可执行文件及动态库。",
  ],
};

await writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(report), "utf8");
console.log(JSON.stringify(report, null, 2));

function renderMarkdown(value) {
  const rows = value.results.map((item) => `| ${item.platform} | 通过 | ${item.architecture.replace(/\|/g, "\\|")} | ${item.hlsChunk} | ${item.artPlayerChunk} | ${item.bundledMpvExecutable ? "已包含" : "待补充"} | ${item.nativeRuntimeTested ? "已验证" : "待目标系统验证"} |`);
  return `# FongMi Desktop 跨平台 Unpacked 产物审计\n\n- 时间：${value.auditedAt}\n- 结构通过：${value.summary.structurallyValid}/${value.summary.total}\n\n| 平台 | 结构 | 可执行文件 | HLS 分块 | ArtPlayer 分块 | mpv 二进制 | 原生运行 |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\n## 当前限制\n\n${value.limitations.map((item) => `- ${item}`).join("\n")}\n`;
}
