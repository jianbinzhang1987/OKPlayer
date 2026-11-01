import { BrowserWindow, type IpcMain } from "electron";
import type { AppService, SearchTargetSelection } from "../core/app-service.ts";
import type { CatVodRemoteAccessPolicy } from "../core/catvod/catvod-types.ts";
import { redactSensitiveText } from "../core/log-redaction.ts";
import type { PlayerService } from "../core/player-service.ts";
import type { BrowserSnifferService } from "./browser-sniffer-service.ts";
import type { PanLoginProviderId, PanLoginResult, PanProviderId, PanProviderStatus } from "./catvod-account-service.ts";
import type { DesktopPlaybackService, PreparePlaybackInput } from "./desktop-playback-service.ts";
import { isCatVodProtectedSettingKey } from "./catvod-profile-store.ts";
import { serializePlaybackFailure } from "./playback-error.ts";
import { IPC_CHANNELS, validateKeyword } from "./ipc-service.ts";

export const EXTRA_CHANNELS = {
  CONFIG_LOAD: "config:load",
  CONFIG_LOAD_LIVE: "config:load-live",
  CONFIG_RENAME: "config:rename",
  CONFIG_DELETE: "config:delete",
  REPLACEMENT_REGISTRY_GET: "replacement-registry:get",
  REPLACEMENT_REGISTRY_LOAD: "replacement-registry:load",
  REPLACEMENT_REGISTRY_CLEAR: "replacement-registry:clear",
  SITE_LIST: "site:list",
  SITE_HEALTH: "site:health",
  SITE_AUDIT_START: "site:audit:start",
  SITE_AUDIT_STATUS: "site:audit:status",
  HOME: "vod:home",
  HOME_BEST: "vod:home-best",
  CATEGORY: "vod:category",
  SEARCH_DETAILED: "search:detailed",
  SEARCH_INCREMENTAL_START: "search:incremental:start",
  SEARCH_INCREMENTAL_CANCEL: "search:incremental:cancel",
  SEARCH_INCREMENTAL_EVENT: "search:incremental:event",
  HISTORY_LIST: "history:list",
  HISTORY_SAVE: "history:save",
  HISTORY_REMOVE: "history:remove",
  HISTORY_CLEAR: "history:clear",
  FAVORITE_LIST: "favorite:list",
  FAVORITE_SAVE: "favorite:save",
  FAVORITE_REMOVE: "favorite:remove",
  LIVE_SOURCE_LIST: "live:source:list",
  LIVE_SOURCE_LOAD: "live:source:load",
  LIVE_SOURCE_LOAD_ALL: "live:source:load-all",
  LIVE_EPG_GUIDE: "live:epg:guide",
  LIVE_EPG_MAPPING_SAVE: "live:epg:mapping:save",
  LIVE_EPG_MAPPING_REMOVE: "live:epg:mapping:remove",
  LIVE_CHANNEL_SEARCH: "live:channel:search",
  LIVE_CHANNEL_INSPECT: "live:channel:inspect",
  LIVE_LINE_FEEDBACK: "live:line:feedback",
  LIVE_CATCHUP_RESOLVE: "live:catchup:resolve",
  LIVE_FAVORITE_LIST: "live:favorite:list",
  LIVE_FAVORITE_SAVE: "live:favorite:save",
  LIVE_FAVORITE_REMOVE: "live:favorite:remove",
  LIVE_RECENT_LIST: "live:recent:list",
  LIVE_RECENT_SAVE: "live:recent:save",
  LIVE_CATCHUP_HISTORY_GET: "live:catchup-history:get",
  LIVE_CATCHUP_HISTORY_SAVE: "live:catchup-history:save",
  LIVE_CATCHUP_HISTORY_REMOVE: "live:catchup-history:remove",
  SETTING_GET: "setting:get",
  SETTING_SET: "setting:set",
  PLAYER_OPEN: "player:open",
  PLAYER_PLAY: "player:play",
  PLAYER_PAUSE: "player:pause",
  PLAYER_SEEK: "player:seek",
  PLAYER_SPEED: "player:speed",
  PLAYER_VOLUME: "player:volume",
  PLAYER_MUTE: "player:mute",
  PLAYER_STOP: "player:stop",
  PLAYER_SET_SUBTITLE_TRACK: "player:subtitle:track",
  PLAYER_SET_SUBTITLE_DELAY: "player:subtitle:delay",
  PLAYER_SET_SUBTITLE_VISIBILITY: "player:subtitle:visibility",
  PLAYER_ADD_SUBTITLE: "player:subtitle:add",
  PLAYER_SET_AUDIO_TRACK: "player:audio:track",
  PLAYER_SET_ASPECT_RATIO: "player:aspect-ratio",
  PLAYER_NATIVE_ATTACH: "player:native-view:attach",
  PLAYER_NATIVE_RESIZE: "player:native-view:resize",
  PLAYER_NATIVE_DETACH: "player:native-view:detach",
  WINDOW_FULLSCREEN_GET: "window:fullscreen:get",
  WINDOW_FULLSCREEN_SET: "window:fullscreen:set",
  WINDOW_ALWAYS_ON_TOP_GET: "window:always-on-top:get",
  WINDOW_ALWAYS_ON_TOP_SET: "window:always-on-top:set",
  WINDOW_MINI_MODE_GET: "window:mini-mode:get",
  WINDOW_MINI_MODE_SET: "window:mini-mode:set",
  PLAYER_STATE: "player:state",
  PLAYBACK_PREPARE: "playback:prepare",
  PLAYBACK_CLOSE: "playback:close",
  PLAYBACK_FALLBACK: "playback:fallback",
  PLAYBACK_EXTERNAL: "playback:external",
  PLAYBACK_CANCEL: "playback:cancel",
  SNIFFER_RESOLVE: "sniffer:resolve",
  SNIFFER_CANCEL: "sniffer:cancel",
  CATVOD_STATUS: "catvod:status",
  CATVOD_START: "catvod:start",
  CATVOD_STOP: "catvod:stop",
  CATVOD_RESTART: "catvod:restart",
  CATVOD_UPDATE_INSPECT: "catvod:update:inspect",
  CATVOD_UPDATE_CHECK: "catvod:update:check",
  CATVOD_UPDATE_ACTIVATE: "catvod:update:activate",
  CATVOD_ROLLBACK: "catvod:rollback",
  CATVOD_OPEN_WEBSITE: "catvod:open-website",
  CATVOD_LOG_PATH: "catvod:log-path",
  CATVOD_HOST_EVENT: "catvod:host-event",
  PAN_STATUS: "pan:status",
  PAN_STATUS_ALL: "pan:status:all",
  PAN_CLEAR: "pan:clear",
  PAN_LOGIN_START: "pan:login:start",
  PAN_LOGIN_POLL: "pan:login:poll",
  PAN_LOGIN_CANCEL: "pan:login:cancel",
} as const;

