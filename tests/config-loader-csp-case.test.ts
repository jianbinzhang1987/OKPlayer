import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadVodConfig } from "../src/core/config-loader.ts";

 test("config loader preserves uppercase CSP api names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fongmi-config-"));
  const file = join(directory, "config.json");
  await writeFile(file, JSON.stringify({
    sites: [{ key: "guard", name: "Guard", type: 3, api: "CSP_NEWDEMOGUARD" }],
  }), "utf8");
  try {
    const config = await loadVodConfig(file);
    assert.equal(config.sites[0]?.api, "CSP_NEWDEMOGUARD");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
