import { probeMediaUrl } from "../src/core/media-probe.ts";

interface PublicMediaCase {
  name: string;
  url: string;
  expectedFormat: string;
}

const CASES: PublicMediaCase[] = [
  {
    name: "Mux HLS test stream",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    expectedFormat: "hls",
  },
  {
    name: "DASH-IF Envivio sample",
    url: "https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd",
    expectedFormat: "dash",
  },
  {
    name: "Video.js Oceans MP4",
    url: "https://vjs.zencdn.net/v/oceans.mp4",
    expectedFormat: "mp4",
  },
];

const results: Array<Record<string, unknown>> = [];
for (const testCase of CASES) {
  const startedAt = Date.now();
  try {
    const result = await probeMediaUrl(testCase.url, {
      expectedFormat: testCase.expectedFormat,
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
    });
    results.push({
      name: testCase.name,
      ok: result.ok,
      elapsedMs: Date.now() - startedAt,
      statusCode: result.statusCode,
      format: result.format ?? "",
      mimeType: result.mimeType,
      bytesRead: result.bytesRead,
      reason: result.reason,
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

console.table(results);
const failures = results.filter((result) => result.ok !== true);
console.log(`Public media audit: ${results.length - failures.length} passed, ${failures.length} failed.`);
if (failures.length > 0) process.exitCode = 1;
