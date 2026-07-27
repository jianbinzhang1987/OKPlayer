import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const playwrightModule = process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright";
const { chromium } = await import(playwrightModule);

const root = process.cwd();
const endpoint = process.env.FONGMI_CDP_ENDPOINT ?? "http://127.0.0.1:9223";
const artifactDir = path.join(root, "artifacts", "cross-config-history-e2e");
await fs.rm(artifactDir, { recursive: true, force: true });
await fs.mkdir(artifactDir, { recursive: true });

let page;
try {
  const browser = await chromium.connectOverCDP(endpoint);
  const pages = browser.contexts().flatMap((context) => context.pages());
  page = pages.find((item) => item.url().includes("index.html")) ?? pages[0];
  if (!page) throw new Error("未找到已启动的 FongMi 应用页面");

  await page.bringToFront();
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });
  const initialSource = await page.locator(".source-switcher option:checked").textContent().catch(() => "");

  await page.getByRole("button", { name: "播放历史", exact: true }).click();
  const historyItem = page.locator(".history-item").filter({ hasText: "大雄兔（Big Buck Bunny）" });
  await historyItem.waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: path.join(artifactDir, "01-history-before-switch.png"), fullPage: true });

  await historyItem.locator(".history-open").click();
  await page.locator(".detail-page").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(".detail-copy h1").filter({ hasText: "大雄兔（Big Buck Bunny）" }).waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector(".source-switcher")?.value === "public_domain_movies", undefined, { timeout: 30_000 });
  const error = await page.locator(".error-message p").textContent().catch(() => "");
  if (error) throw new Error(`详情打开后仍有错误：${error.trim()}`);
  await page.screenshot({ path: path.join(artifactDir, "02-restored-detail.png"), fullPage: true });

  await page.locator(".detail-actions .primary-button").click();
  await page.locator(".embedded-player").waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector(".embedded-player video");
    return video instanceof HTMLVideoElement
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && !video.paused
      && video.currentTime > 0.25;
  }, undefined, { timeout: 90_000 });

  const result = await page.evaluate(() => {
    const video = document.querySelector(".embedded-player video");
    return {
      selectedSource: document.querySelector(".source-switcher")?.selectedOptions?.[0]?.textContent?.trim() ?? "",
      title: document.querySelector(".player-title strong")?.textContent?.trim() ?? "",
      readyState: video instanceof HTMLVideoElement ? video.readyState : -1,
      paused: video instanceof HTMLVideoElement ? video.paused : true,
      currentTime: video instanceof HTMLVideoElement ? video.currentTime : 0,
      duration: video instanceof HTMLVideoElement && Number.isFinite(video.duration) ? video.duration : 0,
      error: document.querySelector(".player-error-card p")?.textContent?.trim() ?? "",
    };
  });
  await page.screenshot({ path: path.join(artifactDir, "03-restored-playing.png"), fullPage: true });

  const report = {
    auditedAt: new Date().toISOString(),
    status: "passed",
    initialSource: initialSource?.trim() ?? "",
    restoredSiteKey: "public_domain_movies",
    ...result,
    appLeftOpen: true,
  };
  await fs.writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  let pageState = {};
  if (page) {
    await page.screenshot({ path: path.join(artifactDir, "99-failure.png"), fullPage: true }).catch(() => undefined);
    pageState = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2500),
      error: document.querySelector(".error-message p")?.textContent?.trim() ?? "",
      selectedSource: document.querySelector(".source-switcher")?.selectedOptions?.[0]?.textContent?.trim() ?? "",
    })).catch(() => ({}));
  }
  await fs.writeFile(path.join(artifactDir, "failure.json"), `${JSON.stringify({ auditedAt: new Date().toISOString(), status: "failed", message, pageState }, null, 2)}\n`, "utf8");
  console.error(message);
  process.exit(1);
}
