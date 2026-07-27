import { execFileSync } from "node:child_process";
import process from "node:process";

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
const notarizationReady = Object.values(notarizationModes).some(Boolean);
const signingReady = Boolean(developerIdIdentity);
const allowUnsigned = process.env.ALLOW_UNSIGNED === "1";

const report = {
  checkedAt: new Date().toISOString(),
  signingReady,
  developerIdIdentity: developerIdIdentity ?? null,
  validIdentityCount: identities.length,
  notarizationReady,
  notarizationModes,
  allowUnsigned,
  passed: (signingReady && notarizationReady) || allowUnsigned,
};

console.log(JSON.stringify(report, null, 2));

if (!report.passed) {
  console.error(
    "正式发布需要有效的 Developer ID Application 证书，并配置一种 Apple 公证凭据。"
    + " 仅生成本地测试包时可使用 ALLOW_UNSIGNED=1。",
  );
  process.exitCode = 1;
}

function hasAll(...keys) {
  return keys.every((key) => typeof process.env[key] === "string" && process.env[key].trim() !== "");
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}
