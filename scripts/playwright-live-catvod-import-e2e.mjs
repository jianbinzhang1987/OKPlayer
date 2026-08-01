import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const sourceProfile = process.env.FONGMI_PROFILE_PATH
  || path.join(os.homedir(), "Library", "Application Support", "FongMi Desktop");
const sourceDatabase = path.join(sourceProfile, "fongmi-desktop.sqlite");
const persisted = readCurrentSourceSettings(sourceDatabase);
const sourceUrl = process.env.FONGMI_LIVE_CATVOD_URL?.trim() || persisted.catVodMd5Url;
const requestedSiteKey = process.env.FONGMI_PLAYBACK_SITE_KEY?.trim() || persisted.defaultSite;
if (!sourceUrl) throw new Error("当前应用没有保存 CatVod index.js.md5 地址");

const parsedSource = new URL(sourceUrl);
const expectedHost = parsedSource.hostname;
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root });
const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-live-catvod-"));
const artifactDirectory = path.join(root, "artifacts", "live-catvod-import-e2e");
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });
await copyCurrentProfileState(sourceDatabase, sourceProfile, userDataDirectory);

let app;
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: {
      ...process.env,
      FONGMI_E2E_DISABLE_CATVOD: "1",
    },
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });

  await page.getByRole("button", { name: "内容来源", exact: true }).click();
  await page.locator(".quick-source-page").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByPlaceholder("粘贴配置地址后按回车即可导入").fill(sourceUrl);
  await page.getByRole("button", { name: "导入并使用", exact: true }).click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 90_000 });

  await page.waitForFunction(async () => {
    const defaultSite = await window.tvApi.getSetting("defaultSite", "");
    const status = await window.tvApi.getCatVodStatus();
    return typeof defaultSite === "string" && defaultSite.startsWith("catvod:") && status?.state === "running";
  }, undefined, { timeout: 90_000 });

  const beforePicker = await page.evaluate(async () => ({
    defaultSite: await window.tvApi.getSetting("defaultSite", ""),
    status: await window.tvApi.getCatVodStatus(),
    sites: await window.tvApi.listSites(),
  }));
  const currentSourceName = (await page.locator(".source-picker-trigger-copy strong").textContent())?.trim() ?? "";
  const packageCopy = (await page.locator(".source-picker-trigger-copy small").textContent())?.trim() ?? "";

  await page.getByRole("button", { name: "选择播放源" }).click();
  await page.locator(".source-picker-panel").waitFor({ state: "visible", timeout: 10_000 });
  const pickerNames = await page.locator(".source-picker-item-copy strong").allTextContents();
  const catVodVisibleNames = beforePicker.sites
    .filter((site) => site.key?.startsWith("catvod:")
      && site.supported
      && site.hide !== 1
      && !["tool", "live", "comic", "audio", "discovery"].includes(site.contentType ?? ""))
    .map((site) => site.name);
  const ordinaryVisibleNames = new Set(beforePicker.sites
    .filter((site) => !site.key?.startsWith("catvod:") && site.supported && site.hide !== 1)
    .map((site) => site.name));
  const pickerContainsOrdinaryOnlyName = pickerNames.some((name) => ordinaryVisibleNames.has(name) && !catVodVisibleNames.includes(name));
  const preferredSite = beforePicker.sites.find((site) => String(site.key) === requestedSiteKey)
    ?? beforePicker.sites.find((site) => /多多4K|多多/.test(String(site.name ?? "")))
    ?? beforePicker.sites.find((site) => String(site.key).startsWith("catvod:") && site.supported && site.hide !== 1);
  let preferredSiteFlow = {
    ok: false,
    stage: "site-list",
    itemCount: 0,
    categoryCount: 0,
    sample: null,
    prepared: null,
    error: "未找到当前播放源",
  };
  if (preferredSite?.key) {
    preferredSiteFlow = await page.evaluate(async (siteKey) => {
      const pick = (list) => list?.find((item) => item?.vodTag !== "folder"
        && item?.vodTag !== "action"
        && item?.contentKind !== "folder"
        && item?.contentKind !== "action");
      let sessionId = "";
      try {
        const home = await window.tvApi.home(siteKey);
        const itemCount = Array.isArray(home?.list) ? home.list.length : 0;
        const categoryCount = Array.isArray(home?.categories) ? home.categories.length : 0;
        let sample = pick(home?.list);
        if (!sample) {
          for (const keyword of ["庆余年", "斗罗大陆", "电影"]) {
            const search = await window.tvApi.search(keyword, siteKey, "current-site", 1);
            sample = pick(search?.list ?? search);
            if (sample) break;
          }
        }
        if (!sample) return { ok: false, stage: "content", itemCount, categoryCount, sample: null, prepared: null, error: "首页和搜索均未返回可测试影片" };
        const detail = await window.tvApi.detail(siteKey, sample.vodId);
        const line = detail?.flags?.find((item) => Array.isArray(item.episodes) && item.episodes.length > 0);
        const episode = line?.episodes?.[0];
        if (!line || !episode) return { ok: false, stage: "detail", itemCount, categoryCount, sample: { vodName: detail?.vodName || sample.vodName }, prepared: null, error: "详情未返回可播放剧集" };
        const prepared = await window.tvApi.preparePlayback({
          siteKey,
          flag: line.flag,
          episodeUrl: episode.url,
          vodId: detail.vodId || sample.vodId,
          vodName: detail.vodName || sample.vodName || "测试影片",
          episodeName: episode.name || "第一集",
          playbackMode: "auto",
        });
        sessionId = prepared.sessionId;
        return {
          ok: Boolean(prepared.sessionId && prepared.playbackUrl),
          stage: "playback-ready",
          itemCount,
          categoryCount,
          sample: {
            vodName: detail.vodName || sample.vodName || "测试影片",
            episodeName: episode.name || "第一集",
            flag: line.flag,
          },
          prepared: {
            engine: prepared.engine,
            format: prepared.format,
            resolvedBy: prepared.resolvedBy,
            protocol: String(prepared.playbackUrl || "").split(":")[0] || "",
          },
          error: "",
        };
      } catch (error) {
        return {
          ok: false,
          stage: "runtime",
          itemCount: 0,
          categoryCount: 0,
          sample: null,
          prepared: null,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (sessionId) await window.tvApi.closePlayback(sessionId).catch(() => undefined);
      }
    }, preferredSite.key);
  }

  await page.screenshot({ path: path.join(artifactDirectory, "live-catvod-import.png"), fullPage: true });

  const report = {
    ok: beforePicker.defaultSite.startsWith("catvod:")
      && beforePicker.status?.state === "running"
      && beforePicker.status?.sourceMd5Url?.includes(expectedHost)
      && packageCopy.includes(expectedHost)
      && currentSourceName.length > 0
      && pickerNames.length > 0
      && !pickerContainsOrdinaryOnlyName
      && preferredSiteFlow.ok,
    sourceHost: expectedHost,
    defaultSite: beforePicker.defaultSite,
    currentSourceName,
    packageCopy,
    catVodVisibleCount: catVodVisibleNames.length,
    pickerItemCount: pickerNames.length,
    pickerContainsOrdinaryOnlyName,
    preferredSite: preferredSite ? { key: preferredSite.key, name: preferredSite.name } : null,
    preferredSiteFlow,
    screenshot: path.join(artifactDirectory, "live-catvod-import.png"),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await fs.rm(userDataDirectory, { recursive: true, force: true });
}

async function copyCurrentProfileState(databasePath, profilePath, destinationPath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await fs.writeFile(path.join(destinationPath, path.basename(databasePath)), database.serialize());
  } finally {
    database.close();
  }
  for (const entry of ["catvod-profile.key"]) {
    await fs.copyFile(path.join(profilePath, entry), path.join(destinationPath, entry)).catch(() => undefined);
  }
}

function readCurrentSourceSettings(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare("select key, value from settings where key in ('catVodMd5Url', 'defaultSite')").all();
    const values = Object.fromEntries(rows.map((row) => {
      let value = row.value;
      try { value = JSON.parse(value); } catch {}
      return [row.key, typeof value === "string" ? value : ""];
    }));
    return {
      catVodMd5Url: values.catVodMd5Url || "",
      defaultSite: values.defaultSite || "",
    };
  } finally {
    database.close();
  }
}

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE_PATH,
    "playwright",
    path.join(os.homedir(), "Desktop/code/laifu/人力助手/绩效相关/code/PerformanceWorkbench/node_modules/playwright/index.js"),
    path.join(os.homedir(), "Desktop/code/github/eigent-0.0.80/node_modules/playwright/index.js"),
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`未找到可用的 Playwright。\n${failures.join("\n")}`);
}
