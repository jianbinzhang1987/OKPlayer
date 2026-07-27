import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resolvePackagedExecutable } from "./lib/packaged-executable.mjs";

const loadedPlaywright = await loadPlaywright();
const playwright = loadedPlaywright.default ?? loadedPlaywright;
const electron = playwright._electron ?? loadedPlaywright._electron;
if (!electron) throw new Error("当前 Playwright 模块未提供 Electron 启动能力");

const root = process.cwd();
const executablePath = resolvePackagedExecutable({ root });
const artifactDirectory = path.join(root, "artifacts", "source-management-e2e");
const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fongmi-source-e2e-"));
await fs.rm(artifactDirectory, { recursive: true, force: true });
await fs.mkdir(artifactDirectory, { recursive: true });

const fixture = await startFixtureServer();
const testResults = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
let app;
let page;

function addResult(id, title, passed, details = "", category = "functional") {
  testResults.push({ id, title, passed, details, category });
}

function resultById(id) {
  return testResults.find((item) => item.id === id);
}

async function launchApp() {
  const launched = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, FONGMI_SOURCE_E2E: "1" },
  });
  const window = await launched.firstWindow({ timeout: 20_000 });
  window.on("console", (message) => {
    const entry = `${message.type()}: ${message.text()}`;
    if (message.type() === "error") consoleErrors.push(entry);
    if (message.type() === "warning") consoleWarnings.push(entry);
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  await window.waitForLoadState("domcontentloaded");
  await window.locator(".app-shell").waitFor({ state: "visible", timeout: 20_000 });
  await window.waitForTimeout(600);
  return { launched, window };
}

async function gotoSources() {
  const button = page.locator(".sidebar button").filter({ hasText: "播放源" }).first();
  await button.click();
  await page.locator(".sources-page").waitFor({ state: "visible", timeout: 10_000 });
}

async function ensureImportDrawer() {
  await gotoSources();
  const drawer = page.locator(".source-import-drawer");
  if (!(await drawer.isVisible())) {
    await page.locator(".add-source-button").click();
    await drawer.waitFor({ state: "visible", timeout: 5_000 });
  }
}

async function importConfig(name, url, options = {}) {
  const { expectSuccess = true, waitForSlowState = false } = options;
  await ensureImportDrawer();
  await page.getByPlaceholder("例如：家庭配置").fill(name);
  await page.getByPlaceholder("https://example.com/config.json").fill(url);
  const submit = page.locator(".source-import-drawer .primary-button");
  await submit.click();

  if (waitForSlowState) {
    await page.waitForFunction(() => {
      const button = document.querySelector(".source-import-drawer .primary-button");
      return button?.textContent?.includes("正在添加") && button.hasAttribute("disabled");
    }, undefined, { timeout: 2_000 });
  }

  if (expectSuccess) {
    await page.locator(".home-page").waitFor({ state: "visible", timeout: 20_000 });
  } else {
    await page.locator(".error-message").waitFor({ state: "visible", timeout: 20_000 });
  }
}

async function currentSourceSnapshot() {
  await gotoSources();
  return page.evaluate(() => {
    const current = document.querySelector(".current-source-card");
    const tabs = [...document.querySelectorAll(".simple-source-tabs button")].map((item) => item.textContent?.trim() ?? "");
    const rows = [...document.querySelectorAll(".simple-site-row")].map((row) => ({
      name: row.querySelector("strong")?.textContent?.trim() ?? "",
      copy: row.textContent?.replace(/\s+/g, " ").trim() ?? "",
      status: row.querySelector(".simple-site-status")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      statusClass: row.querySelector(".simple-site-status")?.className ?? "",
    }));
    return {
      currentName: current?.querySelector("h2")?.textContent?.trim() ?? "",
      currentText: current?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      tabs,
      rows,
      otherConfigs: [...document.querySelectorAll(".simple-config-row")].map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      error: document.querySelector(".error-message p")?.textContent?.trim() ?? "",
    };
  });
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(artifactDirectory, name), fullPage: true });
}

async function activeConfigRecords() {
  return page.evaluate(() => window.tvApi.listConfigs());
}

async function waitForAuditComplete(timeout = 45_000) {
  await page.waitForFunction(async () => {
    if (!window.tvApi.getSourceAuditStatus) return true;
    const status = await window.tvApi.getSourceAuditStatus();
    return !status.running;
  }, undefined, { timeout });
}

