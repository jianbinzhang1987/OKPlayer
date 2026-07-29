import { app, BrowserWindow, ipcMain, net, protocol, safeStorage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppService } from "../core/app-service.ts";
import { setConfigFetch } from "../core/config-loader.ts";
import { CatVodBundleManager } from "../core/catvod/catvod-bundle-manager.ts";
import { parseCatVodConfig } from "../core/catvod/catvod-config-parser.ts";
import { CatVodNodeClient } from "../core/catvod/catvod-node-client.ts";
import { CATVOD_PROTOCOL_SCHEME, resolveCatVodRuntimeUrl } from "../core/catvod/catvod-url-rewriter.ts";
import { CATVOD_SITE_PREFIX, DEFAULT_CATVOD_MD5_URL, type CatVodRemoteAccessPolicy } from "../core/catvod/catvod-types.ts";
import { MpvController } from "../core/mpv-controller.ts";
import { redactSensitiveError, redactSensitiveValue } from "../core/log-redaction.ts";
import { PlayerService } from "../core/player-service.ts";
import { SourceAdapterFactory } from "../core/source-adapter-factory.ts";
import { BrowserSnifferService } from "./browser-sniffer-service.ts";
import { CatVodAccountService, type PanProviderId } from "./catvod-account-service.ts";
import { CatVodProcessManager } from "./catvod-process-manager.ts";
import { CatVodProfileEncryptionProvider } from "./catvod-profile-encryption.ts";
import { CatVodProfileStore } from "./catvod-profile-store.ts";
import { CatVodProtocolService } from "./catvod-protocol-service.ts";
import { DesktopPlaybackService } from "./desktop-playback-service.ts";
import { MediaProtocolService, MEDIA_PROTOCOL_SCHEME } from "./media-protocol/media-protocol-service.ts";
import { PlaybackSessionStore } from "./media-protocol/playback-session-store.ts";
import { preflightNativeLibmpvAddon } from "./native-libmpv-addon.ts";
import { NativeFallbackPlaybackController, UnavailablePlaybackController } from "./native-fallback-playback-controller.ts";
import { NativeLibmpvController } from "./native-libmpv-controller.ts";
import { createDesktopPlatformRuntime, DATABASE_FILENAME, PRODUCT_NAME } from "./platform/platform-runtime.ts";
import { configureDesktopUserDataPath, migrateLegacyUserData } from "./platform/user-data-migration.ts";
import { EXTRA_CHANNELS, registerIpcHandlers } from "./register-ipc.ts";

