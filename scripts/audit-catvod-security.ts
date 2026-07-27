import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const artifactDir = path.join(root, "artifacts", "catvod-security");
const files = {
  bundle: path.join(root, "src/core/catvod/catvod-bundle-manager.ts"),
  process: path.join(root, "src/desktop/catvod-process-manager.ts"),
  log: path.join(root, "src/desktop/catvod-log-service.ts"),
  logRedaction: path.join(root, "src/core/log-redaction.ts"),
  sourceAdapter: path.join(root, "src/core/source-adapter.ts"),
  catVodClient: path.join(root, "src/core/catvod/catvod-node-client.ts"),
  catOpenAdapter: path.join(root, "src/core/catopen-adapter.ts"),
  cli: path.join(root, "src/cli.ts"),
  main: path.join(root, "src/desktop/main.ts"),
  preload: path.join(root, "src/desktop/preload.ts"),
  bootstrapSource: path.join(root, "src/desktop/catvod-bootstrap.ts"),
  networkAudit: path.join(root, "src/desktop/catvod-network-audit.ts"),
  profileStore: path.join(root, "src/desktop/catvod-profile-store.ts"),
  profileEncryption: path.join(root, "src/desktop/catvod-profile-encryption.ts"),
  registerIpc: path.join(root, "src/desktop/register-ipc.ts"),
  lifecycleReport: path.join(root, "artifacts/catvod-service-lifecycle/report.json"),
  bootstrap: path.join(root, "dist/main/catvod-bootstrap.cjs"),
};

const [bundle, processManager, logService, logRedaction, sourceAdapter, catVodClient, catOpenAdapter, cli, main, preload, bootstrapSource, networkAudit, profileStore, profileEncryption, registerIpc] = await Promise.all([
  readFile(files.bundle, "utf8"),
  readFile(files.process, "utf8"),
  readFile(files.log, "utf8"),
  readFile(files.logRedaction, "utf8"),
  readFile(files.sourceAdapter, "utf8"),
  readFile(files.catVodClient, "utf8"),
  readFile(files.catOpenAdapter, "utf8"),
  readFile(files.cli, "utf8"),
  readFile(files.main, "utf8"),
  readFile(files.preload, "utf8"),
  readFile(files.bootstrapSource, "utf8"),
  readFile(files.networkAudit, "utf8"),
  readFile(files.profileStore, "utf8"),
  readFile(files.profileEncryption, "utf8"),
  readFile(files.registerIpc, "utf8"),
]);
const lifecycleReport = await readJson(files.lifecycleReport);

const checks = [
  check("SEC-001", "MD5 地址仅允许 HTTP/HTTPS", bundle.includes('!["http:", "https:"].includes(url.protocol)') || bundle.includes('["http:", "https:"].includes(url.protocol)')),
  check("SEC-002", "脚本设置最大下载体积", bundle.includes("DEFAULT_MAX_SCRIPT_BYTES") && bundle.includes("32 * 1024 * 1024")),
  check("SEC-003", "同时记录 SHA-256 审计指纹", bundle.includes('digest("sha256"')),
  check("SEC-004", "远程更新仅下载候选版本", bundle.includes("尚未激活") && processManager.includes("smokeTest(manifest.candidate)")),
  check("SEC-005", "候选版本冒烟后才允许激活", processManager.indexOf("smokeTest(manifest.candidate)") < processManager.indexOf("activateCandidate(this.sourceMd5Url)")),
  check("SEC-006", "子进程强制监听 localhost", processManager.includes('env.HOST = "127.0.0.1"') && processManager.includes("http://127.0.0.1")),
  check("SEC-007", "子进程采用环境变量允许清单", processManager.includes('const allowed = [') && !processManager.includes("env: process.env")),
  check("SEC-008", "运行日志统一使用集中式敏感信息脱敏", logService.includes("redactSensitiveText")
    && logRedaction.includes("redactSensitiveText")
    && logRedaction.includes("authorization")
    && logRedaction.includes("cookie")
    && logRedaction.includes("share")
    && sourceAdapter.includes("redactSensitiveText")
    && catVodClient.includes("redactSensitiveText")
    && catOpenAdapter.includes("redactSensitiveValue")
    && cli.includes("redactSensitiveValue")
    && main.includes("redactSensitiveError")
    && bootstrapSource.includes("redactSensitiveError")
    && registerIpc.includes("redactSensitiveText")),
  check("SEC-008A", "脱敏覆盖 URL 凭据、访问密钥和中文分享口令", logRedaction.includes("URL_CREDENTIAL_PATTERN")
    && logRedaction.includes("auth[-_]?key")
    && logRedaction.includes("api[-_]?key")
    && logRedaction.includes("提取码")
    && logRedaction.includes("分享口令")),
  check("SEC-009", "日志按大小滚动并限制保留数量", logService.includes("DEFAULT_CATVOD_LOG_MAX_BYTES") && logService.includes("DEFAULT_CATVOD_LOG_RETENTION") && logService.includes("rotateCatVodLogs")),
  check("SEC-010", "配置中心使用隔离 BrowserWindow", main.includes("contextIsolation: true") && main.includes("nodeIntegration: false") && main.includes("sandbox: true")),
  check("SEC-011", "Renderer IPC 不接受本地脚本路径", !preload.includes("scriptPath") && preload.includes("startCatVod")),
  check("SEC-012", "播放期间禁止重启或切换 CatVod 服务", main.includes("countBySitePrefix(CATVOD_SITE_PREFIX)") && main.includes("请先关闭播放器后再操作服务")),
  check("SEC-013", "Bootstrap 已进入构建产物", await exists(files.bootstrap)),
  check("SEC-014", "启动阶段远程访问只记录 origin", networkAudit.includes("origin: url.origin") && !networkAudit.includes("url.search")),
  check("SEC-015", "远程访问策略支持允许和阻止", bootstrapSource.includes("CATVOD_REMOTE_ACCESS_POLICY") && bootstrapSource.includes("access.blocked") && main.includes("catVodRemoteAccessPolicy")),
  check("SEC-016", "CatVod Profile 使用受保护密文并迁移旧明文", profileStore.includes("catVodProfileEncryptedV1") && profileStore.includes("deleteSetting(LEGACY_PROFILE_KEY)") && !profileStore.includes("setSetting(LEGACY_PROFILE_KEY")),
  check("SEC-017", "Profile 默认使用 AES-256-GCM 且不会主动访问 macOS 钥匙串", profileEncryption.includes('createCipheriv("aes-256-gcm"')
    && profileEncryption.includes("this.useNativeForNewData = options.useNativeForNewData === true")
    && profileEncryption.includes("if (this.useNativeForNewData && this.native.isEncryptionAvailable())")
    && profileEncryption.includes("0o600")
    && main.includes("new CatVodProfileEncryptionProvider(safeStorage")
    && !main.includes("useNativeForNewData: true")),
  check("SEC-018", "Renderer 无法通过通用设置 IPC 读取或覆盖 Profile", registerIpc.includes("assertRendererSettingKey") && registerIpc.includes("isCatVodProtectedSettingKey") && registerIpc.includes("CatVod Profile 仅允许主进程访问")),
  check("SEC-019", "打包应用已验证 Profile 密文、重启恢复和 Renderer 隔离", lifecycleChecksPassed(lifecycleReport, ["BRIDGE-001", "BRIDGE-001A", "BRIDGE-002", "BRIDGE-003"])),
];

