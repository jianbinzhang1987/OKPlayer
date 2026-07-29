import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppService } from "../src/core/app-service.ts";
import { PlayerService } from "../src/core/player-service.ts";
import { DesktopPlaybackService } from "../src/desktop/desktop-playback-service.ts";
import { MediaProtocolService } from "../src/desktop/media-protocol/media-protocol-service.ts";
import { PlaybackSessionStore } from "../src/desktop/media-protocol/playback-session-store.ts";
import { NativeFallbackPlaybackController, UnavailablePlaybackController } from "../src/desktop/native-fallback-playback-controller.ts";
import { preflightNativeLibmpvAddon, platformResourceName } from "../src/desktop/native-libmpv-addon.ts";
import { NativeLibmpvController } from "../src/desktop/native-libmpv-controller.ts";
import type { Episode, Flag, Vod } from "../src/core/models.ts";

interface AuditEntry {
  key: string;
  name: string;
  state: string;
  reason: string;
}

interface SourceAuditReport {
  results: Array<{
    config: { name: string; url: string; enabled: boolean };
    entries: AuditEntry[];
  }>;
}

interface PlaybackAuditResult {
  key: string;
  name: string;
  auditFormat: string;
  vod?: string;
  line?: string;
  episode?: string;
  standard?: unknown;
  compatibility?: unknown;
  error?: string;
}

interface Args {
  dbPath: string;
  sourceReport: string;
  output: string;
  maxSources: number;
  compatibilityWaitMs: number;
}

function parseArgs(values: string[]): Args {
  const args: Args = {
    dbPath: path.join(os.homedir(), "Library/Application Support/FongMi Desktop/fongmi-desktop.sqlite"),
    sourceReport: path.join(process.cwd(), "artifacts/current-profile-source-e2e.json"),
    output: path.join(process.cwd(), "artifacts/recommended-playback-audit.json"),
    maxSources: Number.POSITIVE_INFINITY,
    compatibilityWaitMs: 3_500,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (value === "--db") args.dbPath = values[++index] ?? args.dbPath;
    else if (value === "--source-report") args.sourceReport = values[++index] ?? args.sourceReport;
    else if (value === "--output") args.output = values[++index] ?? args.output;
    else if (value === "--max-sources") args.maxSources = Math.max(1, Number(values[++index]) || 1);
    else if (value === "--compatibility-wait-ms") args.compatibilityWaitMs = Math.max(500, Number(values[++index]) || args.compatibilityWaitMs);
  }
  return args;
}

function configureLocalNativeRuntime(): void {
  if (process.env.FONGMI_LIBMPV_ADDON && process.env.FONGMI_LIBMPV_LIBRARY) return;
  const platform = platformResourceName();
  const addonPath = path.resolve("resources", "native", "libmpv-player", platform, "fongmi_libmpv_player.node");
  const libraryName = process.platform === "darwin"
    ? "libmpv.2.dylib"
    : process.platform === "win32"
      ? "mpv-2.dll"
      : "libmpv.so.2";
  const libraryPath = path.resolve("build", "native-runtime", "libmpv", platform, libraryName);
  const probeScript = path.resolve("dist", "main", "native-libmpv-probe.cjs");
  if (!existsSync(addonPath) || !existsSync(libraryPath) || !existsSync(probeScript)) return;
  process.env.FONGMI_ENABLE_NATIVE_LIBMPV = "1";
  process.env.FONGMI_LIBMPV_ADDON = addonPath;
  process.env.FONGMI_LIBMPV_LIBRARY = libraryPath;
  process.env.FONGMI_LIBMPV_PROBE_SCRIPT = probeScript;
}

