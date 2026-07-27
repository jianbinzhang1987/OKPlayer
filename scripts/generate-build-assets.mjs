import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const buildDirectory = path.join(root, "build");
const iconSource = path.join(buildDirectory, "icon.svg");
const backgroundSource = path.join(buildDirectory, "background.svg");
const iconPng = path.join(buildDirectory, "icon.png");
const iconSet = path.join(buildDirectory, "icon.iconset");
const iconIcns = path.join(buildDirectory, "icon.icns");

function commandExists(command) {
  return spawnSync("/usr/bin/env", ["which", command], { stdio: "ignore" }).status === 0;
}

const imageMagick = commandExists("magick") ? "magick" : commandExists("convert") ? "convert" : "";
if (!imageMagick) throw new Error("缺少 ImageMagick，无法生成 macOS 图标与 DMG 背景。请安装 magick 或 convert。");
if (!commandExists("iconutil")) throw new Error("缺少 macOS iconutil，无法生成 icon.icns。");
if (!fs.existsSync(iconSource)) throw new Error(`缺少图标源文件：${iconSource}`);
if (!fs.existsSync(backgroundSource)) throw new Error(`缺少 DMG 背景源文件：${backgroundSource}`);

fs.mkdirSync(buildDirectory, { recursive: true });
execFileSync(imageMagick, ["-background", "none", iconSource, "-resize", "1024x1024", iconPng], { stdio: "inherit" });
execFileSync(imageMagick, [backgroundSource, "-resize", "540x380!", path.join(buildDirectory, "background.png")], { stdio: "inherit" });
execFileSync(imageMagick, [backgroundSource, "-resize", "1080x760!", path.join(buildDirectory, "background@2x.png")], { stdio: "inherit" });

fs.rmSync(iconSet, { recursive: true, force: true });
fs.mkdirSync(iconSet, { recursive: true });
const iconEntries = [
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
for (const [size, filename] of iconEntries) {
  execFileSync(imageMagick, [iconPng, "-resize", `${size}x${size}!`, path.join(iconSet, filename)], { stdio: "inherit" });
}
execFileSync("iconutil", ["-c", "icns", iconSet, "-o", iconIcns], { stdio: "inherit" });
fs.rmSync(iconSet, { recursive: true, force: true });

for (const output of [iconPng, iconIcns, path.join(buildDirectory, "background.png"), path.join(buildDirectory, "background@2x.png")]) {
  const stats = fs.statSync(output);
  if (stats.size <= 0) throw new Error(`生成的资源为空：${output}`);
}

console.log(JSON.stringify({
  status: "generated",
  icon: path.relative(root, iconIcns),
  background: path.relative(root, path.join(buildDirectory, "background.png")),
  retinaBackground: path.relative(root, path.join(buildDirectory, "background@2x.png")),
}, null, 2));