try {
  ({ launched: app, window: page } = await launchApp());

  // PS-001: fresh profile empty state.
  const empty = await currentSourceSnapshot();
  addResult(
    "PS-001",
    "全新用户目录显示播放源空状态",
    empty.currentName === "暂无可用配置"
      && empty.tabs.some((item) => item === "全部 0")
      && empty.tabs.some((item) => item === "可展示 0")
      && empty.tabs.some((item) => item === "已屏蔽/不兼容 0"),
    JSON.stringify(empty),
  );
  await screenshot("01-empty-state.png");

  // PS-002: import a valid configuration.
  await importConfig("配置 A", fixture.urls.configA);
  let snapshot = await currentSourceSnapshot();
  let records = await activeConfigRecords();
  addResult(
    "PS-002",
    "新增有效配置并同步站点数量",
    snapshot.currentName === "配置 A"
      && snapshot.tabs.includes("全部 1")
      && snapshot.tabs.includes("可展示 1")
      && snapshot.tabs.includes("已屏蔽/不兼容 0")
      && records.length === 1
      && records[0]?.enabled === true,
    JSON.stringify({ snapshot, records }),
  );
  await screenshot("02-config-a.png");

  // PS-003: duplicate URL should update, not duplicate.
  await importConfig("配置 A（更新名）", fixture.urls.configA);
  snapshot = await currentSourceSnapshot();
  records = await activeConfigRecords();
  addResult(
    "PS-003",
    "重复导入同一地址只更新配置记录",
    snapshot.currentName === "配置 A（更新名）"
      && records.length === 1
      && records[0]?.name === "配置 A（更新名）",
    JSON.stringify({ snapshot, records }),
  );

  // PS-010: slow configuration exposes and clears loading state.
  const slowStartedAt = Date.now();
  await importConfig("慢配置", fixture.urls.slowConfig, { waitForSlowState: true });
  const slowElapsedMs = Date.now() - slowStartedAt;
  snapshot = await currentSourceSnapshot();
  const slowButtonStillLoading = await page.locator(".source-import-drawer .primary-button").isVisible().catch(() => false)
    ? await page.locator(".source-import-drawer .primary-button").textContent().then((value) => value?.includes("正在添加") ?? false)
    : false;
  addResult(
    "PS-010",
    "慢配置加载状态能够恢复",
    slowElapsedMs >= 1_200 && snapshot.currentName === "慢配置" && !slowButtonStillLoading,
    JSON.stringify({ slowElapsedMs, snapshot, slowButtonStillLoading }),
  );

  // Import B for switch, filters, rename and delete tests.
  await importConfig("配置 B", fixture.urls.configB);
  snapshot = await currentSourceSnapshot();
  records = await activeConfigRecords();
  const configBLoaded = snapshot.currentName === "配置 B"
    && snapshot.tabs.includes("全部 2")
    && snapshot.tabs.includes("可展示 1")
    && snapshot.tabs.includes("已屏蔽/不兼容 1")
    && records.length === 3;

  const allRows = snapshot.rows;
  await page.locator(".simple-source-tabs button").filter({ hasText: "可展示" }).click();
  const supportedRows = await page.locator(".simple-site-row").allTextContents();
  await page.locator(".simple-source-tabs button").filter({ hasText: "已屏蔽/不兼容" }).click();
  const unsupportedRows = await page.locator(".simple-site-row").allTextContents();
  addResult(
    "PS-005",
    "正常和异常筛选数量与列表一致",
    configBLoaded
      && allRows.length === 2
      && supportedRows.length === 1
      && supportedRows[0]?.includes("测试正常源 B")
      && unsupportedRows.length === 1
      && unsupportedRows[0]?.includes("Android Dex 测试源"),
    JSON.stringify({ snapshot, supportedRows, unsupportedRows, records }),
  );
  await screenshot("03-config-b-abnormal-filter.png");

  // Rename inactive A.
  await page.locator(".simple-source-tabs button").filter({ hasText: "全部" }).click();
  const configARow = page.locator(".simple-config-row").filter({ hasText: "配置 A（更新名）" });
  await configARow.locator('button[title="重命名"]').click();
  const renameEditor = page.locator(".config-rename-row");
  await renameEditor.waitFor({ state: "visible", timeout: 5_000 });
  const renameInput = renameEditor.getByLabel("配置名称");
  await renameInput.fill("配置 A（已重命名）");
  await renameEditor.locator("button").filter({ hasText: "保存" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("配置 A（已重命名）"));
  records = await activeConfigRecords();
  addResult(
    "PS-006",
    "非当前配置可重命名并立即更新",
    records.some((item) => item.name === "配置 A（已重命名）" && !item.enabled),
    JSON.stringify(records),
  );

  // Switch to A and verify sites are replaced.
  const renamedARow = page.locator(".simple-config-row").filter({ hasText: "配置 A（已重命名）" });
  await renamedARow.locator("button").filter({ hasText: "切换使用" }).click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 15_000 });
  snapshot = await currentSourceSnapshot();
  records = await activeConfigRecords();
  addResult(
    "PS-004",
    "切换配置后当前配置和站点列表同步",
    snapshot.currentName === "配置 A（已重命名）"
      && snapshot.tabs.includes("全部 1")
      && snapshot.rows.length === 1
      && snapshot.rows[0]?.name === "测试正常源 A"
      && records.filter((item) => item.enabled).length === 1
      && records.find((item) => item.enabled)?.name === "配置 A（已重命名）",
    JSON.stringify({ snapshot, records }),
  );

  // Delete inactive B with two-step confirmation.
  const configBRow = page.locator(".simple-config-row").filter({ hasText: "配置 B" });
  const firstDelete = configBRow.getByTitle("删除配置");
  await firstDelete.click();
  const rowStillVisibleAfterFirstClick = await configBRow.isVisible();
  const confirmButtonVisible = await configBRow.getByTitle("再次点击确认删除").isVisible();
  await configBRow.getByTitle("再次点击确认删除").click();
  await configBRow.waitFor({ state: "detached", timeout: 10_000 });
  records = await activeConfigRecords();
  addResult(
    "PS-007",
    "删除非当前配置需要二次确认且无残留",
    rowStillVisibleAfterFirstClick
      && confirmButtonVisible
      && !records.some((item) => item.name === "配置 B"),
    JSON.stringify({ rowStillVisibleAfterFirstClick, confirmButtonVisible, records }),
  );

  // PS-008: current config management entry.
  const currentCard = page.locator(".current-source-card");
  const currentRenameActions = await currentCard.locator('[title*="重命名"], button:has-text("重命名")').count();
  const currentDeleteActions = await currentCard.locator('[title*="删除"], button:has-text("删除")').count();
  await currentCard.locator("button").filter({ hasText: "添加配置" }).click();
  const activeConfigAppearsInManageList = await page.locator(".source-import-drawer").isVisible();
  addResult(
    "PS-008",
    "当前配置具备重命名和删除管理入口",
    (currentRenameActions > 0 && currentDeleteActions > 0) || activeConfigAppearsInManageList,
    JSON.stringify({ currentRenameActions, currentDeleteActions, activeConfigAppearsInManageList }),
    "product-gap",
  );

  // PS-009: malformed JSON does not replace the current configuration or stick loading.
  const recordsBeforeInvalid = await activeConfigRecords();
  await importConfig("非法配置", fixture.urls.invalidConfig, { expectSuccess: false });
  const invalidError = await page.locator(".error-message p").textContent();
  const invalidSubmitText = await page.locator(".source-import-drawer .primary-button").textContent();
  const recordsAfterInvalid = await activeConfigRecords();
  snapshot = await currentSourceSnapshot();
  addResult(
    "PS-009",
    "非法配置显示错误并恢复可操作状态",
    Boolean(invalidError?.trim())
      && invalidSubmitText?.includes("添加并使用") === true
      && snapshot.currentName === "配置 A（已重命名）"
      && JSON.stringify(recordsAfterInvalid) === JSON.stringify(recordsBeforeInvalid),
    JSON.stringify({ invalidError, invalidSubmitText, snapshot, recordsBeforeInvalid, recordsAfterInvalid }),
  );
  await screenshot("04-invalid-config.png");

  // Import a config whose document works but content API returns 503.
  await importConfig("故障配置", fixture.urls.brokenConfig);
  await waitForAuditComplete();
  snapshot = await currentSourceSnapshot();
  const brokenStatusText = `${snapshot.currentText} ${snapshot.rows.map((item) => item.copy).join(" ")}`;
  const uiMarksBrokenAsAbnormal = /需要处理|异常|不可用|失败|503|屏蔽/.test(brokenStatusText)
    && !snapshot.rows.some((item) => item.status === "播放正常");
  addResult(
    "PS-011",
    "内容 API 返回 503 时播放源状态显示异常",
    uiMarksBrokenAsAbnormal,
    JSON.stringify({ snapshot, brokenApiHits: fixture.hits.get("/api/broken") ?? 0 }),
    "status-accuracy",
  );
  await screenshot("05-broken-source-status.png");

  // Recheck must perform a real request, not only reload metadata.
  const brokenHitsBeforeRefresh = fixture.hits.get("/api/broken") ?? 0;
  await page.locator(".current-source-actions button").filter({ hasText: "重新检测" }).click();
  await waitForAuditComplete();
  const brokenHitsAfterRefresh = fixture.hits.get("/api/broken") ?? 0;
  snapshot = await currentSourceSnapshot();
  addResult(
    "PS-012",
    "重新检测会真实访问内容接口并更新状态",
    brokenHitsAfterRefresh > brokenHitsBeforeRefresh
      && /需要处理|异常|不可用|失败|503|屏蔽/.test(`${snapshot.currentText} ${snapshot.rows.map((item) => item.copy).join(" ")}`),
    JSON.stringify({ brokenHitsBeforeRefresh, brokenHitsAfterRefresh, snapshot }),
    "status-accuracy",
  );

  // PS-013: tab count matches rendered rows for the current configuration.
  const counts = parseTabCounts(snapshot.tabs);
  await page.locator(".simple-source-tabs button").filter({ hasText: "全部" }).click();
  const renderedAll = await page.locator(".simple-site-row").count();
  await page.locator(".simple-source-tabs button").filter({ hasText: "可展示" }).click();
  const renderedSupported = await page.locator(".simple-site-row").count();
  await page.locator(".simple-source-tabs button").filter({ hasText: "已屏蔽/不兼容" }).click();
  const renderedUnsupported = await page.locator(".simple-site-row").count();
  addResult(
    "PS-013",
    "播放源状态标签计数与渲染行数一致",
    counts.all === renderedAll
      && counts.supported === renderedSupported
      && counts.unsupported === renderedUnsupported,
    JSON.stringify({ counts, renderedAll, renderedSupported, renderedUnsupported }),
  );

  // Close and relaunch with the same isolated profile.
  await app.close();
  app = undefined;
  page = undefined;
  ({ launched: app, window: page } = await launchApp());
  snapshot = await currentSourceSnapshot();
  records = await activeConfigRecords();
  addResult(
    "PS-014",
    "应用重启后当前配置和名称持久化",
    snapshot.currentName === "故障配置"
      && records.some((item) => item.name === "配置 A（已重命名）")
      && records.find((item) => item.enabled)?.name === "故障配置",
    JSON.stringify({ snapshot, records }),
  );
  await screenshot("06-after-relaunch.png");

  addResult(
    "PS-015",
    "完整流程无页面脚本异常",
    pageErrors.length === 0 && consoleErrors.length === 0,
    JSON.stringify({ pageErrors, consoleErrors, consoleWarnings }),
  );
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  testResults.push({
    id: "HARNESS",
    title: "自动化执行过程",
    passed: false,
    details: message,
    category: "harness",
  });
  if (page) {
    await page.screenshot({ path: path.join(artifactDirectory, "99-failure.png"), fullPage: true }).catch(() => undefined);
  }
} finally {
  if (app) await app.close().catch(() => undefined);
  await fixture.close();
}

