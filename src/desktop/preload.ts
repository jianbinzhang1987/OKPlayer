import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./ipc-service.ts";
import { EXTRA_CHANNELS } from "./register-ipc.ts";

async function invokePlayback<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string; userMessage?: string; retryable?: boolean; sourceImpact?: string };
  };
  if (result?.ok === false && result.error) {
    const error = new Error(result.error.message || result.error.userMessage || "播放失败") as Error & Record<string, unknown>;
    Object.assign(error, result.error);
    throw error;
  }
  if (result?.ok === true) return result.data as T;
  return result as T;
}

contextBridge.exposeInMainWorld("tvApi", {
  platform: process.platform,
  desktopPlatform: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux",
  getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.APP_INFO),
  listConfigs: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_LIST),
  loadConfig: (source: string, name?: string) => ipcRenderer.invoke(EXTRA_CHANNELS.CONFIG_LOAD, source, name),
  renameConfig: (source: string, name: string) => ipcRenderer.invoke(EXTRA_CHANNELS.CONFIG_RENAME, source, name),
  deleteConfig: (source: string) => ipcRenderer.invoke(EXTRA_CHANNELS.CONFIG_DELETE, source),
  getReplacementRegistry: () => ipcRenderer.invoke(EXTRA_CHANNELS.REPLACEMENT_REGISTRY_GET),
  loadReplacementRegistry: (source: string) => ipcRenderer.invoke(EXTRA_CHANNELS.REPLACEMENT_REGISTRY_LOAD, source),
  clearReplacementRegistry: () => ipcRenderer.invoke(EXTRA_CHANNELS.REPLACEMENT_REGISTRY_CLEAR),
  listSites: () => ipcRenderer.invoke(EXTRA_CHANNELS.SITE_LIST),
  checkSiteHealth: (siteKey: string) => ipcRenderer.invoke(EXTRA_CHANNELS.SITE_HEALTH, siteKey),
  startSourceAudit: (force = false) => ipcRenderer.invoke(EXTRA_CHANNELS.SITE_AUDIT_START, force),
  getSourceAuditStatus: () => ipcRenderer.invoke(EXTRA_CHANNELS.SITE_AUDIT_STATUS),
  home: (siteKey: string) => ipcRenderer.invoke(EXTRA_CHANNELS.HOME, siteKey),
  bestHome: (preferredSiteKey?: string) => ipcRenderer.invoke(EXTRA_CHANNELS.HOME_BEST, preferredSiteKey),
  category: (siteKey: string, tid: string, page?: string, extend?: Record<string, string>) => ipcRenderer.invoke(EXTRA_CHANNELS.CATEGORY, siteKey, tid, page, extend),
  search: (keyword: string, siteKey?: string, scope?: "all-configs" | "current-site", page?: number, selection?: { includeSiteKeys?: string[]; excludeSiteKeys?: string[]; maxSources?: number }) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH, keyword, siteKey, scope, page, selection),
  searchDetailed: (keyword: string, siteKey?: string, scope?: "all-configs" | "current-site", page?: number, selection?: { includeSiteKeys?: string[]; excludeSiteKeys?: string[]; maxSources?: number }) => ipcRenderer.invoke(EXTRA_CHANNELS.SEARCH_DETAILED, keyword, siteKey, scope, page, selection),
  startIncrementalSearch: (requestId: string, keyword: string, siteKey?: string, scope?: "all-configs" | "current-site", page?: number, selection?: { includeSiteKeys?: string[]; excludeSiteKeys?: string[]; maxSources?: number }) => {
    ipcRenderer.send(EXTRA_CHANNELS.SEARCH_INCREMENTAL_START, requestId, keyword, siteKey, scope, page, selection);
  },
  cancelIncrementalSearch: (requestId: string) => {
    ipcRenderer.send(EXTRA_CHANNELS.SEARCH_INCREMENTAL_CANCEL, requestId);
  },
  onIncrementalSearchEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(EXTRA_CHANNELS.SEARCH_INCREMENTAL_EVENT, listener);
    return () => ipcRenderer.removeListener(EXTRA_CHANNELS.SEARCH_INCREMENTAL_EVENT, listener);
  },
  detail: (siteKey: string, vodId: string) => ipcRenderer.invoke(IPC_CHANNELS.DETAIL, siteKey, vodId),
  resolvePlay: (siteKey: string, flag: string, episodeUrl: string) => ipcRenderer.invoke(IPC_CHANNELS.RESOLVE, siteKey, flag, episodeUrl),
  listHistory: () => ipcRenderer.invoke(EXTRA_CHANNELS.HISTORY_LIST),
  saveHistory: (record: unknown) => ipcRenderer.invoke(EXTRA_CHANNELS.HISTORY_SAVE, record),
  removeHistory: (siteKey: string, vodId: string, episodeName: string) => ipcRenderer.invoke(EXTRA_CHANNELS.HISTORY_REMOVE, siteKey, vodId, episodeName),
  clearHistory: () => ipcRenderer.invoke(EXTRA_CHANNELS.HISTORY_CLEAR),
  listFavorites: () => ipcRenderer.invoke(EXTRA_CHANNELS.FAVORITE_LIST),
  saveFavorite: (record: unknown) => ipcRenderer.invoke(EXTRA_CHANNELS.FAVORITE_SAVE, record),
  removeFavorite: (siteKey: string, vodId: string) => ipcRenderer.invoke(EXTRA_CHANNELS.FAVORITE_REMOVE, siteKey, vodId),
  getSetting: (key: string, fallback: unknown) => ipcRenderer.invoke(EXTRA_CHANNELS.SETTING_GET, key, fallback),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke(EXTRA_CHANNELS.SETTING_SET, key, value),
  openPlayer: (url: string, headers?: Record<string, string>) => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_OPEN, url, headers),
  play: () => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_PLAY),
  pause: () => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_PAUSE),
  seek: (seconds: number) => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_SEEK, seconds),
  setSpeed: (speed: number) => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_SPEED, speed),
  setVolume: (volume: number) => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_VOLUME, volume),
  setMuted: (muted: boolean) => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_MUTE, muted),
  stop: () => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_STOP),
  attachNativePlayerView: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_NATIVE_ATTACH, rect),
  resizeNativePlayerView: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_NATIVE_RESIZE, rect),
  detachNativePlayerView: () => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYER_NATIVE_DETACH),
  onPlayerState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on(EXTRA_CHANNELS.PLAYER_STATE, listener);
    return () => ipcRenderer.removeListener(EXTRA_CHANNELS.PLAYER_STATE, listener);
  },
  preparePlayback: (input: unknown) => invokePlayback(EXTRA_CHANNELS.PLAYBACK_PREPARE, input),
  closePlayback: (sessionId: string) => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYBACK_CLOSE, sessionId),
  fallbackPlayback: (sessionId: string) => invokePlayback(EXTRA_CHANNELS.PLAYBACK_FALLBACK, sessionId),
  openExternalPlayback: (sessionId: string, preference: "iina" | "vlc" | "system") => invokePlayback(EXTRA_CHANNELS.PLAYBACK_EXTERNAL, sessionId, preference),
  cancelPlaybackPreparation: () => ipcRenderer.invoke(EXTRA_CHANNELS.PLAYBACK_CANCEL),
  sniffPlay: (siteKey: string, flag: string, episodeUrl: string) => ipcRenderer.invoke(EXTRA_CHANNELS.SNIFFER_RESOLVE, siteKey, flag, episodeUrl),
  cancelSniff: () => ipcRenderer.invoke(EXTRA_CHANNELS.SNIFFER_CANCEL),
  getCatVodStatus: () => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_STATUS),
  startCatVod: (sourceMd5Url?: string, remoteAccessPolicy?: "allow" | "block-startup") => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_START, sourceMd5Url, remoteAccessPolicy),
  stopCatVod: () => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_STOP),
  restartCatVod: (remoteAccessPolicy?: "allow" | "block-startup") => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_RESTART, remoteAccessPolicy),
  inspectCatVodUpdate: () => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_UPDATE_INSPECT),
  checkCatVodUpdate: () => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_UPDATE_CHECK),
  activateCatVodUpdate: () => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_UPDATE_ACTIVATE),
  rollbackCatVod: () => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_ROLLBACK),
  openCatVodWebsite: () => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_OPEN_WEBSITE),
  getCatVodLogPath: () => ipcRenderer.invoke(EXTRA_CHANNELS.CATVOD_LOG_PATH),
  getPanStatus: (provider: "quark" | "uc" | "baidu" | "pan115" | "pan189" | "pan139" = "quark") => ipcRenderer.invoke(EXTRA_CHANNELS.PAN_STATUS, provider),
  getPanStatuses: () => ipcRenderer.invoke(EXTRA_CHANNELS.PAN_STATUS_ALL),
  clearPanAccount: (provider: "quark" | "uc" | "baidu" | "pan115" | "pan189" | "pan139") => ipcRenderer.invoke(EXTRA_CHANNELS.PAN_CLEAR, provider),
  startPanLogin: (provider: "quark" | "ucCookie" | "ucToken" | "baidu" | "pan115" | "pan189" | "pan139" = "quark") => ipcRenderer.invoke(EXTRA_CHANNELS.PAN_LOGIN_START, provider),
  pollPanLogin: (provider: "quark" | "ucCookie" | "ucToken" | "baidu" | "pan115" | "pan189" | "pan139", taskId: string) => ipcRenderer.invoke(EXTRA_CHANNELS.PAN_LOGIN_POLL, provider, taskId),
  cancelPanLogin: (taskId: string) => ipcRenderer.invoke(EXTRA_CHANNELS.PAN_LOGIN_CANCEL, taskId),
  onCatVodHostEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(EXTRA_CHANNELS.CATVOD_HOST_EVENT, listener);
    return () => ipcRenderer.removeListener(EXTRA_CHANNELS.CATVOD_HOST_EVENT, listener);
  },
});
