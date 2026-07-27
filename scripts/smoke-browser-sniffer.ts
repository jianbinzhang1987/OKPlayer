import { app } from "electron";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { BrowserSnifferCancelledError, BrowserSnifferService } from "../src/desktop/browser-sniffer-service.ts";

async function main(): Promise<void> {
  await app.whenReady();
  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      response.statusCode = 500;
      response.end("missing address");
      return;
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const url = new URL(request.url ?? "/", origin);

    if (url.pathname === "/watch") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("set-cookie", "sniffer_session=ready; Path=/; HttpOnly");
      response.end(`
        <!doctype html>
        <html><body>
          <script>
            fetch('/master.m3u8?token=smoke').then((response) => response.text()).then(console.log);
          </script>
        </body></html>
      `);
      return;
    }

    if (url.pathname === "/slow") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><html><body>slow page</body></html>");
      return;
    }

    if (url.pathname === "/master.m3u8") {
      response.setHeader("content-type", "application/vnd.apple.mpegurl");
      response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n/video/index.m3u8");
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("嗅探测试服务启动失败");
  const origin = `http://127.0.0.1:${address.port}`;
  const sniffer = new BrowserSnifferService();

  try {
    const result = await sniffer.sniff(`${origin}/watch`, {
      timeoutMs: 8_000,
      settleMs: 300,
      headers: { "User-Agent": "FongMiSnifferSmoke/1.0" },
    });
    assert.equal(result.resolvedBy, "browser-sniffer");
    assert.equal(result.format, "hls");
    assert.match(result.url, /\/master\.m3u8\?token=smoke$/);
    assert.match(result.headers.Cookie ?? result.headers.cookie ?? "", /sniffer_session=ready/);
    assert.equal(result.headers["User-Agent"], "FongMiSnifferSmoke/1.0");

    const controller = new AbortController();
    const cancelled = sniffer.sniff(`${origin}/slow`, {
      timeoutMs: 8_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150).unref();
    await assert.rejects(cancelled, (error: unknown) => error instanceof BrowserSnifferCancelledError);
    const resultPath = process.env.SNIFFER_SMOKE_RESULT;
    if (resultPath) {
      await writeFile(resultPath, JSON.stringify({
        ok: true,
        format: result.format,
        url: result.url,
        cookieForwarded: /sniffer_session=ready/.test(result.headers.Cookie ?? result.headers.cookie ?? ""),
        userAgentForwarded: result.headers["User-Agent"] === "FongMiSnifferSmoke/1.0",
        cancellationVerified: true,
      }, null, 2), "utf8");
    }
  } finally {
    sniffer.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    app.quit();
  }
}

void main().catch(async (error) => {
  const resultPath = process.env.SNIFFER_SMOKE_RESULT;
  if (resultPath) {
    await writeFile(resultPath, JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2), "utf8").catch(() => undefined);
  }
  console.error(error);
  app.exit(1);
});