export interface CatVodIpcController {
  status(): unknown;
  start(sourceMd5Url?: string, remoteAccessPolicy?: CatVodRemoteAccessPolicy): Promise<unknown>;
  stop(): Promise<unknown>;
  restart(remoteAccessPolicy?: CatVodRemoteAccessPolicy): Promise<unknown>;
  inspectUpdate(): Promise<unknown>;
  checkForUpdate(): Promise<unknown>;
  activateCandidate(): Promise<unknown>;
  rollback(): Promise<unknown>;
  openWebsite(): Promise<unknown>;
  logPath(): string;
  panStatus(provider?: PanProviderId): Promise<PanProviderStatus>;
  panStatuses(): Promise<PanProviderStatus[]>;
  clearPanAccount(provider: PanProviderId): Promise<PanProviderStatus>;
  startPanLogin(provider?: PanLoginProviderId): Promise<PanLoginResult>;
  pollPanLogin(provider: PanLoginProviderId, taskId: string): Promise<PanLoginResult>;
  cancelPanLogin(taskId: string): Promise<PanLoginResult>;
}

function validateNativePlayerRect(value: unknown) {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (field: string, minimum: number) => Math.max(minimum, Math.round(Number(input[field]) || 0));
  return {
    x: number("x", 0),
    y: number("y", 0),
    width: number("width", 1),
    height: number("height", 1),
  };
}

function nativeHandleToBigInt(handle: Buffer): bigint {
  if (handle.length >= 8) return handle.readBigUInt64LE(0);
  if (handle.length >= 4) return BigInt(handle.readUInt32LE(0));
  let result = 0n;
  for (let index = 0; index < handle.length; index += 1) result |= BigInt(handle[index] ?? 0) << BigInt(index * 8);
  return result;
}

