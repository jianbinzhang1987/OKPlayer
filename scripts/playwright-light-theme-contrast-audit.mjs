import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE_PATH,
    "playwright",
    path.join(os.homedir(), "Desktop/code/laifu/人力助手/绩效相关/code/PerformanceWorkbench/node_modules/playwright/index.js"),
    path.join(os.homedir(), "Desktop/code/github/eigent-0.0.80/node_modules/playwright/index.js"),
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`未找到可用的 Playwright。可安装 playwright，或设置 PLAYWRIGHT_MODULE_PATH。\n${failures.join("\n")}`);
}

const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;

const root = process.cwd();
const artifactDir = path.join(root, "artifacts", "light-theme-contrast-audit");
await fs.mkdir(artifactDir, { recursive: true });

const executablePath = path.join(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const errors = [];

const app = await electron.launch({
  executablePath,
  args: [path.join(root, "scripts", "playwright-preview-main.cjs")],
  cwd: root,
  env: { ...process.env },
});

const nav = async (page, name) => {
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForTimeout(260);
};

const auditContrast = async (page, label) => {
  const issues = await page.evaluate((label) => {
    const parseRgb = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1].split(/,\s*/).map((part) => Number.parseFloat(part));
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: Number.isFinite(parts[3]) ? parts[3] : 1 };
    };
    const blend = (front, back) => {
      const alpha = Math.min(1, Math.max(0, front.a));
      return {
        r: front.r * alpha + back.r * (1 - alpha),
        g: front.g * alpha + back.g * (1 - alpha),
        b: front.b * alpha + back.b * (1 - alpha),
        a: 1,
      };
    };
    const lum = (color) => {
      const f = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(color.r) + 0.7152 * f(color.g) + 0.0722 * f(color.b);
    };
    const ratio = (a, b) => {
      const l1 = lum(a);
      const l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0.05;
    };
    const bgOf = (element) => {
      const chain = [];
      let cursor = element;
      while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
        chain.unshift(cursor);
        cursor = cursor.parentElement;
      }
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain) {
        const parsed = parseRgb(getComputedStyle(node).backgroundColor);
        if (parsed && parsed.a > 0) bg = blend(parsed, bg);
      }
      return bg;
    };
    const pathOf = (element) => {
      const parts = [];
      let cursor = element;
      while (cursor && cursor !== document.body && parts.length < 6) {
        const tag = cursor.tagName.toLowerCase();
        const classes = [...cursor.classList].slice(0, 5).join(".");
        parts.unshift(classes ? `${tag}.${classes}` : tag);
        cursor = cursor.parentElement;
      }
      return parts.join(" > ");
    };
    const ignore = [
      ".hero:not(.hero-empty)",
      ".detail-hero",
      ".poster-card",
      ".cover-art",
      ".embedded-player",
      ".art-player-host",
      ".danmaku-overlay",
      ".brand-mark",
      "svg",
    ].join(",");
    const elements = [...document.querySelectorAll("body *")]
      .filter((element) => !element.closest(ignore))
      .filter(visible)
      .filter((element) => (element.innerText ?? "").trim().length > 0)
      .filter((element) => ![...element.children].some((child) => (child.innerText ?? "").trim() === (element.innerText ?? "").trim()));

    return elements.map((element) => {
      const style = getComputedStyle(element);
      const fg = parseRgb(style.color);
      if (!fg) return null;
      const bg = bgOf(element);
      const resolvedFg = fg.a < 1 ? blend(fg, bg) : fg;
      const r = ratio(resolvedFg, bg);
      return {
        label,
        text: (element.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
        selector: pathOf(element),
        color: style.color,
        background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        ratio: Number(r.toFixed(2)),
        foregroundLuminance: Number(lum(resolvedFg).toFixed(3)),
        backgroundLuminance: Number(lum(bg).toFixed(3)),
      };
    }).filter(Boolean).filter((item) => item.ratio < 3 || (item.foregroundLuminance > 0.78 && item.backgroundLuminance > 0.78));
  }, label);
  await page.screenshot({ path: path.join(artifactDir, `${label}.png`), fullPage: true });
  return issues;
};

try {
  const page = await app.firstWindow();
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(`console:${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => location.protocol === "http:" || location.protocol === "https:", undefined, { timeout: 12_000 });
  await page.evaluate(() => {
    window.localStorage.setItem("fongmi-preview-setting:themeMode", JSON.stringify("light"));
    window.localStorage.setItem("fongmi-preview-setting:fontSizeMode", JSON.stringify("standard"));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".app-shell.theme-light").waitFor({ state: "visible", timeout: 12_000 });
  await page.locator(".hero").waitFor({ state: "visible", timeout: 12_000 });
  await page.waitForTimeout(700);

  const all = [];
  all.push(...await auditContrast(page, "01-home"));

  await nav(page, "片库");
  await page.locator(".library-page").waitFor({ state: "visible" });
  all.push(...await auditContrast(page, "02-library"));

  await nav(page, "搜索");
  await page.locator(".search-page").waitFor({ state: "visible" });
  await page.locator(".search-command-input input").fill("星际");
  await page.locator(".search-command-input input").press("Enter");
  await page.waitForTimeout(650);
  all.push(...await auditContrast(page, "03-search"));

  const skipped = [];
  await nav(page, "首页");
  const detailEntry = page.locator(".poster-card, .search-result-card").first();
  const canOpenDetail = await detailEntry.isVisible({ timeout: 1_500 }).catch(() => false);
  if (canOpenDetail) {
    await detailEntry.click();
    await page.locator(".detail-page").waitFor({ state: "visible", timeout: 8_000 });
    all.push(...await auditContrast(page, "04-detail"));
  } else {
    skipped.push("04-detail: preview did not expose a poster/search-result entry");
  }

  await nav(page, "收藏");
  all.push(...await auditContrast(page, "05-favorites"));

  await nav(page, "历史");
  all.push(...await auditContrast(page, "06-history"));

  await nav(page, "内容来源");
  await page.locator(".sources-page").waitFor({ state: "visible" });
  all.push(...await auditContrast(page, "07-sources"));

  await nav(page, "账号与网盘");
  await page.locator(".accounts-page").waitFor({ state: "visible" });
  all.push(...await auditContrast(page, "08-accounts"));

  await nav(page, "设置");
  await page.locator(".settings-page").waitFor({ state: "visible" });
  all.push(...await auditContrast(page, "09-settings"));

  const unique = [];
  const seen = new Set();
  for (const item of all) {
    const key = `${item.label}|${item.selector}|${item.text}|${item.color}|${item.background}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const report = { auditedAt: new Date().toISOString(), issueCount: unique.length, issues: unique, skipped, consoleErrors: errors, passed: unique.length === 0 && errors.length === 0 };
  await fs.writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await app.close();
}