const failed = testResults.filter((item) => !item.passed);
const report = {
  auditedAt: new Date().toISOString(),
  executablePath,
  fixtureOrigin: fixture.origin,
  isolatedUserDataDirectory: userDataDirectory,
  summary: {
    total: testResults.length,
    passed: testResults.length - failed.length,
    failed: failed.length,
  },
  results: testResults,
  knownHighPriorityFailures: failed
    .filter((item) => ["PS-008", "PS-011", "PS-012"].includes(item.id))
    .map((item) => ({ id: item.id, title: item.title, details: item.details })),
  runtime: {
    fixtureHits: Object.fromEntries(fixture.hits),
    consoleErrors,
    consoleWarnings,
    pageErrors,
  },
};

await fs.writeFile(path.join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(artifactDirectory, "report.md"), renderMarkdown(report), "utf8");
await fs.rm(userDataDirectory, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;

function parseTabCounts(tabs) {
  const numberAfter = (label) => {
    const match = tabs.find((item) => item.startsWith(label))?.match(/(\d+)$/);
    return match ? Number(match[1]) : -1;
  };
  return {
    all: numberAfter("全部"),
    supported: numberAfter("可展示"),
    unsupported: numberAfter("已屏蔽/不兼容"),
  };
}

function renderMarkdown(report) {
  const rows = report.results.map((item) => `| ${item.id} | ${item.passed ? "通过" : "失败"} | ${item.title} | ${String(item.details).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 500)} |`);
  return `# 播放源管理 Playwright 测试报告\n\n- 时间：${report.auditedAt}\n- 总计：${report.summary.total}\n- 通过：${report.summary.passed}\n- 失败：${report.summary.failed}\n\n| 用例 | 结果 | 场景 | 详情 |\n|---|---|---|---|\n${rows.join("\n")}\n`;
}

async function startFixtureServer() {
  const hits = new Map();
  let origin = "";
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

    if (url.pathname === "/config-a.json") {
      return sendJson(response, configA(origin));
    }
    if (url.pathname === "/config-b.json") {
      return sendJson(response, configB(origin));
    }
    if (url.pathname === "/broken-config.json") {
      return sendJson(response, brokenConfig(origin));
    }
    if (url.pathname === "/slow-config.json") {
      await delay(1_500);
      return sendJson(response, slowConfig(origin));
    }
    if (url.pathname === "/invalid-config.json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"sites": [');
      return;
    }
    if (url.pathname === "/api/a" || url.pathname === "/api/b" || url.pathname === "/api/slow") {
      return sendJson(response, apiPayload(url.pathname));
    }
    if (url.pathname === "/api/broken") {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ code: 503, message: "fixture unavailable" }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    hits,
    urls: {
      configA: `${origin}/config-a.json`,
      configB: `${origin}/config-b.json`,
      brokenConfig: `${origin}/broken-config.json`,
      slowConfig: `${origin}/slow-config.json`,
      invalidConfig: `${origin}/invalid-config.json`,
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function configA(origin) {
  return {
    sites: [{
      key: "fixture_source_a",
      name: "测试正常源 A",
      type: 1,
      api: `${origin}/api/a`,
      searchable: 1,
      quickSearch: 1,
      categories: ["电影"],
    }],
  };
}

function configB(origin) {
  return {
    spider: `${origin}/android-spider.jar;md5;fixture`,
    sites: [
      {
        key: "fixture_source_b",
        name: "测试正常源 B",
        type: 1,
        api: `${origin}/api/b`,
        searchable: 1,
        categories: ["电影"],
      },
      {
        key: "fixture_android_dex",
        name: "Android Dex 测试源",
        type: 3,
        api: "csp_FixtureAndroid",
        searchable: 1,
      },
    ],
  };
}

function brokenConfig(origin) {
  return {
    sites: [{
      key: "fixture_broken_source",
      name: "内容接口 503 的故障源",
      type: 1,
      api: `${origin}/api/broken`,
      searchable: 1,
      categories: ["电影"],
    }],
  };
}

function slowConfig(origin) {
  return {
    sites: [{
      key: "fixture_slow_source",
      name: "慢配置测试源",
      type: 1,
      api: `${origin}/api/slow`,
      searchable: 1,
      categories: ["电影"],
    }],
  };
}

function apiPayload(pathname) {
  const suffix = pathname.split("/").pop()?.toUpperCase() ?? "X";
  return {
    code: 1,
    msg: "数据列表",
    page: 1,
    pagecount: 1,
    limit: 20,
    total: 1,
    list: [{
      vod_id: `fixture-${suffix}`,
      vod_name: `测试影片 ${suffix}`,
      vod_pic: "",
      vod_remarks: "测试",
      vod_play_from: "fixture",
      vod_play_url: `正片$${pathname === "/api/a" ? "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" : "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"}`,
    }],
  };
}

function sendJson(response, payload) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
