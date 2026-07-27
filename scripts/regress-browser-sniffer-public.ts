import { app } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { BrowserSnifferService } from "../src/desktop/browser-sniffer-service.ts";

interface PublicSniffCase {
  name: string;
  pageUrl: string;
  expectedFormat: "hls" | "dash" | "mp4";
  expectedUrl: RegExp;
  timeoutMs?: number;
}

const CASES: PublicSniffCase[] = [
  {
    name: "hls.js official demo",
    pageUrl: "https://hlsjs.video-dev.org/demo/?src=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8",
    expectedFormat: "hls",
    expectedUrl: /\.m3u8(?:$|[?#])/i,
    timeoutMs: 30_000,
  },
  {
    name: "DASH-IF reference player",
    pageUrl: "https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html?url=https%3A%2F%2Fdash.akamaized.net%2Fenvivio%2FEnvivioDash3%2Fmanifest.mpd",
    expectedFormat: "dash",
    expectedUrl: /\.mpd(?:$|[?#])/i,
    timeoutMs: 30_000,
  },
  {
    name: "Video.js HLS demo",
    pageUrl: "https://videojs.github.io/videojs-contrib-hls/",
    expectedFormat: "hls",
    expectedUrl: /\.m3u8(?:$|[?#])/i,
    timeoutMs: 30_000,
  },
];

async function main(): Promise<void> {
  await app.whenReady();
  const sniffer = new BrowserSnifferService();
  const results: Array<Record<string, unknown>> = [];

  try {
    for (const testCase of CASES) {
      const startedAt = Date.now();
      try {
        const media = await sniffer.sniff(testCase.pageUrl, {
          timeoutMs: testCase.timeoutMs,
          settleMs: 1_500,
        });
        assert.equal(media.format, testCase.expectedFormat);
        assert.match(media.url, testCase.expectedUrl);
        results.push({
          name: testCase.name,
          ok: true,
          elapsedMs: Date.now() - startedAt,
          format: media.format,
          url: media.url,
        });
      } catch (error) {
        results.push({
          name: testCase.name,
          ok: false,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    sniffer.close();
  }

  const failures = results.filter((result) => result.ok !== true);
  const resultPath = process.env.SNIFFER_REGRESSION_RESULT;
  if (resultPath) {
    await writeFile(resultPath, JSON.stringify({
      commitDate: new Date().toISOString(),
      passed: results.length - failures.length,
      failed: failures.length,
      results,
    }, null, 2), "utf8");
  }
  app.exit(failures.length > 0 ? 1 : 0);
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
