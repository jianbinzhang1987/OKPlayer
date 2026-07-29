import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts", "check-signing-environment.mjs");
const signingKeys = [
  "ALLOW_UNSIGNED",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
  "WIN_CSC_LINK",
  "CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "CSC_KEY_PASSWORD",
  "WIN_CSC_SUBJECT_NAME",
  "CSC_NAME",
  "WIN_CSC_SHA1",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "AZURE_CERTIFICATE_PROFILE_NAME",
] as const;

function runPreflight(platform: "darwin" | "win32" | "linux", values: Record<string, string> = {}) {
  const env = { ...process.env, FONGMI_SIGNING_PLATFORM: platform } as Record<string, string | undefined>;
  for (const key of signingKeys) delete env[key];
  Object.assign(env, values);
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const report = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
  return { result, report };
}

test("Linux release preflight uses integrity checks without requiring a signing certificate", () => {
  const { result, report } = runPreflight("linux");
  assert.equal(result.status, 0);
  assert.equal(report.platform, "linux");
  assert.equal(report.mode, "linux-integrity");
  assert.equal(report.passed, true);
  assert.equal(report.signingRequired, false);
});

test("Windows release preflight rejects an unsigned formal release", () => {
  const { result, report } = runPreflight("win32");
  assert.equal(result.status, 1);
  assert.equal(report.platform, "win32");
  assert.equal(report.passed, false);
  assert.equal(report.certificateReady, false);
});

test("Windows release preflight accepts a configured certificate source", () => {
  const { result, report } = runPreflight("win32", {
    WIN_CSC_LINK: "C:\\secure\\fongmi-release.pfx",
    WIN_CSC_KEY_PASSWORD: "test-only-password",
  });
  assert.equal(result.status, 0);
  assert.equal(report.passed, true);
  assert.equal(report.certificateLinkConfigured, true);
  assert.equal(report.signExtensions instanceof Array, true);
});

test("Windows preflight does not claim Azure Trusted Signing before builder integration exists", () => {
  const { result, report } = runPreflight("win32", {
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "secret",
    AZURE_CODE_SIGNING_ENDPOINT: "https://example.invalid",
    AZURE_CODE_SIGNING_ACCOUNT_NAME: "account",
    AZURE_CERTIFICATE_PROFILE_NAME: "profile",
  });
  assert.equal(result.status, 1);
  assert.equal(report.azureTrustedSigningDetected, true);
  assert.equal(report.azureTrustedSigningConnected, false);
  assert.equal(report.passed, false);
});

test("macOS local test packages can explicitly opt into unsigned mode", () => {
  const { result, report } = runPreflight("darwin", { ALLOW_UNSIGNED: "1" });
  assert.equal(result.status, 0);
  assert.equal(report.platform, "darwin");
  assert.equal(report.allowUnsigned, true);
  assert.equal(report.passed, true);
});
