import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const buildDir = path.join(root, "build");
const iconSvg = path.join(buildDir, "icon.svg");
const dmgSvg = path.join(buildDir, "dmg-background.svg");
const iconPng = path.join(buildDir, "icon.png");
const iconIcns = path.join(buildDir, "icon.icns");
const dmgPng = path.join(buildDir, "dmg-background.png");
const iconset = path.join(buildDir, "icon.iconset");
const iconsetWork = path.join(buildDir, "iconset-work");

await mkdir(buildDir, { recursive: true });

if (process.platform !== "darwin") {
  await assertReadable(iconPng, "Windows/Linux 构建需要预生成的 build/icon.png");
  const pngStat = await stat(iconPng);
  console.log(JSON.stringify({
    platform: process.platform,
    mode: "reuse-prebuilt-assets",
    iconPng: { path: path.relative(root, iconPng), bytes: pngStat.size },
  }, null, 2));
  process.exit(0);
}

await assertReadable(iconSvg);
await assertReadable(dmgSvg);
await renderSvg(iconSvg, iconPng, 1024, 1024);
await renderSvg(dmgSvg, dmgPng, 660, 400);

await rm(iconset, { recursive: true, force: true });
await rm(iconsetWork, { recursive: true, force: true });
await mkdir(iconsetWork, { recursive: true });

const iconTargets = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

for (const [size, fileName] of iconTargets) {
  await runSipsResize(iconPng, path.join(iconsetWork, fileName), size, size);
}

await rename(iconsetWork, iconset);
execFileSync("iconutil", ["-c", "icns", iconset, "-o", iconIcns], { stdio: "inherit" });
await rm(iconset, { recursive: true, force: true });

const [pngStat, icnsStat, dmgStat] = await Promise.all([stat(iconPng), stat(iconIcns), stat(dmgPng)]);
console.log(JSON.stringify({
  platform: process.platform,
  mode: "render-macos-assets",
  iconPng: { path: path.relative(root, iconPng), bytes: pngStat.size },
  iconIcns: { path: path.relative(root, iconIcns), bytes: icnsStat.size },
  dmgBackground: { path: path.relative(root, dmgPng), bytes: dmgStat.size },
}, null, 2));

async function assertReadable(filePath, customMessage) {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(customMessage ?? `缺少发布资源：${path.relative(root, filePath)}`);
}

async function renderSvg(source, output, width, height) {
  try {
    execFileSync("sips", ["-s", "format", "png", source, "--out", output], { stdio: "ignore" });
    await runSipsResize(output, output, width, height);
    return;
  } catch {
    // Some macOS releases do not let sips decode SVG directly. Quick Look is a stable fallback.
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "fongmi-release-assets-"));
  try {
    execFileSync("qlmanage", ["-t", "-s", String(Math.max(width, height)), "-o", tempDirectory, source], {
      stdio: "ignore",
    });
    const preview = path.join(tempDirectory, `${path.basename(source)}.png`);
    await cp(preview, output);
    await runSipsResize(output, output, width, height);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function runSipsResize(source, output, width, height) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync("sips", ["-z", String(height), String(width), source, "--out", output], {
        stdio: attempt === 3 ? "inherit" : "ignore",
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  throw lastError;
}