function validatePage(value: unknown): number {
  const page = Math.floor(Number(value) || 1);
  return Math.min(10_000, Math.max(1, page));
}

export function registerIpcHandlers(
  ipcMain: Pick<IpcMain, "handle" | "on">,
  service: AppService,
  player: PlayerService,
  sniffer: BrowserSnifferService,
  playback: DesktopPlaybackService,
  appInfo: () => {
    name: string;
    version: string;
    electron: string;
    chrome: string;
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    nativeLibmpv?: unknown;
  },
  catVod?: CatVodIpcController,
) {
  let activeIncrementalSearchRequestId = "";

  ipcMain.handle(IPC_CHANNELS.APP_INFO, () => appInfo());
  ipcMain.handle(IPC_CHANNELS.CONFIG_LIST, () => service.listConfigs());
  ipcMain.handle(EXTRA_CHANNELS.CONFIG_LOAD, (_event, source: string, name?: string) => service.loadConfig(source, name));
  ipcMain.handle(EXTRA_CHANNELS.CONFIG_LOAD_LIVE, (_event, source: string, name?: string) => service.loadLiveConfig(source, name));
  ipcMain.handle(EXTRA_CHANNELS.CONFIG_RENAME, (_event, source: string, name: string) => service.renameConfig(source, name));
  ipcMain.handle(EXTRA_CHANNELS.CONFIG_DELETE, (_event, source: string) => service.deleteConfig(source));
  ipcMain.handle(EXTRA_CHANNELS.REPLACEMENT_REGISTRY_GET, () => service.getReplacementRegistryStatus());
  ipcMain.handle(EXTRA_CHANNELS.REPLACEMENT_REGISTRY_LOAD, (_event, source: string) => service.loadReplacementRegistry(source));
  ipcMain.handle(EXTRA_CHANNELS.REPLACEMENT_REGISTRY_CLEAR, () => service.clearReplacementRegistry());
  ipcMain.handle(EXTRA_CHANNELS.SITE_LIST, () => service.listSites());
  ipcMain.handle(EXTRA_CHANNELS.SITE_HEALTH, (_event, siteKey: string) => service.health(siteKey));
  ipcMain.handle(EXTRA_CHANNELS.SITE_AUDIT_START, (_event, force?: boolean) => service.startSourceAudit(Boolean(force)));
  ipcMain.handle(EXTRA_CHANNELS.SITE_AUDIT_STATUS, () => service.getSourceAuditStatus());
  ipcMain.handle(EXTRA_CHANNELS.HOME, (_event, siteKey: string) => service.home(siteKey));
  ipcMain.handle(EXTRA_CHANNELS.HOME_BEST, (_event, preferredSiteKey?: string) => service.bestHome(preferredSiteKey));
  ipcMain.handle(EXTRA_CHANNELS.CATEGORY, (_event, siteKey: string, tid: string, page?: string, extend?: Record<string, string>) => service.category(siteKey, tid, page, extend));
  ipcMain.handle(IPC_CHANNELS.SEARCH, (_event, keyword: string, siteKey?: string, scope?: "all-configs" | "current-site", page?: number, selection?: SearchTargetSelection) => service.search(validateKeyword(keyword), siteKey, scope, validatePage(page), validateSearchSelection(selection)));
  ipcMain.handle(EXTRA_CHANNELS.SEARCH_DETAILED, (_event, keyword: string, siteKey?: string, scope?: "all-configs" | "current-site", page?: number, selection?: SearchTargetSelection) => service.searchDetailed(validateKeyword(keyword), siteKey, scope, validatePage(page), validateSearchSelection(selection)));
  ipcMain.on(EXTRA_CHANNELS.SEARCH_INCREMENTAL_START, (event, requestId: string, keyword: string, siteKey?: string, scope?: "all-configs" | "current-site", page?: number, selection?: SearchTargetSelection) => {
    const normalizedRequestId = String(requestId ?? "").trim();
    if (!normalizedRequestId) return;
    activeIncrementalSearchRequestId = normalizedRequestId;
    const send = (payload: Record<string, unknown>) => {
      if (activeIncrementalSearchRequestId !== normalizedRequestId || event.sender.isDestroyed()) return;
      event.sender.send(EXTRA_CHANNELS.SEARCH_INCREMENTAL_EVENT, { requestId: normalizedRequestId, ...payload });
    };
    void service.searchDetailedIncremental(
      validateKeyword(keyword),
      siteKey,
      scope,
      validatePage(page),
      (payload) => send(payload as unknown as Record<string, unknown>),
      validateSearchSelection(selection),
    ).catch((error) => {
      send({
        type: "error",
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      });
    }).finally(() => {
      if (activeIncrementalSearchRequestId === normalizedRequestId) activeIncrementalSearchRequestId = "";
    });
  });
  ipcMain.on(EXTRA_CHANNELS.SEARCH_INCREMENTAL_CANCEL, (_event, requestId: string) => {
    if (activeIncrementalSearchRequestId !== String(requestId ?? "").trim()) return;
    service.cancelSearch();
    activeIncrementalSearchRequestId = "";
  });
  ipcMain.handle(IPC_CHANNELS.DETAIL, (_event, siteKey: string, vodId: string) => service.detail(siteKey, vodId));
  ipcMain.handle(IPC_CHANNELS.RESOLVE, (_event, siteKey: string, flag: string, episodeUrl: string) => service.resolve(siteKey, flag, episodeUrl));
  ipcMain.handle(EXTRA_CHANNELS.HISTORY_LIST, () => service.storage.listHistory());
  ipcMain.handle(EXTRA_CHANNELS.HISTORY_SAVE, (_event, record) => service.storage.saveHistory(record));
  ipcMain.handle(EXTRA_CHANNELS.HISTORY_REMOVE, (_event, siteKey: string, vodId: string, episodeName: string) => service.storage.removeHistory(siteKey, vodId, episodeName));
  ipcMain.handle(EXTRA_CHANNELS.HISTORY_CLEAR, () => service.storage.clearHistory());
  ipcMain.handle(EXTRA_CHANNELS.FAVORITE_LIST, () => service.storage.listFavorites());
  ipcMain.handle(EXTRA_CHANNELS.FAVORITE_SAVE, (_event, record) => service.storage.saveFavorite(record));
  ipcMain.handle(EXTRA_CHANNELS.FAVORITE_REMOVE, (_event, siteKey: string, vodId: string) => service.storage.removeFavorite(siteKey, vodId));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_SOURCE_LIST, () => service.listLiveSources());
  ipcMain.handle(EXTRA_CHANNELS.LIVE_SOURCE_LOAD, (_event, sourceId: string, force?: boolean) => service.loadLiveSource(validateLiveId(sourceId, "直播源"), Boolean(force)));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_SOURCE_LOAD_ALL, (_event, force?: boolean) => service.loadLiveSources(Boolean(force)));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_EPG_GUIDE, (_event, sourceId: string, force?: boolean) => service.loadLiveEpgGuide(
    validateLiveId(sourceId, "直播源"),
    Boolean(force),
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_EPG_MAPPING_SAVE, (_event, sourceId: string, liveChannelId: string, epgChannelId: string, epgChannelName?: string) => service.saveLiveEpgMapping(
    validateLiveId(sourceId, "直播源"),
    validateLiveId(liveChannelId, "直播频道"),
    validateEpgChannelId(epgChannelId),
    String(epgChannelName ?? "").trim().slice(0, 200) || undefined,
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_EPG_MAPPING_REMOVE, (_event, sourceId: string, liveChannelId: string) => service.removeLiveEpgMapping(
    validateLiveId(sourceId, "直播源"),
    validateLiveId(liveChannelId, "直播频道"),
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_CHANNEL_SEARCH, (_event, sourceId: string, query?: string, groupId?: string) => service.searchLiveChannels(
    validateLiveId(sourceId, "直播源"),
    String(query ?? "").trim().slice(0, 100),
    groupId ? validateLiveId(groupId, "直播分组") : undefined,
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_CHANNEL_INSPECT, (_event, sourceId: string, channelId: string, force?: boolean, lineId?: string) => service.inspectLiveChannel(
    validateLiveId(sourceId, "直播源"),
    validateLiveId(channelId, "直播频道"),
    Boolean(force),
    lineId ? validateLiveId(lineId, "直播线路") : undefined,
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_LINE_FEEDBACK, (_event, feedback: unknown) => service.recordLivePlaybackFeedback(
    validateLivePlaybackFeedback(feedback),
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_CATCHUP_RESOLVE, (_event, sourceId: string, channelId: string, programme: unknown, lineId?: string) => service.resolveLiveCatchup(
    validateLiveId(sourceId, "直播源"),
    validateLiveId(channelId, "直播频道"),
    validateEpgProgramme(programme),
    lineId ? validateLiveId(lineId, "直播线路") : undefined,
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_FAVORITE_LIST, () => service.storage.listLiveFavorites());
  ipcMain.handle(EXTRA_CHANNELS.LIVE_FAVORITE_SAVE, (_event, record) => service.storage.saveLiveFavorite(validateLiveFavorite(record)));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_FAVORITE_REMOVE, (_event, sourceId: string, channelId: string) => service.storage.removeLiveFavorite(
    validateLiveId(sourceId, "直播源"),
    validateLiveId(channelId, "直播频道"),
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_RECENT_LIST, (_event, limit?: number) => service.storage.listLiveRecent(limit));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_RECENT_SAVE, (_event, record) => service.storage.saveLiveRecent(validateLiveRecent(record)));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_CATCHUP_HISTORY_GET, (_event, sourceId: string, channelId: string, programmeStartAt: number) => service.storage.getLiveCatchupHistory(
    validateLiveId(sourceId, "直播源"),
    validateLiveId(channelId, "直播频道"),
    validateProgrammeTimestamp(programmeStartAt, "节目开始时间"),
  ));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_CATCHUP_HISTORY_SAVE, (_event, record) => service.storage.saveLiveCatchupHistory(validateLiveCatchupHistory(record)));
  ipcMain.handle(EXTRA_CHANNELS.LIVE_CATCHUP_HISTORY_REMOVE, (_event, sourceId: string, channelId: string, programmeStartAt: number) => service.storage.removeLiveCatchupHistory(
    validateLiveId(sourceId, "直播源"),
    validateLiveId(channelId, "直播频道"),
    validateProgrammeTimestamp(programmeStartAt, "节目开始时间"),
  ));
  ipcMain.handle(EXTRA_CHANNELS.SETTING_GET, (_event, key: string, fallback: unknown) => {
    assertRendererSettingKey(key);
    return service.storage.getSetting(key, fallback);
  });
  ipcMain.handle(EXTRA_CHANNELS.SETTING_SET, (_event, key: string, value: unknown) => {
    assertRendererSettingKey(key);
    return service.storage.setSetting(key, value);
  });
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_OPEN, (_event, url: string, headers?: Record<string, string>) => player.open(url, headers));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_PLAY, () => player.play());
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_PAUSE, () => player.pause());
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_SEEK, (_event, seconds: number) => player.seek(seconds));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_SPEED, (_event, speed: number) => player.setSpeed(speed));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_VOLUME, (_event, volume: number) => player.setVolume(volume));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_MUTE, (_event, muted: boolean) => player.setMuted(muted));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_STOP, () => player.stop());
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_SET_SUBTITLE_TRACK, (_event, track: number | string) => player.setSubtitleTrack(track));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_SET_SUBTITLE_DELAY, (_event, seconds: number) => player.setSubtitleDelay(seconds));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_SET_SUBTITLE_VISIBILITY, (_event, visible: boolean) => player.setSubtitleVisibility(visible));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_ADD_SUBTITLE, (_event, url: string) => player.addSubtitle(url));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_SET_AUDIO_TRACK, (_event, track: number | string) => player.setAudioTrack(track));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_SET_ASPECT_RATIO, (_event, ratio: string) => player.setAspectRatio(ratio));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_NATIVE_ATTACH, async (event, rect: unknown) => {
    if (player.getBackend() !== "native-libmpv") {
      return { ok: false, backend: player.getBackend(), message: "当前使用 MPV IPC 高兼容后端" };
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error("无法获取播放器所属窗口");
    const nativeHandle = nativeHandleToBigInt(ownerWindow.getNativeWindowHandle());
    const result = await player.attachNativeView(nativeHandle, validateNativePlayerRect(rect)) as { ok?: boolean; message?: string; fallback?: boolean } | undefined;
    return {
      ok: result?.ok !== false,
      backend: player.getBackend(),
      message: result?.message ?? "原生视频视图已挂载",
      ...(result?.fallback ? { fallback: true } : {}),
    };
  });
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_NATIVE_RESIZE, (_event, rect: unknown) => player.resizeNativeView(validateNativePlayerRect(rect)));
  ipcMain.handle(EXTRA_CHANNELS.PLAYER_NATIVE_DETACH, () => player.detachNativeView());
  ipcMain.handle(EXTRA_CHANNELS.WINDOW_FULLSCREEN_GET, (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    return Boolean(ownerWindow && !ownerWindow.isDestroyed() && ownerWindow.isFullScreen());
  });
  ipcMain.handle(EXTRA_CHANNELS.WINDOW_FULLSCREEN_SET, async (event, enabled: unknown) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error("无法获取播放器所属窗口");
    const target = Boolean(enabled);
    if (ownerWindow.isFullScreen() === target) return target;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ownerWindow.isFullScreen());
      };
      const timer = setTimeout(finish, 5_000);
      if (target) ownerWindow.once("enter-full-screen", finish);
      else ownerWindow.once("leave-full-screen", finish);
      ownerWindow.setFullScreen(target);
    });
  });
  let wasAlwaysOnTopBeforeMini = false;
  let miniModeActive = false;
  ipcMain.handle(EXTRA_CHANNELS.WINDOW_ALWAYS_ON_TOP_GET, (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    return Boolean(ownerWindow && !ownerWindow.isDestroyed() && ownerWindow.isAlwaysOnTop());
  });
  ipcMain.handle(EXTRA_CHANNELS.WINDOW_ALWAYS_ON_TOP_SET, (event, enabled: unknown) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error("无法获取播放器所属窗口");
    const target = Boolean(enabled);
    ownerWindow.setAlwaysOnTop(target, "floating");
    if (!miniModeActive) {
      wasAlwaysOnTopBeforeMini = target;
    }
    return ownerWindow.isAlwaysOnTop();
  });
  ipcMain.handle(EXTRA_CHANNELS.WINDOW_MINI_MODE_GET, () => miniModeActive);
  ipcMain.handle(EXTRA_CHANNELS.WINDOW_MINI_MODE_SET, async (event, enabled: unknown) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error("无法获取播放器所属窗口");
    const target = Boolean(enabled);
    if (target === miniModeActive) return miniModeActive;
    if (target) {
      if (ownerWindow.isFullScreen()) {
        ownerWindow.setFullScreen(false);
      }
      wasAlwaysOnTopBeforeMini = ownerWindow.isAlwaysOnTop();
      miniModeActive = true;
      ownerWindow.setAlwaysOnTop(true, "floating");
    } else {
      miniModeActive = false;
      ownerWindow.setAlwaysOnTop(wasAlwaysOnTopBeforeMini, "floating");
    }
    return miniModeActive;
  });
  ipcMain.handle(EXTRA_CHANNELS.PLAYBACK_PREPARE, async (_event, input: PreparePlaybackInput) => {
    try {
      return { ok: true, data: await playback.prepare(input) };
    } catch (error) {
      return { ok: false, error: serializePlaybackFailure(error) };
    }
  });
  ipcMain.handle(EXTRA_CHANNELS.PLAYBACK_CLOSE, (_event, sessionId: string) => playback.close(sessionId));
  ipcMain.handle(EXTRA_CHANNELS.PLAYBACK_FALLBACK, async (_event, sessionId: string) => {
    try {
      return { ok: true, data: await playback.fallback(sessionId) };
    } catch (error) {
      return { ok: false, error: serializePlaybackFailure(error) };
    }
  });
  ipcMain.handle(EXTRA_CHANNELS.PLAYBACK_EXTERNAL, async () => ({
    ok: false,
    error: serializePlaybackFailure(new Error("外部播放器已禁用，请使用应用内播放或切换线路/来源。")),
  }));
  ipcMain.handle(EXTRA_CHANNELS.PLAYBACK_CANCEL, () => playback.cancelPreparation());
  ipcMain.handle(EXTRA_CHANNELS.SNIFFER_RESOLVE, async (_event, siteKey: string, flag: string, episodeUrl: string) => {
    const result = await service.playerResult(siteKey, flag, episodeUrl);
    return sniffer.sniff(result.url, {
      headers: result.header,
      adPatterns: service.getConfig()?.ads ?? [],
    });
  });
  ipcMain.handle(EXTRA_CHANNELS.SNIFFER_CANCEL, () => sniffer.cancel());
  if (catVod) {
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_STATUS, () => catVod.status());
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_START, (_event, sourceMd5Url?: string, remoteAccessPolicy?: CatVodRemoteAccessPolicy) => catVod.start(sourceMd5Url, remoteAccessPolicy));
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_STOP, () => catVod.stop());
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_RESTART, (_event, remoteAccessPolicy?: CatVodRemoteAccessPolicy) => catVod.restart(remoteAccessPolicy));
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_UPDATE_INSPECT, () => catVod.inspectUpdate());
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_UPDATE_CHECK, () => catVod.checkForUpdate());
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_UPDATE_ACTIVATE, () => catVod.activateCandidate());
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_ROLLBACK, () => catVod.rollback());
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_OPEN_WEBSITE, () => catVod.openWebsite());
    ipcMain.handle(EXTRA_CHANNELS.CATVOD_LOG_PATH, () => catVod.logPath());
    ipcMain.handle(EXTRA_CHANNELS.PAN_STATUS, (_event, provider?: PanProviderId) => catVod.panStatus(provider));
    ipcMain.handle(EXTRA_CHANNELS.PAN_STATUS_ALL, () => catVod.panStatuses());
    ipcMain.handle(EXTRA_CHANNELS.PAN_CLEAR, (_event, provider: PanProviderId) => catVod.clearPanAccount(provider));
    ipcMain.handle(EXTRA_CHANNELS.PAN_LOGIN_START, (_event, provider?: PanLoginProviderId) => catVod.startPanLogin(provider));
    ipcMain.handle(EXTRA_CHANNELS.PAN_LOGIN_POLL, (_event, provider: PanLoginProviderId, taskId: string) => catVod.pollPanLogin(provider, taskId));
    ipcMain.handle(EXTRA_CHANNELS.PAN_LOGIN_CANCEL, (_event, taskId: string) => catVod.cancelPanLogin(taskId));
  }
}

