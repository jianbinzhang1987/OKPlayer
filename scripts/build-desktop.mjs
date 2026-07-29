import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
};

await Promise.all([
  build({
    ...common,
    format: "esm",
    entryPoints: ["src/desktop/main.ts"],
    outfile: "dist/main/main.js",
  }),
  build({
    ...common,
    format: "cjs",
    entryPoints: ["src/desktop/preload.ts"],
    outfile: "dist/main/preload.cjs",
  }),
  build({
    ...common,
    format: "esm",
    entryPoints: ["src/core/catopen-worker.ts"],
    outfile: "dist/main/catopen-worker.js",
  }),
  build({
    ...common,
    format: "cjs",
    entryPoints: ["src/desktop/catvod-bootstrap.ts"],
    outfile: "dist/main/catvod-bootstrap.cjs",
  }),
  build({
    ...common,
    format: "cjs",
    entryPoints: ["src/desktop/native-libmpv-probe.ts"],
    outfile: "dist/main/native-libmpv-probe.cjs",
  }),
]);
