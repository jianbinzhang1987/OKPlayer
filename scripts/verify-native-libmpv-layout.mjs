import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const requiredFiles = [
  "native/libmpv-player/package.json",
  "native/libmpv-player/binding.gyp",
  "native/libmpv-player/src/addon.cc",
  "native/libmpv-player/src/libmpv_player.h",
  "native/libmpv-player/src/libmpv_player.cc",
  "native/libmpv-player/src/platform/native_view.h",
  "native/libmpv-player/src/platform/native_view.cc",
  "native/libmpv-player/src/platform/native_view_darwin.mm",
  "native/libmpv-player/src/platform/native_view_win.cc",
  "native/libmpv-player/src/platform/native_view_linux.cc",
  "resources/native/libmpv-player/README.md",
  "resources/libmpv/README.md",
];

const missing = requiredFiles.filter((file) => !existsSync(path.join(root, file)));
if (missing.length) {
  console.error("Missing native libmpv layout files:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

const builder = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
for (const marker of ["resources/native", "resources/libmpv", "**/*.node", "**/*.dylib", "**/*.dll", "**/*.so*"]) {
  if (!builder.includes(marker)) {
    console.error(`electron-builder.yml missing marker: ${marker}`);
    process.exit(1);
  }
}

const addon = readFileSync(path.join(root, "native/libmpv-player/src/addon.cc"), "utf8");
for (const marker of ["createPlayer", "getBuildInfo", "setVolume", "setMuted", "node_api.h"]) {
  if (!addon.includes(marker)) {
    console.error(`native addon missing marker: ${marker}`);
    process.exit(1);
  }
}

console.log("Native libmpv layout verified.");
