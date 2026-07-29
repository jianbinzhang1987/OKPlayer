import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadVodConfig, parseVodConfigText } from "../src/core/config-loader.ts";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const sourceProfile = process.env.FONGMI_PROFILE_PATH
  || path.join(os.homedir(), "Library", "Application Support", "FongMi Desktop");
const sourceDatabase = path.join(sourceProfile, "fongmi-desktop.sqlite");
const auditReportPath = process.env.FONGMI_SOURCE_AUDIT_REPORT
  || path.join(root, "artifacts", "current-profile-source-e2e.json");
const requestedSite = process.env.FONGMI_PLAYBACK_SITE_KEY?.trim() || "";
const artifactSuffix = requestedSite ? `-${safeFileName(requestedSite)}` : "";
const artifactDirectory = path.join(root, "artifacts", `current-profile-live-playback-e2e${artifactSuffix}`);
const temporaryProfile = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-live-playback-profile-"));

if (!existsSync(sourceDatabase)) throw new Error(`未找到当前用户数据库：${sourceDatabase}`);
if (!existsSync(auditReportPath)) throw new Error(`未找到数据源审计报告：${auditReportPath}`);

await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });
await copyProfileDatabase(sourceDatabase, temporaryProfile);

const auditReport = JSON.parse(await fs.readFile(auditReportPath, "utf8"));
const activeAudit = auditReport.results?.find((item) => item.config?.enabled) ?? auditReport.results?.[0];
if (!activeAudit) throw new Error("数据源审计报告中没有可测试配置");
const allHealthySources = (activeAudit.entries ?? []).filter((item) => item.state === "healthy");
const healthySources = requestedSite
  ? allHealthySources.filter((item) => item.key === requestedSite || item.name === requestedSite || item.name.includes(requestedSite))
  : allHealthySources;
if (healthySources.length === 0) throw new Error(requestedSite ? `没有匹配的已验证来源：${requestedSite}` : "数据源审计报告中没有已验证可播来源");
const normalizedConfig = await loadCurrentConfig(activeAudit.config.loadedSourceUrl || activeAudit.config.url);
const configSnapshotPath = path.join(temporaryProfile, "live-playback-config.json");
await fs.writeFile(configSnapshotPath, `${JSON.stringify(normalizedConfig, null, 2)}\n`, "utf8");
const configSnapshotUrl = pathToFileURL(configSnapshotPath).toString();

const hlsAsset = (await fs.readdir(path.join(root, "dist", "renderer", "assets")))
  .find((name) => /^hls-.*\.js$/.test(name));
if (!hlsAsset) throw new Error("构建产物中未找到本地 HLS.js chunk");

const addonPath = process.env.FONGMI_NATIVE_E2E_ADDON
  || path.join(root, "native", "libmpv-player", "build", "Release", "fongmi_libmpv_player.node");
const libraryPath = process.env.FONGMI_NATIVE_E2E_LIBRARY || findLibmpvLibrary(root);
const nativeAvailable = existsSync(addonPath) && Boolean(libraryPath && existsSync(libraryPath));

const results = [];
const pageErrors = [];
const consoleErrors = [];
let app;