const logRoots = [
  path.join(root, "artifacts"),
  path.join(os.homedir(), "Library/Application Support/FongMi Desktop/catvod-node/logs"),
  path.join(os.homedir(), "Library/Application Support/FongMi macOS/catvod-node/logs"),
];
const scannedLogs = [];
for (const logRoot of logRoots) scannedLogs.push(...await collectAuditFiles(logRoot));
const leaks = [];
for (const file of scannedLogs) {
  const content = await readFile(file, "utf8").catch(() => "");
  const matches = findSensitiveValues(content);
  if (matches.length) leaks.push({ file, samples: matches.slice(0, 3).map((value) => redact(value)) });
}
checks.push(check("SEC-020", "现有日志与审计报告未发现明文凭据", leaks.length === 0, JSON.stringify({ scanned: scannedLogs.length, leaks })));

const failed = checks.filter((item) => !item.passed);
const report = {
  auditedAt: new Date().toISOString(),
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks,
  scannedLogs,
  leaks,
};
await mkdir(artifactDir, { recursive: true });
await writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(path.join(artifactDir, "report.md"), renderMarkdown(report), "utf8");
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;

function check(id: string, title: string, passed: boolean, details = ""): { id: string; title: string; passed: boolean; details: string } {
  return { id, title, passed, details };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true).catch(() => false);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function lifecycleChecksPassed(report: unknown, ids: string[]): boolean {
  if (typeof report !== "object" || report === null || !("results" in report)) return false;
  const results = Array.isArray((report as { results?: unknown }).results)
    ? (report as { results: Array<{ id?: unknown; passed?: unknown }> }).results
    : [];
  return ids.every((id) => results.some((item) => item.id === id && item.passed === true));
}

async function collectAuditFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const output: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collectAuditFiles(fullPath));
    else if (entry.isFile() && /(?:\.log(?:\.\d+)?|\.(?:json|md|txt))$/i.test(entry.name)) output.push(fullPath);
  }
  return output;
}

function findSensitiveValues(content: string): string[] {
  const matches: string[] = [];
  const patterns = [
    /(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|token|access[-_]?token|refresh[-_]?token|auth[-_]?key|api[-_]?key|client[-_]?secret|password|passwd|passcode|pwd|account|username|share[-_]?code|share[-_]?pwd|share[-_]?password)\s*[:=]\s*(?:bearer\s+)?["']?([^"'\s,;}&]+)/gi,
    /[?&](?:token|access[-_]?token|refresh[-_]?token|auth[-_]?key|api[-_]?key|password|pwd|share[-_]?code|share[-_]?pwd)=([^&#\s]+)/gi,
    /https?:\/\/([^:/\s]+):([^/@\s]+)@/gi,
    /(?:提取码|分享口令|访问口令|分享码|访问码)\s*[:：=]?\s*([A-Za-z0-9_-]{3,})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      for (const value of match.slice(1)) {
        if (!value || /^(?:\*{3,}|redacted|masked|hidden|null|undefined)$/i.test(value)) continue;
        matches.push(match[0]);
      }
    }
  }
  return [...new Set(matches)];
}

function redact(value: string): string {
  const separator = Math.max(value.indexOf(":"), value.indexOf("="));
  return separator >= 0 ? `${value.slice(0, separator + 1)}***` : "***";
}

function renderMarkdown(report: { auditedAt: string; summary: { total: number; passed: number; failed: number }; checks: Array<{ id: string; title: string; passed: boolean; details: string }> }): string {
  const rows = report.checks.map((item) => `| ${item.id} | ${item.passed ? "通过" : "失败"} | ${item.title} | ${item.details.replace(/\|/g, "\\|").slice(0, 300)} |`);
  return `# CatVod 发布前安全检查\n\n- 时间：${report.auditedAt}\n- 总计：${report.summary.total}\n- 通过：${report.summary.passed}\n- 失败：${report.summary.failed}\n\n| 编号 | 结果 | 检查项 | 详情 |\n|---|---|---|---|\n${rows.join("\n")}\n`;
}