function firstEpisode(vod: Vod): { line: Flag; episode: Episode } | undefined {
  for (const line of vod.flags ?? []) {
    for (const episode of line.episodes ?? []) {
      if (episode.url) return { line, episode };
    }
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时：${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkProtocol(service: MediaProtocolService, playbackUrl: string, format: string) {
  const response = await withTimeout(service.handle(new Request(playbackUrl, {
    headers: format === "hls" ? {} : { Range: "bytes=0-0" },
  })), 8_000, "媒体协议请求");
  const contentType = response.headers.get("content-type") || "";
  let hlsManifest: boolean | undefined;
  if (format === "hls") {
    hlsManifest = (await response.text()).slice(0, 2_000).includes("#EXTM3U");
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
  return {
    status: response.status,
    contentType,
    ok: response.ok || response.status === 206,
    ...(hlsManifest === undefined ? {} : { hlsManifest }),
  };
}

function auditFormat(reason: string): string {
  return reason.match(/（(.+?)）/)?.[1] ?? "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  configureLocalNativeRuntime();
  const report = JSON.parse(await readFile(args.sourceReport, "utf8")) as SourceAuditReport;
  const current = report.results.find((item) => item.config.enabled) ?? report.results[0];
  if (!current) throw new Error("未找到数据源端到端检测报告，请先运行 audit-current-profile-sources.ts");
  const recommended = current.entries
    .filter((item) => item.state === "healthy")
    .slice(0, args.maxSources);

  const service = new AppService(args.dbPath);
  const restored = await service.restoreActiveConfig();
  const hasRecommendedSource = () => service.listSites().some((site) => recommended.some((item) => item.key === site.key));
  if (!restored || !hasRecommendedSource()) await service.loadConfig(current.config.url, current.config.name);
  const native = await preflightNativeLibmpvAddon();
  const dummySniffer = {
    sniff: async () => { throw new Error("本次真实播放验证不使用网页嗅探"); },
    cancel() {},
  };

  const results: PlaybackAuditResult[] = [];
  for (const site of recommended) {
    console.log(`验证播放：${site.name}`);
    const item: PlaybackAuditResult = {
      key: site.key,
      name: site.name,
      auditFormat: auditFormat(site.reason),
    };
    try {
      const home = await withTimeout(service.home(site.key), 12_000, `${site.name} 首页`);
      const homeVod = home.list.find((vod) => vod.vodId && vod.contentKind !== "folder" && vod.vodTag !== "folder");
      if (!homeVod) throw new Error("首页未找到可播放候选影片");
      const detail = await withTimeout(service.detail(site.key, homeVod.vodId), 12_000, `${site.name} 详情`);
      const target = firstEpisode(detail);
      if (!target) throw new Error("详情未找到可播放剧集");
      item.vod = detail.vodName;
      item.line = target.line.flag;
      item.episode = target.episode.name;

      const standardSessions = new PlaybackSessionStore();
      const noopPlayer = { open: async () => undefined, stop: async () => undefined, getBackend: () => "noop" };
      const standardService = new DesktopPlaybackService(service, noopPlayer, dummySniffer, standardSessions);
      const standard = await withTimeout(standardService.prepare({
        siteKey: site.key,
        flag: target.line.flag,
        episodeUrl: target.episode.url,
        playbackMode: "standard",
        vodId: detail.vodId,
        vodName: detail.vodName,
        episodeName: target.episode.name,
      }), 15_000, `${site.name} 标准播放准备`);
      const protocol = new MediaProtocolService(standardSessions, (input, init) => fetch(input, {
        ...init,
        signal: AbortSignal.timeout(8_000),
      }));
      item.standard = {
        engine: standard.engine,
        format: standard.format,
        resolvedBy: standard.resolvedBy,
        protocol: await checkProtocol(protocol, standard.playbackUrl, standard.format),
      };
      standardService.close(standard.sessionId);

      if (!native.available) {
        item.compatibility = { ok: false, stage: "preflight", reason: native.reason };
      } else {
        const compatibilitySessions = new PlaybackSessionStore();
        const player = new PlayerService(new NativeFallbackPlaybackController(
          new NativeLibmpvController(),
          new UnavailablePlaybackController("已禁用窗口兜底"),
          { allowWindowFallback: false },
        ));
        const compatibilityService = new DesktopPlaybackService(service, player, dummySniffer, compatibilitySessions);
        const compatibility = await withTimeout(compatibilityService.prepare({
          siteKey: site.key,
          flag: target.line.flag,
          episodeUrl: target.episode.url,
          playbackMode: "compatibility",
          vodId: detail.vodId,
          vodName: detail.vodName,
          episodeName: target.episode.name,
        }), 15_000, `${site.name} 高兼容播放准备`);
        const started = await withTimeout(compatibilityService.fallback(compatibility.sessionId), 12_000, `${site.name} 高兼容启动`);
        await new Promise((resolve) => setTimeout(resolve, args.compatibilityWaitMs));
        const state = player.getState();
        await withTimeout(player.close(), 5_000, `${site.name} 高兼容关闭`);
        item.compatibility = {
          ok: started.status === "started" && started.backend === "native-libmpv",
          engine: compatibility.engine,
          backend: started.backend,
          state,
        };
        compatibilityService.close(compatibility.sessionId);
      }
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
    }
    results.push(item);
    console.log(JSON.stringify(item));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    config: current.config,
    native,
    total: results.length,
    standardOk: results.filter((item) => (item.standard as { protocol?: { ok?: boolean } } | undefined)?.protocol?.ok).length,
    compatibilityOk: results.filter((item) => (item.compatibility as { ok?: boolean } | undefined)?.ok).length,
    failed: results
      .filter((item) => item.error || (item.compatibility as { ok?: boolean } | undefined)?.ok === false)
      .map((item) => ({ name: item.name, error: item.error, compatibility: item.compatibility })),
  };
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, JSON.stringify({ summary, results }, null, 2));
  console.log("SUMMARY", JSON.stringify(summary, null, 2));
  console.log(`报告已写入：${args.output}`);
}

await main();
process.exit(0);
