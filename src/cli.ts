import { loadVodConfig } from "./core/config-loader.ts";
import { redactSensitiveError, redactSensitiveValue } from "./core/log-redaction.ts";
import type { SiteConfig } from "./core/models.ts";
import { resolvePlayerResult } from "./core/resolver.ts";
import { SourceAdapterFactory } from "./core/source-adapter-factory.ts";
import { getSiteCapability } from "./core/source-capability.ts";

function usage(): never {
  console.error(`用法：
  npm run cli -- sites <配置URL或本地文件>
  npm run cli -- search <配置> <siteKey> <关键词> [页码]
  npm run cli -- detail <配置> <siteKey> <vodId>
  npm run cli -- resolve <配置> <siteKey> <vodId> [线路序号] [剧集序号]
`);
  process.exit(1);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(redactSensitiveValue(value), null, 2));
}

function requireSite(sites: SiteConfig[], key: string): SiteConfig {
  const site = sites.find((item) => item.key === key);
  if (site === undefined) throw new Error(`未找到站点：${key}`);
  return site;
}

async function main(): Promise<void> {
  const [command, configSource, ...args] = process.argv.slice(2);
  if (command === undefined || configSource === undefined) usage();
  const config = await loadVodConfig(configSource);

  if (command === "sites") {
    printJson(config.sites.map((site) => ({
      key: site.key,
      name: site.name,
      type: site.type,
      api: site.api,
      ...getSiteCapability(site),
    })));
    return;
  }

  const siteKey = args[0];
  if (siteKey === undefined) usage();
  const site = requireSite(config.sites, siteKey);
  const source = new SourceAdapterFactory().create(site);
  if (!source.supported) throw new Error(`站点 ${site.name} 无法执行：${source.reason ?? "缺少可用运行时"}`);

  try {
    if (command === "search") {
      const keyword = args[1];
      if (keyword === undefined) usage();
      const result = await source.search(keyword, args[2] ?? "1");
      printJson(result);
      return;
    }

    if (command === "detail") {
      const vodId = args[1];
      if (vodId === undefined) usage();
      printJson(await source.detail(vodId));
      return;
    }

    if (command === "resolve") {
      const vodId = args[1];
      if (vodId === undefined) usage();
      const flagIndex = Number(args[2] ?? "0");
      const episodeIndex = Number(args[3] ?? "0");
      const vod = await source.detail(vodId);
      const flag = vod.flags[flagIndex];
      if (flag === undefined) throw new Error(`线路序号无效：${flagIndex}`);
      const episode = flag.episodes[episodeIndex];
      if (episode === undefined) throw new Error(`剧集序号无效：${episodeIndex}`);
      const player = await source.player(flag.flag, episode.url, config.flags);
      const resolved = await resolvePlayerResult(player, config.parses);
      printJson({ vod: vod.vodName, flag: flag.show, episode: episode.name, player, resolved });
      return;
    }

    usage();
  } finally {
    await source.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(redactSensitiveError(error));
  process.exitCode = 1;
});
