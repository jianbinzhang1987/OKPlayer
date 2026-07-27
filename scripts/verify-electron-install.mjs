import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const requested = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).devDependencies?.electron;
const locked = lock.packages?.["node_modules/electron"]?.version;
const installedPackagePath = path.join(root, "node_modules", "electron", "package.json");

assert.equal(typeof requested, "string", "package.json 缺少 Electron 版本");
assert.equal(typeof locked, "string", "package-lock.json 缺少 Electron 锁定版本");
assert.ok(existsSync(installedPackagePath), "node_modules 中尚未安装 Electron，请先执行 npm ci");

const installed = JSON.parse(readFileSync(installedPackagePath, "utf8")).version;
assert.equal(installed, locked, `Electron 安装版本 ${installed} 与锁定版本 ${locked} 不一致，请执行 npm ci`);

const major = Number(String(installed).split(".", 1)[0]);
assert.ok(major >= 43, `内置 HLS 验收要求 Electron 43 或更高版本，当前为 ${installed}`);

console.log(JSON.stringify({ status: "passed", requested, locked, installed }));