try {
  app = await electron.launch({
    executablePath: electronExecutable,
    args: [path.join(root, "dist", "main", "main.js"), `--user-data-dir=${temporaryProfile}`],
    cwd: root,
    timeout: 35_000,
    env: {
      ...process.env,
      FONGMI_E2E_DISABLE_CATVOD: "1",
      FONGMI_ENABLE_NATIVE_LIBMPV: nativeAvailable ? "1" : "0",
      ...(nativeAvailable ? {
        FONGMI_LIBMPV_ADDON: addonPath,
        FONGMI_LIBMPV_LIBRARY: libraryPath,
      } : {}),
    },
  });

  const page = await app.firstWindow({ timeout: 35_000 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 25_000 });
  let sites = await page.evaluate(() => window.tvApi.listSites());
  if (!Array.isArray(sites) || sites.length === 0) {
    await page.evaluate(({ url, name }) => window.tvApi.loadConfig(url, name), {
      url: configSnapshotUrl,
      name: activeAudit.config.name,
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 35_000) {
      sites = await page.evaluate(() => window.tvApi.listSites());
      if (Array.isArray(sites) && sites.length > 0) break;
      await page.waitForTimeout(500);
    }
  }
  if (!Array.isArray(sites) || sites.length === 0) throw new Error("当前配置加载后仍未返回播放源");

  const appInfo = await page.evaluate(() => window.tvApi.getInfo());
  const configs = await page.evaluate(() => window.tvApi.listConfigs());

  for (const source of healthySources) {
    const site = sites.find((item) => item.key === source.key)
      || sites.find((item) => item.name === source.name);
    if (!site) {
      results.push({
        siteKey: source.key,
        siteName: source.name,
        passed: false,
        stage: "site-list",
        error: "当前应用未加载该来源",
      });
      continue;
    }

    const startedAt = Date.now();
    let sessionId;
    let compatibilitySessionId;
    try {
      const playbackSiteKey = site.key;
      const sample = await resolveSample(page, playbackSiteKey);
      const resolvedMedia = await page.evaluate(({ siteKey, flag, episodeUrl }) => window.tvApi.resolvePlay(siteKey, flag, episodeUrl), {
        siteKey: playbackSiteKey,
        flag: sample.flag,
        episodeUrl: sample.episodeUrl,
      });
      const externalProbe = await probeResolvedMedia(resolvedMedia);
      const mpvProbe = await probeWithMpv(resolvedMedia);
      const standardPrepared = await page.evaluate((input) => window.tvApi.preparePlayback(input), {
        siteKey: playbackSiteKey,
        flag: sample.flag,
        episodeUrl: sample.episodeUrl,
        vodId: sample.vodId,
        vodName: sample.vodName,
        episodeName: sample.episodeName,
        playbackMode: "standard",
      });
      sessionId = standardPrepared.sessionId;
      const standard = await testStandardPlayback(page, standardPrepared, hlsAsset);
      await page.evaluate(async (id) => {
        document.querySelector("#live-standard-e2e-video")?.remove();
        await window.tvApi.closePlayback(id);
      }, sessionId);
      sessionId = undefined;

      const compatibilityPrepared = await page.evaluate((input) => window.tvApi.preparePlayback(input), {
        siteKey: playbackSiteKey,
        flag: sample.flag,
        episodeUrl: sample.episodeUrl,
        vodId: sample.vodId,
        vodName: sample.vodName,
        episodeName: sample.episodeName,
        playbackMode: "compatibility",
      });
      compatibilitySessionId = compatibilityPrepared.sessionId;
      const compatibility = await testCompatibilityPlayback(page, compatibilityPrepared, nativeAvailable);
      await page.screenshot({
        path: path.join(artifactDirectory, `${safeFileName(source.name)}.png`),
        fullPage: true,
      });

      const passed = standard.passed && (nativeAvailable ? compatibility.passed : compatibility.skipped === true);
      results.push({
        siteKey: playbackSiteKey,
        auditSiteKey: source.key,
        siteName: source.name,
        format: standardPrepared.format,
        resolvedBy: standardPrepared.resolvedBy,
        sample: {
          vodName: sample.vodName,
          episodeName: sample.episodeName,
          flag: sample.flag,
        },
        resolved: describeResolvedMedia(resolvedMedia),
        externalProbe,
        mpvProbe,
        standard,
        compatibility,
        passed,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      results.push({
        siteKey: source.key,
        siteName: source.name,
        passed: false,
        stage: "live-playback",
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      await page.evaluate(async ({ sessionId, compatibilitySessionId }) => {
        const hls = window.__fongmiLiveHls;
        try { hls?.destroy?.(); } catch {}
        window.__fongmiLiveHls = undefined;
        const video = document.querySelector("#live-standard-e2e-video");
        if (video instanceof HTMLVideoElement) {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
        video?.remove();
        document.querySelector("#live-native-e2e-surface")?.remove();
        await window.tvApi.detachNativePlayerView?.().catch(() => undefined);
        await window.tvApi.stop?.().catch(() => undefined);
        if (sessionId) await window.tvApi.closePlayback(sessionId).catch(() => undefined);
        if (compatibilitySessionId) await window.tvApi.closePlayback(compatibilitySessionId).catch(() => undefined);
      }, { sessionId, compatibilitySessionId }).catch(() => undefined);
    }
  }

  const summary = {
    executedAt: new Date().toISOString(),
    config: activeAudit.config,
    platform: process.platform,
    arch: process.arch,
    appInfo,
    configs,
    loadedSiteCount: sites.length,
    nativeRuntime: {
      available: nativeAvailable,
      addonPath: nativeAvailable ? addonPath : null,
      libraryPath: nativeAvailable ? libraryPath : null,
    },
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    standardPassed: results.filter((item) => item.standard?.passed).length,
    compatibilityPassed: results.filter((item) => item.compatibility?.passed).length,
    consoleErrors: summarizeMessages(consoleErrors),
    pageErrors: summarizeMessages(pageErrors),
    results,
  };

  await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(summary), "utf8");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0 || pageErrors.length > 0) process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await fs.rm(temporaryProfile, { recursive: true, force: true }).catch(() => undefined);
}

async function resolveSample(page, siteKey) {
  return page.evaluate(async ({ siteKey }) => {
    const pick = (list) => list?.find((item) => item?.vodTag !== "folder" && item?.vodTag !== "action" && item?.contentKind !== "folder" && item?.contentKind !== "action");
    let sample;
    const failures = [];
    try {
      const home = await window.tvApi.home(siteKey);
      sample = pick(home?.list);
      if (!sample) failures.push("首页未返回可播放条目");
    } catch (error) {
      failures.push(`首页失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!sample) {
      for (const keyword of ["庆余年", "斗罗大陆", "电影"]) {
        try {
          const search = await window.tvApi.search(keyword, siteKey, "current-site", 1);
          sample = pick(search?.list ?? search);
          if (sample) break;
        } catch (error) {
          failures.push(`搜索失败：${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      }
    }
    if (!sample) throw new Error(failures.join("；") || "未取得可测试影片");

    const detail = await window.tvApi.detail(siteKey, sample.vodId);
    const line = detail?.flags?.find((item) => Array.isArray(item.episodes) && item.episodes.length > 0);
    const episode = line?.episodes?.[0];
    if (!line || !episode) throw new Error("详情未返回可播放剧集");
    return {
      vodId: detail.vodId || sample.vodId,
      vodName: detail.vodName || sample.vodName || "测试影片",
      flag: line.flag,
      episodeUrl: episode.url,
      episodeName: episode.name || "第一集",
    };
  }, { siteKey });
}

async function testStandardPlayback(page, prepared, hlsAsset) {
  return page.evaluate(async ({ prepared, hlsAsset }) => {
    const video = document.createElement("video");
    video.id = "live-standard-e2e-video";
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.controls = true;
    Object.assign(video.style, {
      position: "fixed",
      left: "110px",
      top: "90px",
      width: "640px",
      height: "360px",
      background: "#000",
      zIndex: "9999",
    });
    document.body.append(video);

    const errors = [];
    video.addEventListener("error", () => errors.push(video.error?.message || `media-error-${video.error?.code ?? 0}`));
    let hls;
    try {
      if (prepared.engine !== "web") {
        return {
          passed: false,
          engine: prepared.engine,
          format: prepared.format,
          error: "标准模式未路由到应用内 Web 播放器",
        };
      }
      if (prepared.format === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
        const module = await import(new URL(`./assets/${hlsAsset}`, window.location.href).href);
        const Hls = module.default;
        if (!Hls?.isSupported?.()) throw new Error("本地 HLS.js 在当前 Electron 环境不可用");
        hls = new Hls({ enableWorker: false, lowLatencyMode: false });
        window.__fongmiLiveHls = hls;
        hls.attachMedia(video);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("HLS 清单加载超时")), 15_000);
          hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(prepared.playbackUrl));
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            clearTimeout(timer);
            resolve();
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data?.fatal) return;
            clearTimeout(timer);
            reject(new Error(`HLS.js ${data.type || "error"}: ${data.details || "fatal"}`));
          });
        });
      } else {
        video.src = prepared.playbackUrl;
      }
      await video.play().catch(() => undefined);
      const startedAt = Date.now();
      while (Date.now() - startedAt < 25_000) {
        if (video.readyState >= 2 && video.currentTime > 0.2 && !video.paused) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return {
        passed: video.readyState >= 2 && video.currentTime > 0.2 && !video.paused && errors.length === 0,
        engine: prepared.engine,
        format: prepared.format,
        readyState: video.readyState,
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        errors,
      };
    } catch (error) {
      return {
        passed: false,
        engine: prepared.engine,
        format: prepared.format,
        readyState: video.readyState,
        currentTime: video.currentTime,
        paused: video.paused,
        errors,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, { prepared, hlsAsset });
}

async function testCompatibilityPlayback(page, prepared, nativeAvailable) {
  if (!nativeAvailable) {
    return { passed: false, skipped: true, reason: "当前机器未发现可用 native-libmpv 运行时" };
  }
  return page.evaluate(async ({ prepared }) => {
    const surface = document.createElement("div");
    surface.id = "live-native-e2e-surface";
    Object.assign(surface.style, {
      position: "fixed",
      left: "110px",
      top: "90px",
      width: "640px",
      height: "360px",
      background: "#000",
      zIndex: "9999",
    });
    document.body.append(surface);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bounds = surface.getBoundingClientRect();
    const rect = {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    const states = [];
    const remove = window.tvApi.onPlayerState?.((state) => states.push(state));
    try {
      const attach = await window.tvApi.attachNativePlayerView(rect);
      if (attach?.ok !== true) {
        return { passed: false, attach, states: states.slice(-5), error: attach?.message || "原生视图挂载失败" };
      }
      const open = await window.tvApi.fallbackPlayback(prepared.sessionId);
      const startedAt = Date.now();
      while (Date.now() - startedAt < 25_000) {
        const latest = states.at(-1);
        if (Number(latest?.position ?? 0) > 0.2 && latest?.stopped !== true) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const latest = states.at(-1);
      if (Number(latest?.position ?? 0) > 0.2) {
        await window.tvApi.pause?.();
        await window.tvApi.play?.();
        await window.tvApi.seek?.(Math.min(1, Number(latest?.duration ?? 1)));
      }
      return {
        passed: attach?.ok === true
          && attach?.backend === "native-libmpv"
          && open?.backend === "native-libmpv"
          && Number(latest?.position ?? 0) > 0.2
          && latest?.stopped !== true,
        attach,
        open,
        stateCount: states.length,
        lastState: latest,
      };
    } catch (error) {
      return {
        passed: false,
        stateCount: states.length,
        lastState: states.at(-1),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      remove?.();
    }
  }, { prepared });
}

async function copyProfileDatabase(sourceDatabasePath, destinationProfile) {
  const database = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  try {
    const snapshot = database.serialize();
    await fs.writeFile(path.join(destinationProfile, path.basename(sourceDatabasePath)), snapshot);
  } finally {
    database.close();
  }
}

async function loadCurrentConfig(sourceUrl) {
  try {
    return await loadVodConfig(sourceUrl);
  } catch (primaryError) {
    if (!/^https?:\/\//i.test(sourceUrl)) throw primaryError;
    try {
      const { stdout } = await execFile("curl", [
        "-L",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time", "30",
        "--retry", "2",
        "--retry-delay", "1",
        sourceUrl,
      ], { timeout: 40_000, maxBuffer: 16 * 1024 * 1024 });
      return parseVodConfigText(stdout, sourceUrl);
    } catch (curlError) {
      throw new Error(`当前配置下载失败：${primaryError instanceof Error ? primaryError.message : String(primaryError)}；curl 备用下载也失败：${curlError instanceof Error ? curlError.message : String(curlError)}`);
    }
  }
}

async function probeResolvedMedia(media) {
  if (!media?.url) return { passed: false, error: "播放解析未返回地址" };
  const headerLines = Object.entries(media.headers ?? {})
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("");
  const args = [
    "-v", "error",
    "-rw_timeout", "12000000",
    ...(headerLines ? ["-headers", headerLines] : []),
    "-show_entries", "format=duration,format_name",
    "-of", "json",
    media.url,
  ];
  try {
    const { stdout, stderr } = await execFile(process.env.FFPROBE_PATH || "ffprobe", args, {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout || "{}");
    return {
      passed: Boolean(payload?.format?.format_name),
      formatName: payload?.format?.format_name ?? "",
      duration: Number(payload?.format?.duration ?? 0),
      warning: String(stderr || "").trim(),
    };
  } catch (error) {
    return {
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: typeof error === "object" && error && "stderr" in error ? String(error.stderr || "").trim() : "",
    };
  }
}

async function probeWithMpv(media) {
  if (!media?.url) return { passed: false, error: "播放解析未返回地址" };
  const normalizedHeaders = Object.fromEntries(Object.entries(media.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const userAgent = String(normalizedHeaders["user-agent"] ?? "Mozilla/5.0");
  const referrer = String(normalizedHeaders.referer ?? normalizedHeaders.referrer ?? "");
  const headerFields = Object.entries(media.headers ?? {})
    .filter(([key, value]) => !["user-agent", "referer", "referrer"].includes(key.toLowerCase()) && typeof value === "string" && value.length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join(",");
  const args = [
    "--no-config",
    "--vo=null",
    "--ao=null",
    "--frames=1",
    "--idle=no",
    "--terminal=yes",
    "--msg-level=all=warn",
    `--user-agent=${userAgent}`,
    ...(referrer ? [`--referrer=${referrer}`] : []),
    ...(headerFields ? [`--http-header-fields=${headerFields}`] : []),
    media.url,
  ];
  try {
    const { stdout, stderr } = await execFile(process.env.MPV_PATH || "mpv", args, {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      passed: true,
      stdout: String(stdout || "").trim().slice(-1200),
      stderr: String(stderr || "").trim().slice(-1200),
    };
  } catch (error) {
    return {
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      stdout: typeof error === "object" && error && "stdout" in error ? String(error.stdout || "").trim().slice(-1200) : "",
      stderr: typeof error === "object" && error && "stderr" in error ? String(error.stderr || "").trim().slice(-1200) : "",
    };
  }
}

function describeResolvedMedia(media) {
  let parsed;
  try { parsed = new URL(media?.url || ""); } catch {}
  return {
    format: media?.format,
    resolvedBy: media?.resolvedBy,
    protocol: parsed?.protocol ?? "",
    host: parsed?.host ?? "",
    pathTail: parsed?.pathname?.split("/").filter(Boolean).at(-1)?.slice(-120) ?? "",
    queryKeys: parsed ? [...parsed.searchParams.keys()].slice(0, 20) : [],
    headerKeys: Object.keys(media?.headers ?? {}).sort(),
  };
}

function findLibmpvLibrary(projectRoot) {
  const candidates = process.platform === "darwin"
    ? [
      "/usr/local/lib/libmpv.2.dylib",
      "/opt/homebrew/lib/libmpv.2.dylib",
      "/Applications/IINA.app/Contents/Frameworks/libmpv.2.dylib",
      path.join(projectRoot, "release", "mac", "FongMi Desktop.app", "Contents", "Resources", "libmpv", "darwin-x64", "libmpv.2.dylib"),
    ]
    : process.platform === "win32"
      ? [path.join(projectRoot, "resources", "libmpv", "win32-x64", "mpv-2.dll")]
      : ["/usr/lib/x86_64-linux-gnu/libmpv.so.2", "/usr/local/lib/libmpv.so.2"];
  return candidates.find((candidate) => existsSync(candidate));
}

function summarizeMessages(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([message, count]) => ({ message, count }));
}

function safeFileName(value) {
  return String(value || "source").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 80);
}

function renderMarkdown(report) {
  const rows = report.results.map((item) => {
    const standard = item.standard?.passed ? "通过" : item.standard ? `失败：${item.standard.error || item.standard.errors?.join("；") || "未起播"}` : "未执行";
    const compatibility = item.compatibility?.passed ? "通过" : item.compatibility?.skipped ? `跳过：${item.compatibility.reason}` : item.compatibility ? `失败：${item.compatibility.error || "未起播"}` : "未执行";
    return `| ${item.siteName} | ${item.format ?? "-"} | ${standard.replace(/\|/g, "\\|")} | ${compatibility.replace(/\|/g, "\\|")} | ${item.passed ? "通过" : "失败"} |`;
  });
  return `# 当前数据源真实播放端到端测试\n\n- 时间：${report.executedAt}\n- 配置：${report.config?.name ?? "-"}\n- 平台：${report.platform}/${report.arch}\n- 测试来源：${report.total}\n- 标准播放器通过：${report.standardPassed}\n- 高兼容播放器通过：${report.compatibilityPassed}\n- 总体通过：${report.passed}\n- 总体失败：${report.failed}\n- native-libmpv：${report.nativeRuntime.available ? "可用" : "不可用"}\n\n| 来源 | 格式 | 标准播放器 | 高兼容播放器 | 总体 |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
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
