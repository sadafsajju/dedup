// Run a TypeScript test file on any Node we support.
//
// The suites under plugin-src/*.test.mts import from src/lib, which is TS.
// `node --experimental-strip-types` only exists on Node ≥22.6, and dedup
// itself runs fine on Node 20 — so the tests bundle through esbuild (already a
// dependency for the plugin bundles) and run as plain JS.
//
// Usage: node plugin-src/run-ts.mjs <file.mts>
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node plugin-src/run-ts.mjs <file.mts>");
  process.exit(2);
}

// Inside the project, not /tmp: externals (tailwind-merge, react) are resolved
// from the running file's location, and a temp dir has no node_modules above it.
const outDir = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "node_modules/.cache/dedup-tests",
);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${path.basename(entry)}.mjs`);

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // Anything from node_modules stays external: the test only needs its own
  // sources compiled, and bundling React et al. would be slow and pointless.
  packages: "external",
  logLevel: "error",
});

const run = spawnSync(process.execPath, [outFile], { stdio: "inherit" });
fs.rmSync(outFile, { force: true });
process.exit(run.status ?? 1);
