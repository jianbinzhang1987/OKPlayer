import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveError, redactSensitiveText, redactSensitiveValue } from "../src/core/log-redaction.ts";

test("log redaction removes headers JSON query credentials and Chinese share codes", () => {
  const input = [
    "Authorization: Bearer authorization-secret",
    "Cookie=session=private-cookie; uid=123",
    'payload={"access_token":"json-token","password":"json-password","share_code":"share-secret"}',
    "https://user-name:user-password@example.com/play?auth_key=query-auth&pwd=abcd&x=1",
    "提取码：qwer 分享口令 zxcv",
  ].join("\n");

  const result = redactSensitiveText(input);
  for (const secret of [
    "authorization-secret",
    "private-cookie",
    "json-token",
    "json-password",
    "share-secret",
    "user-name",
    "user-password",
    "query-auth",
    "abcd",
    "qwer",
    "zxcv",
  ]) {
    assert.equal(result.includes(secret), false, `secret leaked: ${secret}`);
  }
  assert.match(result, /Authorization:\s*\*\*\*/i);
  assert.match(result, /Cookie=\*\*\*/i);
  assert.match(result, /access_token":"\*\*\*/i);
  assert.match(result, /[?&]auth_key=\*\*\*/i);
  assert.match(result, /提取码：\*\*\*/);
});

test("structured values and error stacks are redacted without mutating the input", () => {
  const input = {
    url: "https://example.com/play?token=url-token",
    headers: { Cookie: "cookie-secret", Referer: "https://example.com" },
    nested: [{ password: "password-secret", message: "分享口令：share-secret" }],
  };
  const result = redactSensitiveValue(input);
  assert.equal(input.headers.Cookie, "cookie-secret");
  assert.equal(result.headers.Cookie, "***");
  assert.equal(result.url.includes("url-token"), false);
  assert.equal(result.nested[0]?.password, "***");
  assert.equal(result.nested[0]?.message.includes("share-secret"), false);

  const error = new Error("request failed https://example.com/?access_token=stack-token");
  assert.equal(redactSensitiveError(error).includes("stack-token"), false);
});
