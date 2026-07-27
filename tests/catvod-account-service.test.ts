import assert from "node:assert/strict";
import test from "node:test";
import { CatVodAccountService, validateLoopbackBaseUrl, type CatVodAccountFetch } from "../src/desktop/catvod-account-service.ts";

const QR_IMAGE = `data:image/png;base64,${Buffer.from("qr-image").toString("base64")}`;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("CatVod account status exposes only normalized Quark login state", async () => {
  const calls: string[] = [];
  const fetchImpl: CatVodAccountFetch = async (input) => {
    calls.push(input);
    return jsonResponse({
      code: 0,
      data: {
        providers: {
          quark: {
            configured: true,
            login: true,
            state: "已登录 SUPER_VIP",
            label: "夸克 Cookie",
            cookie: "must-not-leak",
          },
        },
      },
    });
  };
  const service = new CatVodAccountService(() => "http://127.0.0.1:9988", fetchImpl);
  const status = await service.status("quark");

  assert.equal(calls[0], "http://127.0.0.1:9988/website/api/status");
  assert.deepEqual(Object.keys(status).sort(), ["accountState", "checkedAt", "configured", "credentialMode", "label", "login", "name", "provider", "state"]);
  assert.equal(status.login, true);
  assert.equal(status.accountState, "connected");
  assert.equal(status.credentialMode, "cookie");
  assert.equal(status.state, "已登录 SUPER_VIP");
  assert.equal("cookie" in status, false);
});

test("CatVod account statuses normalize all first-stage pan providers with one request", async () => {
  let requestCount = 0;
  const service = new CatVodAccountService(
    () => "http://127.0.0.1:9988",
    async () => {
      requestCount += 1;
      return jsonResponse({
        code: 0,
        data: {
          providers: {
            quark: { configured: true, login: true, state: "已登录", label: "夸克 Cookie" },
            uc: { configured: true, login: false, state: "TV Token 待刷新", label: "UC Cookie / TV Token" },
            baidu: { configured: false, login: false, state: "未配置", label: "百度 Cookie" },
            pan115: { configured: false, login: false, state: "未配置", label: "Cookie 或扫码登录" },
            pan189: { configured: false, login: false, state: "未配置", label: "扫码登录 / Cookie / 账号密码" },
            pan139: { configured: false, login: false, state: "未配置", label: "扫码登录 / Cookie" },
          },
        },
      });
    },
  );

  const statuses = await service.statuses();
  assert.equal(requestCount, 1);
  assert.deepEqual(statuses.map((status) => status.provider), ["quark", "uc", "baidu", "pan115", "pan189", "pan139"]);
  assert.equal(statuses.find((status) => status.provider === "uc")?.name, "UC 网盘");
  assert.equal(statuses.find((status) => status.provider === "uc")?.configured, true);
  assert.equal(statuses.find((status) => status.provider === "uc")?.login, false);
  assert.equal(statuses.find((status) => status.provider === "uc")?.accountState, "expired");
  assert.equal(statuses.find((status) => status.provider === "uc")?.credentialMode, "tv-token");
  assert.equal(statuses.find((status) => status.provider === "baidu")?.accountState, "not-configured");
});

test("CatVod account login starts polls and cancels through fixed local endpoints", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let startIndex = 0;
  const fetchImpl: CatVodAccountFetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input, body });
    if (input.endsWith("/login/start")) {
      startIndex += 1;
      return jsonResponse({ code: 0, taskId: `task_quark_${startIndex}23`, status: "waiting", msg: "等待扫码", qrImage: QR_IMAGE });
    }
    if (input.endsWith("/login/poll")) {
      return jsonResponse({ code: 0, terminal: true, status: "success", msg: "登录成功" });
    }
    return jsonResponse({ code: 0, msg: "已取消登录" });
  };
  const service = new CatVodAccountService(() => "http://localhost:9988/", fetchImpl);

  const first = await service.start("quark");
  assert.equal(first.qrImage, QR_IMAGE);
  const polled = await service.poll("quark", first.taskId!);
  assert.equal(polled.status, "success");
  assert.equal(polled.terminal, true);
  await assert.rejects(service.cancel(first.taskId!), /不存在或已结束/);

  const second = await service.start("quark");
  const cancelled = await service.cancel(second.taskId!);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(service.activeTaskCount(), 0);

  assert.deepEqual(calls.map((call) => call.url), [
    "http://localhost:9988/website/api/login/start",
    "http://localhost:9988/website/api/login/poll",
    "http://localhost:9988/website/api/login/start",
    "http://localhost:9988/website/api/login/cancel",
  ]);
  assert.deepEqual(calls[0]?.body, { provider: "quark" });
  assert.deepEqual(calls[1]?.body, { provider: "quark", taskId: first.taskId });
  assert.deepEqual(calls[3]?.body, { taskId: second.taskId });
});

test("CatVod account service clears a provider credential through the local account API", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const service = new CatVodAccountService(
    () => "http://127.0.0.1:9988",
    async (input, init) => {
      calls.push({ url: input, body: JSON.parse(String(init?.body ?? "{}")) });
      return jsonResponse({ code: 0, msg: "已清除" });
    },
  );

  const cleared = await service.clear("uc");
  assert.equal(cleared.provider, "uc");
  assert.equal(cleared.configured, false);
  assert.equal(cleared.login, false);
  assert.equal(cleared.accountState, "not-configured");
  assert.equal(cleared.credentialMode, "unknown");
  assert.equal(cleared.state, "已清除凭据");
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:9988/website/api/account/clear", body: { provider: "uc" } }]);
});

