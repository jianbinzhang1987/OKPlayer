export type HlsErrorData = {
  fatal?: boolean;
  type?: string;
  details?: string;
};

export type HlsInstance = {
  attachMedia(media: HTMLMediaElement): void;
  loadSource(source: string): void;
  startLoad(): void;
  recoverMediaError(): void;
  destroy(): void;
  on(event: string, callback: (event: string, data: HlsErrorData) => void): void;
};

export type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  Events: {
    MEDIA_ATTACHED: string;
    MANIFEST_PARSED: string;
    ERROR: string;
  };
  ErrorTypes: {
    NETWORK_ERROR: string;
    MEDIA_ERROR: string;
  };
};

export async function loadHlsConstructor(): Promise<HlsConstructor> {
  const module = await import("hls.js") as { default?: HlsConstructor };
  if (!module.default) throw new Error("HLS 播放模块加载失败");
  return module.default;
}

export function supportsNativeHls(element: HTMLVideoElement): boolean {
  return Boolean(
    element.canPlayType("application/vnd.apple.mpegurl")
    || element.canPlayType("application/x-mpegURL"),
  );
}
