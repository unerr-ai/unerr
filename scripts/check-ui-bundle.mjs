#!/usr/bin/env node
/**
 * Fails the build if the single inlined dashboard HTML (gzip) exceeds the budget.
 * The dashboard ships as one self-contained dist/ui/index.html (vite-plugin-singlefile):
 * all JS + CSS are inlined, so there are no loose minified chunks to scan per-file.
 * Run after `vite build` (see package.json `build:ui`).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const GZIP_BUDGET_BYTES = 600 * 1024;
const root = process.cwd();
const indexHtml = join(root, "dist", "ui", "index.html");

try {
  statSync(indexHtml);
} catch {
  console.error(
    "check-ui-bundle: dist/ui/index.html not found. Run vite build first.",
  );
  process.exit(1);
}

const raw = readFileSync(indexHtml);
const gz = gzipSync(raw).length;
console.log(
  `check-ui-bundle: dist/ui/index.html raw=${raw.length} gzip=${gz} bytes (budget ${GZIP_BUDGET_BYTES})`,
);

if (gz > GZIP_BUDGET_BYTES) {
  console.error(
    `check-ui-bundle: FAILED — index.html gzip ${gz} exceeds ${GZIP_BUDGET_BYTES} bytes.`,
  );
  process.exit(1);
}

process.exit(0);