test("CatVod account service isolates concurrent providers and rejects mismatched polling", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const service = new CatVodAccountService(
    () => "http://127.0.0.1:9988",
    async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: input, body });
      if (input.endsWith("/login/start")) {
        const provider = String(body.provider);
        return jsonResponse({ code: 0, taskId: `task_${provider}_123`, status: "waiting", qrImage: QR_IMAGE });
      }
      if (input.endsWith("/login/poll")) return jsonResponse({ code: 0, status: "waiting", msg: "等待扫码" });
      return jsonResponse({ code: 0, msg: "已取消" });
    },
  );

  const quark = await service.start("quark");
  const baidu = await service.start("baidu");
  assert.equal(service.activeTaskCount(), 2);

  const callCountBeforeMismatch = calls.length;
  await assert.rejects(service.poll("baidu", quark.taskId!), /不匹配/);
  assert.equal(calls.length, callCountBeforeMismatch);

  const quarkCancelled = await service.cancel(quark.taskId!);
  assert.equal(quarkCancelled.provider, "quark");
  assert.equal(service.activeTaskCount(), 1);
  const baiduWaiting = await service.poll("baidu", baidu.taskId!);
  assert.equal(baiduWaiting.status, "waiting");
  assert.equal(service.activeTaskCount(), 1);
});

test("CatVod account service replaces only the previous task of the same login provider", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let taskIndex = 0;
  const service = new CatVodAccountService(
    () => "http://127.0.0.1:9988",
    async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: input, body });
      if (input.endsWith("/login/start")) {
        taskIndex += 1;
        return jsonResponse({ code: 0, taskId: `task_quark_${taskIndex}23`, status: "waiting", qrImage: QR_IMAGE });
      }
      return jsonResponse({ code: 0, msg: "已取消" });
    },
  );

  const first = await service.start("quark");
  const second = await service.start("quark");
  assert.notEqual(first.taskId, second.taskId);
  assert.equal(service.activeTaskCount(), 1);
  assert.ok(calls.some((call) => call.url.endsWith("/login/cancel") && call.body.taskId === first.taskId));
  await assert.rejects(service.poll("quark", first.taskId!), /不存在或已结束/);
});

test("CatVod account task cleanup never clears persisted provider credentials", async () => {
  const endpoints: string[] = [];
  const service = new CatVodAccountService(
    () => "http://127.0.0.1:9988",
    async (input, init) => {
      endpoints.push(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (input.endsWith("/login/start")) return jsonResponse({ code: 0, taskId: `task_${body.provider}_123`, status: "waiting", qrImage: QR_IMAGE });
      return jsonResponse({ code: 0, msg: "已取消" });
    },
  );

  await service.start("quark");
  await service.start("baidu");
  await service.cancelAll();
  assert.equal(service.activeTaskCount(), 0);
  assert.equal(endpoints.some((endpoint) => endpoint.endsWith("/account/clear")), false);
  await assert.rejects(service.cancel("task_unknown_123"), /不存在或已结束/);
});

test("CatVod account service accepts UC login modes and rejects unknown providers", async () => {
  const providers: string[] = [];
  const service = new CatVodAccountService(
    () => "http://127.0.0.1:9988",
    async (_input, init) => {
      const provider = JSON.parse(String(init?.body ?? "{}"))?.provider;
      if (provider) providers.push(provider);
      return jsonResponse({ code: 0, taskId: `task_${provider}_123`, status: "waiting", qrImage: QR_IMAGE });
    },
  );

  assert.equal((await service.start("ucCookie")).provider, "ucCookie");
  assert.equal((await service.start("ucToken")).provider, "ucToken");
  assert.deepEqual(providers, ["ucCookie", "ucToken"]);
  await assert.rejects(service.start("unknown" as never), /暂不支持/);
});

test("CatVod account service rejects remote services invalid tasks and oversized QR data", async () => {
  assert.throws(() => validateLoopbackBaseUrl("https://127.0.0.1:9988"), /本机 HTTP/);
  assert.throws(() => validateLoopbackBaseUrl("http://example.com:9988"), /本机服务/);
  assert.throws(() => validateLoopbackBaseUrl("http://user:pass@127.0.0.1:9988"), /不允许包含凭据/);

  const service = new CatVodAccountService(
    () => "http://127.0.0.1:9988",
    async () => jsonResponse({ code: 0, taskId: "short", status: "waiting", qrImage: QR_IMAGE }),
  );
  await assert.rejects(service.start("quark"), /有效登录任务/);
  await assert.rejects(service.poll("quark", "../bad"), /任务标识无效/);
});

test("CatVod account service normalizes expired and error login states", async () => {
  let pollResponse: Record<string, unknown> = { code: 0, terminal: true, status: "expired", msg: "二维码已过期" };
  const service = new CatVodAccountService(
    () => "http://[::1]:9988",
    async (input, init) => {
      if (input.endsWith("/login/start")) {
        const provider = JSON.parse(String(init?.body ?? "{}"))?.provider;
        return jsonResponse({ code: 0, taskId: `task_${provider}_123`, status: "waiting", qrImage: QR_IMAGE });
      }
      return jsonResponse(pollResponse);
    },
  );
  const first = await service.start("quark");
  const expired = await service.poll("quark", first.taskId!);
  assert.equal(expired.status, "expired");
  assert.equal(expired.terminal, true);
  await assert.rejects(service.poll("quark", first.taskId!), /不存在或已结束/);

  const second = await service.start("baidu");
  pollResponse = { code: 1, terminal: true, status: "error", msg: "任务不存在" };
  await assert.rejects(service.poll("baidu", second.taskId!), /任务不存在/);
});
