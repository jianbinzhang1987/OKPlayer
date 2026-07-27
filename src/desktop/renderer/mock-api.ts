type MockVod = {
  vodId: string;
  vodName: string;
  vodPic: string;
  vodRemarks: string;
  vodYear: string;
  vodArea: string;
  vodDirector: string;
  vodActor: string;
  vodContent: string;
  typeName: string;
  siteKey: string;
  siteName: string;
  vodTag?: "file" | "folder" | "action" | string;
  contentKind?: "playable" | "discovery" | "folder" | "action" | "live";
  flags?: Array<{ flag: string; show: string; episodes: Array<{ name: string; url: string; index: number }> }>;
};

function poster(title: string, accent: string, secondary: string) {
  const safeTitle = title.replace(/[<>&"']/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${accent}"/><stop offset="1" stop-color="${secondary}"/></linearGradient>
      <radialGradient id="r" cx="72%" cy="18%" r="62%"><stop stop-color="#fff" stop-opacity=".34"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="600" height="900" fill="url(#g)"/>
    <rect width="600" height="900" fill="url(#r)"/>
    <circle cx="450" cy="220" r="170" fill="#fff" opacity=".08"/>
    <path d="M-40 760C120 620 235 680 360 570c100-88 154-172 280-210v540H-40Z" fill="#05070c" opacity=".42"/>
    <path d="M0 710c130-72 236-60 345-157 78-69 132-138 255-170" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="3"/>
    <text x="52" y="690" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue" font-size="24" font-weight="600" opacity=".72">FONGMI ORIGINAL</text>
    <text x="52" y="750" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue" font-size="48" font-weight="700">${safeTitle}</text>
    <text x="52" y="805" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue" font-size="18" opacity=".68">MACOS · FEATURED</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

type MockVodSeed = readonly [string, string, string, string, string, string, string];

const baseItems: MockVod[] = ([
  ["1", "星际远航", "#143a67", "#080d18", "全12集", "2026", "科幻"],
  ["2", "雾中来信", "#5a284f", "#15101b", "更新至08集", "2025", "悬疑"],
  ["3", "山海之间", "#1c5b53", "#0b1719", "高清", "2026", "纪录片"],
  ["4", "夏日列车", "#d47951", "#422539", "全24集", "2025", "剧情"],
  ["5", "深蓝计划", "#224d7f", "#101525", "4K", "2026", "动作"],
  ["6", "微光城市", "#6a3858", "#151521", "全16集", "2026", "都市"],
  ["7", "风起长安", "#7a5232", "#201514", "更新至20集", "2025", "古装"],
  ["8", "极昼之后", "#455a73", "#11151c", "高清", "2026", "灾难"],
  ["9", "月面电台", "#4c3e80", "#121125", "全10集", "2026", "科幻"],
  ["10", "河流的方向", "#386753", "#121913", "纪录片", "2024", "人文"],
  ["11", "静默信号", "#71414d", "#191116", "更新至06集", "2026", "犯罪"],
  ["12", "云端之外", "#365d91", "#111625", "高清", "2025", "冒险"],
] satisfies readonly MockVodSeed[]).map(([id, name, accent, secondary, remark, year, type]) => ({
  vodId: id,
  vodName: name,
  vodPic: poster(name, accent, secondary),
  vodRemarks: remark,
  vodYear: year,
  vodArea: "中国",
  vodDirector: "林舟",
  vodActor: "陈野 / 周岚 / 宋川",
  vodContent: `${name}是一部用于界面预览的示例内容。这里展示影片简介、元数据、线路与剧集等真实产品布局。`,
  typeName: type,
  siteKey: "demo-http",
  siteName: "云端影视",
}));

function detail(item: MockVod): MockVod {
  return {
    ...item,
    flags: [
      {
        flag: "线路一",
        show: "高清线路",
        episodes: Array.from({ length: 18 }, (_, index) => ({ name: `第${String(index + 1).padStart(2, "0")}集`, url: `mock://${item.vodId}/${index + 1}`, index })),
      },
      {
        flag: "线路二",
        show: "备用线路",
        episodes: Array.from({ length: 12 }, (_, index) => ({ name: `第${String(index + 1).padStart(2, "0")}集`, url: `mock-alt://${item.vodId}/${index + 1}`, index })),
      },
    ],
  };
}

export function createMockTvApi() {
  let configs = [{ id: 1, name: "演示配置", url: "https://example.com/fongmi/config.json", enabled: true, updatedAt: Date.now() - 3_600_000 }];
  let favorites = [
    { siteKey: "demo-http", vodId: "2", vodName: "雾中来信", vodPic: baseItems[1]!.vodPic, createdAt: Date.now() - 86_400_000 },
    { siteKey: "demo-http", vodId: "5", vodName: "深蓝计划", vodPic: baseItems[4]!.vodPic, createdAt: Date.now() - 172_800_000 },
  ];
  let histories = [
    { siteKey: "demo-http", vodId: "1", vodName: "星际远航", episodeName: "第07集", episodeUrl: "mock://1/7", position: 1220, duration: 2700, updatedAt: Date.now() - 1_800_000 },
    { siteKey: "demo-http", vodId: "4", vodName: "夏日列车", episodeName: "第12集", episodeUrl: "mock://4/12", position: 840, duration: 2400, updatedAt: Date.now() - 25_200_000 },
    { siteKey: "demo-http", vodId: "7", vodName: "风起长安", episodeName: "第03集", episodeUrl: "mock://7/3", position: 540, duration: 2600, updatedAt: Date.now() - 172_800_000 },
  ];
  const settings = new Map<string, unknown>();
  const getMockSetting = (key: string, fallback: unknown) => {
    if (settings.has(key)) return settings.get(key);
    try {
      const raw = window.localStorage.getItem(`fongmi-preview-setting:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  const setMockSetting = (key: string, value: unknown) => {
    settings.set(key, value);
    try { window.localStorage.setItem(`fongmi-preview-setting:${key}`, JSON.stringify(value)); } catch { /* preview storage is optional */ }
  };
  let replacementRegistry = { source: "", count: 0 };
  const panNames: Record<string, string> = {
    quark: "夸克网盘",
    uc: "UC 网盘",
    baidu: "百度网盘",
    pan115: "115 网盘",
    pan189: "天翼云盘",
    pan139: "移动云盘",
  };
  const fixtureBaseUrl = new URLSearchParams(window.location.search).get("fixture")?.replace(/\/$/, "") ?? "";
  const panLoggedIn = new Set(["quark", "pan189"]);
  const panConfigured = new Set(["quark", "uc", "pan189"]);
  const panUnavailable = new Set(["pan115"]);
  const panCredentialModes = new Map<string, string>([["quark", "cookie"], ["uc", "tv-token"], ["pan189", "scan"]]);
  const panLoginTasks = new Map<string, string>();
  const panStatus = (provider: string) => {
    const unavailable = panUnavailable.has(provider);
    const login = panLoggedIn.has(provider);
    const configured = panConfigured.has(provider);
    return {
      provider,
      name: panNames[provider] ?? provider,
      configured,
      login,
      accountState: unavailable ? "unavailable" : login ? "connected" : configured ? "expired" : "not-configured",
      credentialMode: panCredentialModes.get(provider) ?? "unknown",
      state: unavailable ? "状态检查失败（预览）" : login ? "已登录（预览）" : configured ? "登录已失效（预览）" : "未登录",
      label: `${panNames[provider] ?? provider}预览状态`,
      checkedAt: Date.now(),
    };
  };
  const statusProviderForLogin = (provider: string) => provider === "ucCookie" || provider === "ucToken" ? "uc" : provider;
  const mockQr = (provider: string) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#fff"/><rect x="18" y="18" width="204" height="204" rx="18" fill="#151821"/><text x="120" y="110" fill="#fff" text-anchor="middle" font-size="20" font-family="sans-serif">${panNames[statusProviderForLogin(provider)] ?? provider}</text><text x="120" y="142" fill="#9ca3af" text-anchor="middle" font-size="13" font-family="sans-serif">预览二维码</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  };
  const folder = (id: string, name: string): MockVod => ({
    vodId: id,
    vodName: name,
    vodPic: "",
    vodRemarks: "文件夹",
    vodYear: "",
    vodArea: "",
    vodDirector: "",
    vodActor: "",
    vodContent: "",
    typeName: "网盘目录",
    siteKey: "demo-pan",
    siteName: "预览网盘",
    vodTag: "folder",
    contentKind: "folder",
  });
  const panFile = (id: string, name: string, remark = "视频文件"): MockVod => ({
    vodId: id,
    vodName: name,
    vodPic: poster(name, "#385d8a", "#121827"),
    vodRemarks: remark,
    vodYear: "2026",
    vodArea: "本机 Fixture",
    vodDirector: "",
    vodActor: "",
    vodContent: "用于目录、字幕和弹幕端到端验证的预览文件。",
    typeName: "网盘文件",
    siteKey: "demo-pan",
    siteName: "预览网盘",
    vodTag: "file",
    contentKind: "playable",
  });
  const panRootItems = [folder("folder-family", "家庭影音"), panFile("root-video.mp4", "根目录电影.mp4")];
  const panDirectories: Record<string, MockVod[][]> = {
    "folder-family": [
      [folder("folder-2026", "2026 年"), panFile("family-01.mp4", "家庭录像 01.mp4"), panFile("family-01.zh.vtt", "家庭录像 01.zh.vtt", "字幕文件")],
      [panFile("family-02.mp4", "家庭录像 02.mp4"), panFile("family-03.mp4", "家庭录像 03.mp4")],
    ],
    "folder-2026": [[folder("folder-summer", "暑期旅行"), panFile("spring.mp4", "春日短片.mp4")]],
    "folder-summer": [[panFile("summer-trip.mp4", "连云港旅行.mp4"), panFile("summer-trip.zh.vtt", "连云港旅行.zh.vtt", "字幕文件")]],
  };

  return {
    platform: "darwin",
    desktopPlatform: "mac",
    getInfo: async () => ({ name: "FongMi Desktop", version: "preview", platform: "darwin", desktopPlatform: "mac", usesMacTrafficLights: true, supportsExternalIina: true, electron: "preview", chrome: "preview", node: "preview", arch: "preview" }),
    listConfigs: async () => configs,
    loadConfig: async (source: string, name = "默认配置") => {
      configs = configs.map((item) => ({ ...item, enabled: false }));
      const existing = configs.find((item) => item.url === source);
      if (existing) Object.assign(existing, { name, enabled: true, updatedAt: Date.now() });
      else configs.unshift({ id: Date.now(), name, url: source, enabled: true, updatedAt: Date.now() });
      return {};
    },
    renameConfig: async (source: string, name: string) => { configs = configs.map((item) => item.url === source ? { ...item, name, updatedAt: Date.now() } : item); },
    deleteConfig: async (source: string) => { configs = configs.filter((item) => item.url !== source); },
    getReplacementRegistry: async () => replacementRegistry,
    loadReplacementRegistry: async (source: string) => (replacementRegistry = { source, count: 1 }),
    clearReplacementRegistry: async () => (replacementRegistry = { source: "", count: 0 }),
    getCatVodStatus: async () => ({ state: "running", sourceMd5Url: "preview://catvod", siteCount: 3, port: 9988 }),
    startCatVod: async () => ({ state: "running", message: "预览服务已启动" }),
    getPanStatus: async (provider = "quark") => panStatus(provider),
    getPanStatuses: async () => Object.keys(panNames).map(panStatus),
    startPanLogin: async (provider = "quark") => {
      const taskId = `preview_${provider}_${Date.now()}`;
      panLoginTasks.set(taskId, provider);
      return { provider, taskId, status: "waiting", terminal: false, message: "请扫描预览二维码", qrImage: mockQr(provider) };
    },
    pollPanLogin: async (provider: string, taskId: string) => {
      if (panLoginTasks.get(taskId) !== provider) return { provider, taskId, status: "error", terminal: true, message: "预览登录任务不存在" };
      panLoginTasks.delete(taskId);
      const accountProvider = statusProviderForLogin(provider);
      panUnavailable.delete(accountProvider);
      panConfigured.add(accountProvider);
      panLoggedIn.add(accountProvider);
      panCredentialModes.set(accountProvider, provider === "ucToken" ? "tv-token" : provider === "ucCookie" ? "cookie" : "scan");
      return { provider, taskId, status: "success", terminal: true, message: "预览登录成功" };
    },
    cancelPanLogin: async (taskId: string) => {
      const provider = panLoginTasks.get(taskId) ?? "quark";
      panLoginTasks.delete(taskId);
      return { provider, taskId, status: "cancelled", terminal: true, message: "已取消登录" };
    },
    clearPanAccount: async (provider: string) => {
      panLoggedIn.delete(provider);
      panConfigured.delete(provider);
      panUnavailable.delete(provider);
      panCredentialModes.delete(provider);
      for (const [taskId, loginProvider] of panLoginTasks) {
        if (statusProviderForLogin(loginProvider) === provider) panLoginTasks.delete(taskId);
      }
      return panStatus(provider);
    },
    listSites: async () => [
      { key: "demo-http", name: "云端影视", type: 1, supported: true, runtime: "http", categories: ["电影", "电视剧", "动漫", "综艺", "纪录片"], capabilities: { home: true, category: true, search: true, detail: true, player: true, proxy: false, health: false } },
      { key: "demo-pan", name: "预览网盘", type: 1, supported: true, runtime: "http", contentType: "pan", categories: ["我的网盘"], capabilities: { home: true, category: true, search: false, detail: true, player: true, proxy: true, health: false } },
      { key: "demo-drpy", name: "光影规则", type: 3, supported: true, runtime: "drpy", capabilities: { home: true, category: true, search: true, detail: true, player: true, proxy: false, health: false } },
      { key: "demo-t4", name: "本地 T4", type: 6, supported: true, runtime: "t4", capabilities: { home: true, category: true, search: true, detail: true, player: true, proxy: false, health: true } },
      { key: "demo-dex", name: "Android 专用源", type: 3, supported: false, runtime: "android-dex", reason: "该站点依赖 Android Dex/JAR，macOS 无法直接执行。", capabilities: { home: false, category: false, search: false, detail: false, player: false, proxy: false, health: false } },
    ],
    checkSiteHealth: async () => ({ ok: true, latencyMs: 86, message: "服务运行正常" }),
    home: async (siteKey?: string) => siteKey === "demo-pan"
      ? { list: panRootItems, page: 1, pageCount: 1 }
      : { list: baseItems },
    category: async (siteKey: string, category: string, page = "1") => {
      if (siteKey === "demo-pan") {
        const pages = panDirectories[category] ?? [panRootItems];
        const pageNumber = Math.max(1, Number(page) || 1);
        return {
          list: pages[pageNumber - 1] ?? [],
          page: pageNumber,
          pageCount: pages.length,
          hasMore: pageNumber < pages.length,
        };
      }
      return { list: baseItems.map((item) => ({ ...item, typeName: category })) };
    },
    search: async (keyword: string) => baseItems.filter((item) => item.vodName.includes(keyword) || keyword.length < 3),
    searchDetailed: async (keyword: string, siteKey?: string, _scope?: string, page = 1) => {
      const list = baseItems.filter((item) => item.vodName.includes(keyword) || keyword.length < 3);
      const sourceNames = siteKey ? [[siteKey, "云端影视"]] : [["demo-http", "云端影视"], ["demo-drpy", "光影规则"], ["demo-t4", "本地 T4"]];
      return {
        list,
        statuses: sourceNames.map(([key, name], index) => ({ siteKey: key, siteName: name, state: index === 2 && !siteKey ? "error" : "success", count: index === 2 && !siteKey ? 0 : Math.max(1, Math.floor(list.length / sourceNames.length)), page, pageCount: 2, hasMore: page < 2, ...(index === 2 && !siteKey ? { message: "预览中的模拟超时" } : {}) })),
        page,
        hasMore: page < 2,
      };
    },
    detail: async (siteKey: string, vodId: string) => {
      if (siteKey === "demo-pan") {
        const item = [...panRootItems, ...Object.values(panDirectories).flat(2)].find((entry) => entry.vodId === vodId) ?? panFile(vodId, vodId);
        return {
          ...item,
          flags: item.vodTag === "file" && !/\.(?:srt|vtt|ass|ssa)$/i.test(item.vodName)
            ? [{ flag: "预览网盘线路", show: "受保护媒体", episodes: [{ name: item.vodName, url: `mock-pan://${item.vodId}`, index: 0 }] }]
            : [],
        };
      }
      return detail(baseItems.find((item) => item.vodId === vodId) ?? baseItems[0]!);
    },
    resolvePlay: async () => ({ url: "mock://media", headers: {}, resolvedBy: "direct" }),
    listHistory: async () => histories,
    saveHistory: async (record: any) => {
      histories = [record, ...histories.filter((item) => item.siteKey !== record.siteKey || item.vodId !== record.vodId || item.episodeName !== record.episodeName)];
    },
    removeHistory: async (siteKey: string, vodId: string, episodeName: string) => { histories = histories.filter((item) => item.siteKey !== siteKey || item.vodId !== vodId || item.episodeName !== episodeName); },
    clearHistory: async () => { histories = []; },
    listFavorites: async () => favorites,
    saveFavorite: async (record: any) => { favorites = [record, ...favorites.filter((item) => item.vodId !== record.vodId)]; },
    removeFavorite: async (siteKey: string, vodId: string) => { favorites = favorites.filter((item) => item.siteKey !== siteKey || item.vodId !== vodId); },
    getSetting: async (key: string, fallback: unknown) => getMockSetting(key, fallback),
    setSetting: async (key: string, value: unknown) => { setMockSetting(key, value); },
    openPlayer: async () => ({ status: "started" }),
    play: async () => undefined,
    pause: async () => undefined,
    seek: async () => undefined,
    setSpeed: async () => undefined,
    stop: async () => undefined,
    onPlayerState: () => () => undefined,
    preparePlayback: async (input: any) => {
      const episodeUrl = String(input?.episodeUrl ?? "");
      const hlsPreview = episodeUrl.includes("mock://2/");
      const panPreview = episodeUrl.startsWith("mock-pan://") && fixtureBaseUrl;
      return {
        sessionId: `preview-${Date.now()}`,
        playbackUrl: panPreview
          ? `${fixtureBaseUrl}/media.mp4`
          : hlsPreview
            ? "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
            : "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        format: hlsPreview ? "hls" : "mp4",
        engine: "web",
        resolvedBy: "direct",
        ...(panPreview ? { subtitleUrl: `${fixtureBaseUrl}/subtitle.vtt`, danmakuUrl: `${fixtureBaseUrl}/danmaku.json` } : {}),
      };
    },
    closePlayback: async () => ({ closed: true }),
    fallbackPlayback: async () => ({ status: "started" }),
    cancelPlaybackPreparation: async () => undefined,
    sniffPlay: async () => ({ url: "mock://media", headers: {}, resolvedBy: "browser-sniffer" }),
    cancelSniff: async () => undefined,
  };
}