function validateSearchSelection(value: SearchTargetSelection | undefined): SearchTargetSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalizeKeys = (items: unknown): string[] | undefined => {
    if (!Array.isArray(items)) return undefined;
    const keys = items
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .slice(0, 200);
    return keys.length ? keys : undefined;
  };
  const maxSources = Number(value.maxSources);
  return {
    ...(normalizeKeys(value.includeSiteKeys) ? { includeSiteKeys: normalizeKeys(value.includeSiteKeys) } : {}),
    ...(normalizeKeys(value.excludeSiteKeys) ? { excludeSiteKeys: normalizeKeys(value.excludeSiteKeys) } : {}),
    ...(Number.isFinite(maxSources) ? { maxSources: Math.max(1, Math.min(50, Math.floor(maxSources))) } : {}),
  };
}

function validateLiveId(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[a-f0-9]{20}$/i.test(normalized)) throw new Error(`${label}标识无效`);
  return normalized;
}

function validateEpgProgramme(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const startAt = Number(input.startAt);
  const endAt = Number(input.endAt);
  const title = String(input.title ?? "").trim().slice(0, 300);
  const channelId = String(input.channelId ?? "").trim().slice(0, 500);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || !title || !channelId) throw new Error("回看节目信息无效");
  const categories = Array.isArray(input.categories)
    ? input.categories.map((item) => String(item).trim().slice(0, 100)).filter(Boolean).slice(0, 20)
    : [];
  return {
    id: String(input.id ?? `${channelId}-${startAt}`).trim().slice(0, 500),
    channelId,
    startAt,
    endAt,
    title,
    ...(String(input.subtitle ?? "").trim() ? { subtitle: String(input.subtitle).trim().slice(0, 300) } : {}),
    ...(String(input.description ?? "").trim() ? { description: String(input.description).trim().slice(0, 5_000) } : {}),
    categories,
    ...(String(input.icon ?? "").trim() ? { icon: String(input.icon).trim().slice(0, 2_048) } : {}),
  };
}