let window: BrowserWindow | undefined;
let service: AppService | undefined;
let player: PlayerService | undefined;
let sniffer: BrowserSnifferService | undefined;
let playback: DesktopPlaybackService | undefined;
let playbackSessions: PlaybackSessionStore | undefined;
let catVodProcess: CatVodProcessManager | undefined;
let catVodClient: CatVodNodeClient | undefined;
let catVodAccountService: CatVodAccountService | undefined;
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const platformRuntime = createDesktopPlatformRuntime();
const userDataConfiguration = configureDesktopUserDataPath(app);

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  {
    scheme: CATVOD_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

export function createMainWindow() {
  const windowOptions = platformRuntime.createWindowOptions(path.join(currentDirectory, "preload.cjs"));
  if (process.env.FONGMI_RENDERER_PREVIEW === "1" && windowOptions.webPreferences) {
    delete windowOptions.webPreferences.preload;
  }
  window = new BrowserWindow(windowOptions);
  window.once("ready-to-show", () => window?.show());

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(path.join(currentDirectory, "..", "renderer", "index.html"));
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const migration = await migrateLegacyUserData(userData, userDataConfiguration.legacyPaths);
  if (migration.copiedEntries.length || migration.databaseMigrated) {
    console.info("Legacy desktop data migrated", redactSensitiveValue(migration));
  }
  setConfigFetch((input, init) => net.fetch(input instanceof URL ? input.toString() : input, init));
  const bundleManager = new CatVodBundleManager({ rootDir: path.join(userData, "catvod-node") });
  catVodProcess = new CatVodProcessManager({
    bundleManager,
    sourceMd5Url: DEFAULT_CATVOD_MD5_URL,
    bootstrapPath: path.join(currentDirectory, "catvod-bootstrap.cjs"),
  });
  catVodClient = new CatVodNodeClient({ baseUrl: () => catVodProcess?.status().baseUrl });
  service = new AppService(
    path.join(userData, DATABASE_FILENAME),
    new SourceAdapterFactory({ catVodClient }),
  );
  catVodProcess.setRemoteAccessPolicy(
    service.storage.getSetting<CatVodRemoteAccessPolicy>("catVodRemoteAccessPolicy", "allow"),
  );
  const catVodProfileStore = new CatVodProfileStore(
    service.storage,
    new CatVodProfileEncryptionProvider(safeStorage, path.join(userData, "catvod-profile.key"), {
      useNativeForNewData: process.platform !== "darwin",
      allowNativeDecrypt: process.platform !== "darwin",
      platform: process.platform,
    }),
  );
  catVodAccountService = new CatVodAccountService(
    () => catVodProcess?.status().baseUrl,
    (input, init) => net.fetch(input, init),
  );
  catVodProcess.setHostMessageHandler(async (payload) => {
    const message = asRecord(payload);
    const action = String(message.action ?? "");
    const options = asRecord(message.opt);
    switch (action) {
      case "queryProfile":
        return catVodProfileStore.load();
      case "saveProfile": {
        const profile = Object.keys(options).length ? options : asRecord(message.profile ?? message.data);
        catVodProfileStore.save(profile);
        return { ok: true };
      }
      case "toast":
        window?.webContents.send(EXTRA_CHANNELS.CATVOD_HOST_EVENT, {
          action,
          message: String(options.message ?? message.message ?? ""),
          duration: Number(options.duration ?? 5),
        });
        return { ok: true };
      case "openInternalWebview": {
        const url = String(options.url ?? message.url ?? "").trim();
        await openCatVodWebView(url);
        return { ok: true };
      }
      case "danmuPush":
        window?.webContents.send(EXTRA_CHANNELS.CATVOD_HOST_EVENT, { action, ...options });
        return { ok: true };
      default:
        window?.webContents.send(EXTRA_CHANNELS.CATVOD_HOST_EVENT, { action, ...options });
        return null;
    }
  });
  new CatVodProtocolService(() => catVodProcess?.status().baseUrl, (input, init) => net.fetch(input, init)).register(protocol);
  const nativeLibmpvPreferenceEnabled = service.storage.getSetting<boolean>("nativeLibmpvEnabled", true) !== false;
  if (!nativeLibmpvPreferenceEnabled) process.env.FONGMI_ENABLE_NATIVE_LIBMPV = "0";
  const nativeLibmpvAvailability = await preflightNativeLibmpvAddon();
  const mpvIpcController = new MpvController({
    executable: platformRuntime.getMpvExecutable(),
    ipcPath: platformRuntime.getMpvIpcEndpoint(),
    platform: platformRuntime.nodePlatform,
  });
  const playbackController = nativeLibmpvAvailability.available
    ? new NativeFallbackPlaybackController(new NativeLibmpvController(), mpvIpcController, { allowWindowFallback: false })
    : new UnavailablePlaybackController(nativeLibmpvAvailability.reason ?? "libmpv 原生内嵌插件不可用");
  player = new PlayerService(playbackController);
  sniffer = new BrowserSnifferService();
  playbackSessions = new PlaybackSessionStore();
  new MediaProtocolService(
    playbackSessions,
    (input, init) => net.fetch(input, init),
    (url) => {
      const baseUrl = catVodProcess?.status().baseUrl;
      return baseUrl ? resolveCatVodRuntimeUrl(url, baseUrl) : url;
    },
  ).register(protocol);
  playback = DesktopPlaybackService.fromAppServices(service, player, sniffer, playbackSessions);
  const syncCatVodSites = async () => {
    if (!service || !catVodClient || !catVodProcess) throw new Error("CatVod 服务尚未初始化");
    const parsed = parseCatVodConfig(await catVodClient.config());
    await service.setDynamicSites(parsed.sites);
    catVodProcess.setSiteCount(parsed.summary.siteCount);
    const status = catVodProcess.status();
    window?.webContents.send(EXTRA_CHANNELS.CATVOD_HOST_EVENT, { action: "serviceUpdated", status });
    return status;
  };
  const assertCatVodPlaybackIdle = () => {
    const activeSessions = playbackSessions?.countBySitePrefix(CATVOD_SITE_PREFIX) ?? 0;
    if (activeSessions > 0) throw new Error(`当前有 ${activeSessions} 个 CatVod 播放会话，请先关闭播放器后再操作服务`);
  };
  const catVodController = {
    status: () => catVodProcess!.status(),
    start: async (sourceMd5Url?: string, remoteAccessPolicy?: CatVodRemoteAccessPolicy) => {
      const wasRunning = catVodProcess!.status().state === "running";
      if (wasRunning) assertCatVodPlaybackIdle();
      const source = sourceMd5Url?.trim()
        || service!.storage.getSetting<string>("catVodMd5Url", DEFAULT_CATVOD_MD5_URL);
      const policy = remoteAccessPolicy === "block-startup"
        ? "block-startup"
        : remoteAccessPolicy === "allow"
          ? "allow"
          : service!.storage.getSetting<CatVodRemoteAccessPolicy>("catVodRemoteAccessPolicy", "allow");
      service!.storage.setSetting("catVodEnabled", true);
      service!.storage.setSetting("catVodMd5Url", source);
      service!.storage.setSetting("catVodRemoteAccessPolicy", policy);
      catVodProcess!.setRemoteAccessPolicy(policy);
      if (wasRunning) {
        await catVodProcess!.stop();
        await service!.clearDynamicSites();
      }
      await catVodProcess!.start(source);
      return syncCatVodSites();
    },
    stop: async () => {
      assertCatVodPlaybackIdle();
      service!.storage.setSetting("catVodEnabled", false);
      await service!.clearDynamicSites();
      return catVodProcess!.stop();
    },
    restart: async (remoteAccessPolicy?: CatVodRemoteAccessPolicy) => {
      assertCatVodPlaybackIdle();
      const policy = remoteAccessPolicy === "block-startup" ? "block-startup" : "allow";
      service!.storage.setSetting("catVodRemoteAccessPolicy", policy);
      catVodProcess!.setRemoteAccessPolicy(policy);
      await catVodProcess!.restart();
      return syncCatVodSites();
    },
    inspectUpdate: () => catVodProcess!.inspectUpdate(),
    checkForUpdate: () => catVodProcess!.checkForUpdate(),
    activateCandidate: async () => {
      assertCatVodPlaybackIdle();
      const result = await catVodProcess!.activateCandidate();
      await syncCatVodSites();
      return result;
    },
    rollback: async () => {
      assertCatVodPlaybackIdle();
      const result = await catVodProcess!.rollback();
      await syncCatVodSites();
      return result;
    },
    openWebsite: async () => {
      const baseUrl = catVodProcess!.status().baseUrl;
      if (!baseUrl) throw new Error("CatVod 服务尚未启动");
      await openCatVodWebView(`${baseUrl.replace(/\/+$/, "")}/website`);
      return { ok: true };
    },
    logPath: () => path.join(bundleManager.logsDir, "service.log"),
    panStatus: (provider = "quark" as const) => catVodAccountService!.status(provider),
    panStatuses: () => catVodAccountService!.statuses(),
    clearPanAccount: (provider: PanProviderId) => catVodAccountService!.clear(provider),
    startPanLogin: (provider = "quark" as const) => catVodAccountService!.start(provider),
    pollPanLogin: (provider: Parameters<CatVodAccountService["poll"]>[0], taskId: string) => catVodAccountService!.poll(provider, taskId),
    cancelPanLogin: (taskId: string) => catVodAccountService!.cancel(taskId),
  };
  registerIpcHandlers(ipcMain, service, player, sniffer, playback, () => ({
    name: PRODUCT_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    desktopPlatform: platformRuntime.platform,
    usesMacTrafficLights: platformRuntime.usesMacTrafficLights,
    supportsExternalIina: platformRuntime.supportsExternalIina,
    playerBackend: player?.getBackend() ?? (nativeLibmpvAvailability.available ? "native-libmpv" : "mpv-ipc"),
    nativeLibmpvPreferenceEnabled,
    nativeLibmpv: nativeLibmpvAvailability,
    arch: process.arch,
  }), catVodController);
  player.onState((state) => {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(EXTRA_CHANNELS.PLAYER_STATE, state);
  });
  await service.restoreReplacementRegistry();
  await service.restoreActiveConfig();
  createMainWindow();
  const catVodEnabled = service.storage.getSetting<boolean>("catVodEnabled", true);
  const catVodAutoStartDisabled = process.env.FONGMI_E2E_DISABLE_CATVOD === "1";
  if (catVodEnabled && !catVodAutoStartDisabled) {
    const source = service.storage.getSetting<string>("catVodMd5Url", DEFAULT_CATVOD_MD5_URL);
    void catVodController.start(source).catch((error) => {
      console.error("CatVod startup failed", redactSensitiveError(error));
      window?.webContents.send(EXTRA_CHANNELS.CATVOD_HOST_EVENT, {
        action: "serviceError",
        message: redactSensitiveError(error),
      });
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  void player?.close();
  player = undefined;
  sniffer?.close();
  sniffer = undefined;
  playback?.closeAll();
  playback = undefined;
  playbackSessions = undefined;
  // Only unfinished QR login tasks are cancelled. Persisted Cookie/Token credentials remain in the encrypted Profile.
  void catVodAccountService?.cancelAll();
  catVodAccountService = undefined;
  void catVodProcess?.stop();
  catVodProcess = undefined;
  catVodClient = undefined;
  service?.close();
  service = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function openCatVodWebView(value: string): Promise<void> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("CatVod 内部页面仅支持 HTTP/HTTPS");
  const child = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    parent: window,
    title: "CatVod 配置中心",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await child.loadURL(url.toString());
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
