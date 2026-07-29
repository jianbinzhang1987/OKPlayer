import { execFileSync } from "node:child_process";
import process from "node:process";

const allowUnsigned = process.env.ALLOW_UNSIGNED === "1";
const targetPlatform = ["darwin", "win32", "linux"].includes(process.env.FONGMI_SIGNING_PLATFORM || "")
  ? process.env.FONGMI_SIGNING_PLATFORM
  : process.platform;
const report = targetPlatform === "darwin"
  ? checkMacSigning()
  : targetPlatform === "win32"
    ? checkWindowsSigning()
    : checkLinuxRelease();

const finalReport = {
  checkedAt: new Date().toISOString(),
  platform: targetPlatform,
  allowUnsigned,
  ...report,
  passed: report.ready || allowUnsigned,
};

console.log(JSON.stringify(finalReport, null, 2));

if (!finalReport.passed) {
  console.error(report.failureMessage);
  process.exitCode = 1;
}

function checkMacSigning() {
  const identityOutput = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  const identities = identityOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\)/.test(line));
  const developerIdIdentity = identities.find((line) => line.includes("Developer ID Application"));
  const notarizationModes = {
    apiKey: hasAll("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"),
    appleId: hasAll("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"),
    keychain: hasAll("APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE"),
  };
  const signingReady = Boolean(developerIdIdentity);
  const notarizationReady = Object.values(notarizationModes).some(Boolean);
  return {
    mode: "mac-developer-id",
    ready: signingReady && notarizationReady,
    signingReady,
    developerIdIdentity: developerIdIdentity ?? null,
    validIdentityCount: identities.length,
    notarizationReady,
    notarizationModes,
    failureMessage: "macOS 正式发布需要有效的 Developer ID Application 证书和 Apple 公证凭据；仅生成测试包时可设置 ALLOW_UNSIGNED=1。",
  };
}

function checkWindowsSigning() {
  const certificateLink = firstNonEmpty("WIN_CSC_LINK", "CSC_LINK");
  const certificatePasswordConfigured = Boolean(firstNonEmpty("WIN_CSC_KEY_PASSWORD", "CSC_KEY_PASSWORD"));
  const certificateSubject = firstNonEmpty("WIN_CSC_SUBJECT_NAME", "CSC_NAME");
  const certificateSha1 = firstNonEmpty("WIN_CSC_SHA1");
  const azureTrustedSigning = hasAll(
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_CODE_SIGNING_ENDPOINT",
    "AZURE_CODE_SIGNING_ACCOUNT_NAME",
    "AZURE_CERTIFICATE_PROFILE_NAME",
  );
  const signtoolAvailable = commandAvailable("signtool");
  const certificateReady = Boolean(certificateLink || certificateSubject || certificateSha1);
  return {
    mode: "windows-signtool",
    ready: certificateReady,
    signtoolAvailable,
    certificateReady,
    certificateLinkConfigured: Boolean(certificateLink),
    certificatePasswordConfigured,
    certificateSubjectConfigured: Boolean(certificateSubject),
    certificateSha1Configured: Boolean(certificateSha1),
    azureTrustedSigningDetected: azureTrustedSigning,
    azureTrustedSigningConnected: false,
    signExtensions: [".exe", ".dll", ".node"],
    failureMessage: "Windows 正式发布需要配置 WIN_CSC_LINK/CSC_LINK 或已接通的证书主题方式；当前 Azure Trusted Signing 尚未写入 electron-builder 配置，不能仅凭环境变量判定就绪。仅生成测试包时可设置 ALLOW_UNSIGNED=1。",
  };
}

function checkLinuxRelease() {
  return {
    mode: "linux-integrity",
    ready: true,
    signingRequired: false,
    integrityRequirements: [
      "native-runtime-manifest.json",
      "SHA-256",
      "依赖闭包审计",
      "AppImage/DEB 目标机验证",
    ],
    failureMessage: "Linux 发布完整性检查未通过。",
  };
}

function firstNonEmpty(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function hasAll(...keys) {
  return keys.every((key) => typeof process.env[key] === "string" && process.env[key].trim() !== "");
}

function commandAvailable(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}