function validateEpgChannelId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("EPG 频道标识无效");
  return normalized;
}

function validateLiveFavorite(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const channelName = String(input.channelName ?? "").trim().slice(0, 200);
  if (!channelName) throw new Error("直播频道名称不能为空");
  const logo = String(input.logo ?? "").trim();
  return {
    sourceId: validateLiveId(input.sourceId, "直播源"),
    channelId: validateLiveId(input.channelId, "直播频道"),
    channelName,
    ...(logo ? { logo: logo.slice(0, 2_048) } : {}),
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : Date.now(),
  };
}

function validateLiveRecent(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const channelName = String(input.channelName ?? "").trim().slice(0, 200);
  if (!channelName) throw new Error("直播频道名称不能为空");
  const lineId = String(input.lineId ?? "").trim();
  return {
    sourceId: validateLiveId(input.sourceId, "直播源"),
    channelId: validateLiveId(input.channelId, "直播频道"),
    channelName,
    ...(lineId ? { lineId: validateLiveId(lineId, "直播线路") } : {}),
    watchedAt: Number.isFinite(Number(input.watchedAt)) ? Number(input.watchedAt) : Date.now(),
  };
}

function validateLivePlaybackFeedback(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const kind = String(input.kind ?? "").trim();
  const supportedKinds = ["started", "stable", "buffering", "failure", "failover-success", "failover-failure"] as const;
  if (!supportedKinds.includes(kind as typeof supportedKinds[number])) {
    throw new Error("直播线路反馈类型无效");
  }
  const lineName = String(input.lineName ?? "").trim().slice(0, 200);
  const reason = String(input.reason ?? "").trim().slice(0, 500);
  return {
    sourceId: validateLiveId(input.sourceId, "直播源"),
    channelId: validateLiveId(input.channelId, "直播频道"),
    lineId: validateLiveId(input.lineId, "直播线路"),
    ...(lineName ? { lineName } : {}),
    kind: kind as typeof supportedKinds[number],
    ...(Number.isFinite(Number(input.startupMs)) ? { startupMs: Math.max(0, Math.min(120_000, Math.round(Number(input.startupMs)))) } : {}),
    ...(Number.isFinite(Number(input.playedSeconds)) ? { playedSeconds: Math.max(0, Math.min(86_400, Math.round(Number(input.playedSeconds)))) } : {}),
    ...(Number.isFinite(Number(input.bufferingCount)) ? { bufferingCount: Math.max(1, Math.min(100, Math.round(Number(input.bufferingCount)))) } : {}),
    ...(Number.isFinite(Number(input.bufferingDurationMs)) ? { bufferingDurationMs: Math.max(0, Math.min(600_000, Math.round(Number(input.bufferingDurationMs)))) } : {}),
    ...(reason ? { reason } : {}),
    occurredAt: Number.isFinite(Number(input.occurredAt)) ? Math.round(Number(input.occurredAt)) : Date.now(),
  };
}

