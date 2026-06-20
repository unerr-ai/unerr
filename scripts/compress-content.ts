/**
 * Lever B build step (TOKEN_ECONOMICS_AND_SAVINGS §11.3 B2/B3).
 *
 * Reads every `compress:true` content entry from the registry, runs it through
 * the Python LLMLingua-2 sidecar, and writes `src/content/compressed.json`
 * (`{ id: { compressed, ratio, method } }`). The output is COMMITTED so prod
 * ships the processed JSON with no Python dependency at runtime.
 *
 * Two modes:
 *   - sidecar present  → method:"llmlingua-2", real compression.
 *   - sidecar absent   → method:"passthrough", compressed === raw, ratio 1.
 *
 * Passthrough keeps the committed artifact valid (and the CI guard green) on
 * machines without Python + llmlingua; an operator with the toolchain re-runs
 * `pnpm content:compress` and reviews the diff before committing real output.
 *
 * The compressor NEVER sees `compress:false` entries (tool descriptions +
 * protocol text — the §7 hard exclusion); only `compress:true` ids are sent.
 *
 * Run: `pnpm content:compress`
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allContentEntries } from "../src/content/registry.js";

interface CompressedEntry {
  compressed: string;
  ratio: number;
  method: "llmlingua-2" | "passthrough";
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const outPath = join(repoRoot, "src", "content", "compressed.json");
const sidecar = join(scriptDir, "llmlingua_sidecar.py");

const compressible = allContentEntries().filter((e) => e.compress);

function runSidecar(
  items: Array<{ id: string; raw: string }>
): Record<string, { compressed: string; ratio: number }> | null {
  const res = spawnSync("python3", [sidecar], {
    input: JSON.stringify(items),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout) {
    if (res.stderr) process.stderr.write(res.stderr);
    return null;
  }
  try {
    return JSON.parse(res.stdout) as Record<
      string,
      { compressed: string; ratio: number }
    >;
  } catch {
    return null;
  }
}

const sidecarOut = runSidecar(
  compressible.map((e) => ({ id: e.id, raw: e.raw }))
);

const out: Record<string, CompressedEntry> = {};
let totalRaw = 0;
let totalOut = 0;
for (const entry of compressible) {
  const fromSidecar = sidecarOut?.[entry.id];
  if (fromSidecar && typeof fromSidecar.compressed === "string") {
    out[entry.id] = {
      compressed: fromSidecar.compressed,
      ratio: fromSidecar.ratio,
      method: "llmlingua-2",
    };
  } else {
    out[entry.id] = { compressed: entry.raw, ratio: 1, method: "passthrough" };
  }
  totalRaw += entry.raw.length;
  totalOut += out[entry.id].compressed.length;
}

writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

const mode = sidecarOut ? "llmlingua-2" : "passthrough (no Python/llmlingua)";
const pct = totalRaw > 0 ? (100 * (1 - totalOut / totalRaw)).toFixed(1) : "0.0";
process.stderr.write(
  `content:compress — ${compressible.length} entries, mode=${mode}, ${totalRaw}→${totalOut} chars (${pct}% smaller)\n`
);
