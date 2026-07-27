import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const playwrightModule = process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright";
const { chromium } = await import(playwrightModule);

const root = process.cwd();
const endpoint = process.env.FONGMI_CDP_ENDPOINT ?? "http://127.0.0.1:9223";
const configUrl = process.env.FONGMI_TEST_CONFIG_URL
  ?? "http://127.0.0.1:4179/@fs/Users/adolf/Desktop/code/TV/mac/public/public-domain-config.json";
const artifactDir = path.join(root, "artifacts", "live-app-flow");

await fs.rm(artifactDir, { recursive: true, force: true });
await fs.mkdir(artifactDir, { recursive: true });

let page;
try {
  const browser = await chromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  page = pages.find((item) => item.url().includes("index.html")) ?? pages[0];
  if (!page) throw new Error("未找到已启动的 FongMi 应用页面");

  await page.bringToFront();
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });

  await page.getByRole("button", { name: "播放源", exact: true }).click();
  await page.locator(".sources-page").waitFor({ state: "visible" });
  await page.getByPlaceholder("例如：家庭配置").fill("公开影片测试源");
  await page.getByPlaceholder("https://example.com/config.json").fill(configUrl);
  await page.getByRole("button", { name: "导入", exact: true }).click();

  await Promise.race([
    page.locator(".source-switcher option").filter({ hasText: "公开影片测试源" }).waitFor({
      state: "attached",
      timeout: 45_000,
    }),
    page.locator(".error-message").waitFor({ state: "visible", timeout: 45_000 }),
  ]);
  const importError = await page.locator(".error-message p").textContent().catch(() => "");
  if (importError) throw new Error(`播放源导入失败：${importError.trim()}`);
  await page.waitForFunction(() => document.querySelector(".source-switcher")?.value === "public_domain_movies");
  await page.screenshot({ path: path.join(artifactDir, "01-source-configured.png"), fullPage: true });

  const searchInput = page.getByPlaceholder("搜索影片、电视剧、综艺");
  await searchInput.fill("大雄兔");
  await searchInput.press("Enter");
  const movieCard = page.locator(".search-grid .poster-card").filter({ hasText: "大雄兔（Big Buck Bunny）" });
  await movieCard.waitFor({ state: "visible", timeout: 45_000 });
  await page.screenshot({ path: path.join(artifactDir, "02-search-result.png"), fullPage: true });

  await movieCard.click();
  await page.locator(".detail-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".line-tabs button").filter({ hasText: "公开 HLS" }).waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(artifactDir, "03-detail.png"), fullPage: true });

  await page.locator(".detail-actions .primary-button").click();
  await page.locator(".embedded-player").waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector(".embedded-player video");
    return video instanceof HTMLVideoElement
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && !video.paused
      && video.currentTime > 0.25;
  }, undefined, { timeout: 90_000 });

  const player = await page.evaluate(() => {
    const video = document.querySelector(".embedded-player video");
    if (!(video instanceof HTMLVideoElement)) throw new Error("内置播放器 video 元素不存在");
    return {
      title: document.querySelector(".player-title strong")?.textContent?.trim() ?? "",
      episode: document.querySelector(".player-title span")?.textContent?.trim() ?? "",
      engineLabel: document.querySelector(".format-chip")?.textContent?.trim() ?? "",
      currentSrc: video.currentSrc,
      readyState: video.readyState,
      paused: video.paused,
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      error: document.querySelector(".player-error-card p")?.textContent?.trim() ?? "",
    };
  });
  await page.screenshot({ path: path.join(artifactDir, "04-playing.png"), fullPage: true });

  const report = {
    auditedAt: new Date().toISOString(),
    status: "passed",
    endpoint,
    configUrl,
    source: "公开影片测试源",
    movie: "大雄兔（Big Buck Bunny）",
    player,
    appLeftOpen: true,
  };
  await fs.writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  let pageState = {};
  if (page) {
    await page.screenshot({ path: path.join(artifactDir, "99-failure.png"), fullPage: true }).catch(() => undefined);
    pageState = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2000),
      error: document.querySelector(".error-message p")?.textContent?.trim() ?? "",
      playerError: document.querySelector(".player-error-card p")?.textContent?.trim() ?? "",
    })).catch(() => ({}));
  }
  await fs.writeFile(path.join(artifactDir, "failure.json"), `${JSON.stringify({
    auditedAt: new Date().toISOString(),
    status: "failed",
    message,
    pageState,
  }, null, 2)}\n`, "utf8");
  console.error(message);
  process.exit(1);
}