function validateLiveCatchupHistory(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const programmeStartAt = validateProgrammeTimestamp(input.programmeStartAt, "节目开始时间");
  const programmeEndAt = validateProgrammeTimestamp(input.programmeEndAt, "节目结束时间");
  if (programmeEndAt <= programmeStartAt) throw new Error("节目时间范围无效");
  const programmeTitle = String(input.programmeTitle ?? "").trim().slice(0, 300);
  if (!programmeTitle) throw new Error("节目名称不能为空");
  const duration = Math.max(0, Number(input.duration) || 0);
  const position = Math.max(0, Math.min(duration > 0 ? duration : Number.MAX_SAFE_INTEGER, Number(input.position) || 0));
  return {
    sourceId: validateLiveId(input.sourceId, "直播源"),
    channelId: validateLiveId(input.channelId, "直播频道"),
    programmeStartAt,
    programmeEndAt,
    programmeTitle,
    position,
    duration,
    completed: Boolean(input.completed),
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : Date.now(),
  };
}

function validateProgrammeTimestamp(value: unknown, label: string): number {
  const timestamp = Math.floor(Number(value));
  if (!Number.isFinite(timestamp) || timestamp < 946684800000 || timestamp > 4102444800000) throw new Error(`${label}无效`);
  return timestamp;
}

function assertRendererSettingKey(key: string): void {
  if (isCatVodProtectedSettingKey(key)) {
    throw new Error("CatVod Profile 仅允许主进程访问");
  }
}
