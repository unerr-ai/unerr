#!/usr/bin/env node
/**
 * Fails the build if the largest Vite JS chunk (gzip) exceeds the Layer 7 budget.
 * Run after `vite build` (see package.json `build:ui`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const GZIP_BUDGET_BYTES = 250 * 1024;
const root = process.cwd();
const assetsDir = join(root, "dist", "ui", "assets");

function gzipSize(filePath) {
  return gzipSync(readFileSync(filePath)).length;
}

try {
  statSync(assetsDir);
} catch {
  console.error("check-ui-bundle: dist/ui/assets not found. Run vite build first.");
  process.exit(1);
}

const files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
if (files.length === 0) {
  console.error("check-ui-bundle: no JS files in dist/ui/assets.");
  process.exit(1);
}

let maxGzip = 0;
let maxFile = "";
const rows = [];
for (const f of files) {
  const p = join(assetsDir, f);
  const gz = gzipSize(p);
  rows.push({ f, gz, raw: statSync(p).size });
  if (gz > maxGzip) {
    maxGzip = gz;
    maxFile = f;
  }
}

let cssGzip = 0;
for (const f of readdirSync(assetsDir).filter((x) => x.endsWith(".css"))) {
  cssGzip += gzipSize(join(assetsDir, f));
}

rows.sort((a, b) => b.gz - a.gz);
console.log(
  `check-ui-bundle: largest JS ${maxFile} gzip=${maxGzip} bytes (budget ${GZIP_BUDGET_BYTES})`,
);
console.log(
  `check-ui-bundle: CSS gzip total=${cssGzip} bytes (informational)`,
);

if (maxGzip > GZIP_BUDGET_BYTES) {
  console.error(
    `check-ui-bundle: FAILED — largest JS chunk gzip ${maxGzip} exceeds ${GZIP_BUDGET_BYTES} bytes.`,
  );
  process.exit(1);
}

process.exit(0);
