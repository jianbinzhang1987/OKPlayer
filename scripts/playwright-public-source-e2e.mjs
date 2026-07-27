import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const playwrightModule = process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright";
const { _electron: electron } = await import(playwrightModule);

const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root, explicit: process.env.FONGMI_APP_EXECUTABLE });
const configUrl = process.env.FONGMI_TEST_CONFIG_URL
  ?? "http://127.0.0.1:4179/@fs/Users/adolf/Desktop/code/TV/mac/public/public-domain-config.json";
const artifactDir = path.join(root, "artifacts", "public-source-e2e");
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-public-source-e2e-"));
const errors = [];
const warnings = [];

await fs.rm(artifactDir, { recursive: true, force: true });
await fs.mkdir(artifactDir, { recursive: true });

let page;
const app = await electron.launch({
  executablePath,
  args: [
    "--no-default-browser-check",
    `--user-data-dir=${path.join(temporaryHome, "profile")}`,
  ],
  cwd: root,
  env: {
    ...process.env,
    HOME: temporaryHome,
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

try {
  page = await app.firstWindow({ timeout: 30_000 });
  page.on("console", (message) => {
    const entry = `${message.type()}: ${message.text()}`;
    if (message.type() === "error") errors.push(entry);
    if (message.type() === "warning") warnings.push(entry);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (failure === "net::ERR_ABORTED") return;
    errors.push(`requestfailed: ${request.url()} ${failure}`);
  });

  await page.waitForLoadState("domcontentloaded");
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
  if (importError) {
    await page.screenshot({ path: path.join(artifactDir, "00-import-error.png"), fullPage: true });
    throw new Error(`播放源导入失败：${importError.trim()}`);
  }
  await page.waitForFunction(() => document.querySelector(".source-switcher")?.value === "public_domain_movies");
  await page.screenshot({ path: path.join(artifactDir, "01-source-configured.png"), fullPage: true });

  const searchInput = page.getByPlaceholder("搜索影片、电视剧、综艺");
  await searchInput.fill("大雄兔");
  await searchInput.press("Enter");
  await page.locator(".search-grid .poster-card").filter({ hasText: "大雄兔（Big Buck Bunny）" }).waitFor({
    state: "visible",
    timeout: 45_000,
  });
  await page.getByText("共找到 1 个结果", { exact: false }).waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(artifactDir, "02-search-result.png"), fullPage: true });

  await page.locator(".search-grid .poster-card").filter({ hasText: "大雄兔（Big Buck Bunny）" }).click();
  await page.locator(".detail-page").waitFor({ state: "visible", timeout: 30_000 });
  const primaryPlayButton = page.locator(".detail-actions .primary-button");
  await primaryPlayButton.waitFor({ state: "visible" });
  await page.locator(".line-tabs button").filter({ hasText: "公开 HLS" }).waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(artifactDir, "03-detail.png"), fullPage: true });

  await primaryPlayButton.click();
  await page.locator(".embedded-player").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(".embedded-player video").waitFor({ state: "attached" });

  await page.evaluate(async () => {
    const video = document.querySelector(".embedded-player video");
    if (!(video instanceof HTMLVideoElement)) throw new Error("内置播放器 video 元素不存在");
    try {
      await video.play();
    } catch {
      // The real button click above normally provides the user gesture. The wait below reports any actual failure.
    }
  });

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

  const source = await page.locator(".source-switcher option:checked").textContent();
  const report = {
    auditedAt: new Date().toISOString(),
    executablePath,
    configUrl,
    source: source?.trim() ?? "",
    movie: "大雄兔（Big Buck Bunny）",
    player,
    consoleErrors: errors,
    consoleWarnings: warnings,
    screenshots: [
      "01-source-configured.png",
      "02-search-result.png",
      "03-detail.png",
      "04-playing.png",
    ],
    passed:
      source?.includes("公开影片测试源") === true
      && player.title.includes("大雄兔")
      && player.episode === "正片"
      && player.engineLabel.includes("HLS")
      && player.readyState >= 2
      && player.paused === false
      && player.currentTime > 0.25
      && player.duration > 0
      && player.error === ""
      && errors.length === 0,
  };

  await fs.writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  let pageState = {};
  if (page) {
    await page.screenshot({ path: path.join(artifactDir, "99-failure.png"), fullPage: true }).catch(() => undefined);
    pageState = await page.evaluate(() => {
      const video = document.querySelector(".embedded-player video");
      return {
        bodyText: document.body.innerText.slice(0, 2000),
        playerVisible: document.querySelector(".embedded-player") !== null,
        playerStatus: document.querySelector(".player-status")?.textContent?.trim() ?? "",
        playerError: document.querySelector(".player-error-card p")?.textContent?.trim() ?? "",
        video: video instanceof HTMLVideoElement ? {
          currentSrc: video.currentSrc,
          readyState: video.readyState,
          networkState: video.networkState,
          paused: video.paused,
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          mediaErrorCode: video.error?.code ?? 0,
          mediaErrorMessage: video.error?.message ?? "",
        } : null,
      };
    }).catch(() => ({}));
  }
  const failure = {
    auditedAt: new Date().toISOString(),
    status: "failed",
    message,
    configUrl,
    pageState,
    consoleErrors: errors,
    consoleWarnings: warnings,
  };
  await fs.writeFile(path.join(artifactDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
  console.error(message);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
  await fs.rm(temporaryHome, { recursive: true, force: true });
}
