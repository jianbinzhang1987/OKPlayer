import { T4Adapter } from "../src/core/t4-adapter.ts";
import type { Vod } from "../src/core/models.ts";

interface PublicT4Source {
  name: string;
  api: string;
  note: string;
}

interface AuditRow {
  source: string;
  operation: string;
  ok: boolean;
  elapsedMs: number;
  detail: string;
}

const SOURCES: PublicT4Source[] = [
  {
    name: "CatVod Gaze",
    api: "https://t4.catvod.eu.org/catvod/gaze",
    note: "公开配置中的 T4 网页源",
  },
  {
    name: "短剧 T4",
    api: "https://catbox.n13.club/duanju.php",
    note: "公开配置中的短剧服务",
  },
  {
    name: "豆瓣荐片 T4",
    api: "http://top.fuqizhishi.com/vod",
    note: "公开配置中的豆瓣推荐服务",
  },
  {
    name: "Secan Voflix",
    api: "https://t4.secan.icu/vod?sites=voflix&timeout=7",
    note: "公开配置中的聚合 T4 服务",
  },
  {
    name: "音悦 T4",
    api: "http://120.53.102.254/t4/yinyuetai/",
    note: "公开配置中的音乐服务",
  },
];

async function operation<T>(
  rows: AuditRow[],
  source: PublicT4Source,
  name: string,
  run: () => Promise<T>,
  describe: (value: T) => string,
): Promise<T | undefined> {
  const startedAt = Date.now();
  try {
    const value = await run();
    rows.push({ source: source.name, operation: name, ok: true, elapsedMs: Date.now() - startedAt, detail: describe(value) });
    return value;
  } catch (error) {
    rows.push({
      source: source.name,
      operation: name,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function firstPlayable(vods: Vod[]): Vod | undefined {
  return vods.find((vod) => vod.vodId && vod.flags.some((flag) => flag.episodes.length > 0))
    ?? vods.find((vod) => vod.vodId);
}

const rows: AuditRow[] = [];
for (const [index, source] of SOURCES.entries()) {
  const adapter = new T4Adapter({
    key: `public-t4-${index + 1}`,
    name: source.name,
    type: 4,
    api: source.api,
    timeout: 8,
  });

  try {
    await operation(rows, source, "init", () => adapter.init(), () => source.note);
    const home = await operation(rows, source, "home", () => adapter.home(), (result) => `items=${result.list.length}; pages=${result.pageCount}`);
    const category = await operation(rows, source, "category", () => adapter.category("1", "1", {}), (result) => `items=${result.list.length}; pages=${result.pageCount}`);
    const search = await operation(rows, source, "search", () => adapter.search("长安", "1", false), (result) => `items=${result.list.length}`);
    const seed = firstPlayable([...(search?.list ?? []), ...(home?.list ?? []), ...(category?.list ?? [])]);
    if (!seed) {
      rows.push({ source: source.name, operation: "detail", ok: false, elapsedMs: 0, detail: "no-vod-result" });
      rows.push({ source: source.name, operation: "player", ok: false, elapsedMs: 0, detail: "no-vod-result" });
      continue;
    }

    const detail = await operation(rows, source, "detail", () => adapter.detail(seed.vodId), (vod) => {
      const episodes = vod.flags.reduce((count, flag) => count + flag.episodes.length, 0);
      return `name=${vod.vodName}; flags=${vod.flags.length}; episodes=${episodes}`;
    });
    const flag = detail?.flags.find((item) => item.episodes.length > 0);
    const episode = flag?.episodes[0];
    if (!flag || !episode) {
      rows.push({ source: source.name, operation: "player", ok: false, elapsedMs: 0, detail: "no-episode" });
      continue;
    }
    await operation(rows, source, "player", () => adapter.player(flag.flag, episode.url), (player) => `parse=${player.parse}; url=${player.url.slice(0, 120)}`);
  } finally {
    await adapter.destroy();
  }
}

console.log("Public T4 live compatibility audit");
console.table(rows);
const completed = rows.filter((row) => row.elapsedMs > 0);
const passed = completed.filter((row) => row.ok);
console.log(`completed operations: ${completed.length}; passed: ${passed.length}; failed: ${completed.length - passed.length}`);
console.log("External endpoint failures are reported but do not fail the project build because public T4 services can change independently.");
