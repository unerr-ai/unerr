import { createHash } from "node:crypto";
/**
 * Compression harness (S0/T0.5 + S4) — runs the FROZEN corpus through the LIVE
 * compressors and reports per-fixture { original_tokens, delivered_tokens,
 * ratio, fidelity pass/fail, ranking_key }, plus per-category savings.
 *
 * What it proves (the S0 + S4 acceptance criteria):
 *   1. Reproducibility — every fixture's bytes match the SHA-256 pinned in
 *      manifest.json, so a drifted fixture fails loudly. Same fixtures in →
 *      same numbers out (frozen-corpus reproducibility).
 *   2. Determinism — two runs through the live compressors yield IDENTICAL
 *      token numbers (no clock, no Math.random, no set-iteration order).
 *   3. Fidelity — the must-survive fact (T0.4) is checked against the
 *      compressed output; the report distinguishes pass from fail per fixture.
 *   4. Fidelity gating (S4/T4.3) — a fixture's byte savings count toward the
 *      headline number ONLY when its fidelity probe passes. A compression that
 *      drops the must-survive fact contributes ZERO savings, not its bytes.
 *      The honest headline is the fidelity-GATED number; gross is reported
 *      alongside it, never instead of it.
 *
 * S3/S7 wiring (T4.2): each fixture carries a `task` (the agent's current
 * query). The harness feeds it into the LIVE query-aware compressors —
 * wire-cap relevance ordering (T7.4), per-function chunk ranking before
 * smart-truncate (T7.3 primitive), and compressLogText error ranking
 * (T7.5) — so the gated number reflects survivors-by-query, not positional
 * truncation. With no query a fixture would fall back to S3 importance /
 * positional order (the query is an upgrade of the ranking key, never a
 * hard dependency).
 *
 * Token accounting goes through the ONE path (accountCompression →
 * estimateTokenCount / o200k_base) so before/after is apples-to-apples — the
 * same requirement T0.2 puts on the live compressors.
 *
 * Standalone runner: this is a vitest file, so run it with
 *   pnpm run test:run src/__tests__/compression-harness.test.ts
 * It prints the full report to stderr (stdout stays clean), writes the
 * publication-ready table to benchmarks/compression-corpus/RESULTS.md via fs
 * (T4.5), and returns the report from runHarness() for programmatic use.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rankChunksByQuery } from "../intelligence/chunk-ranker.js";
import { smartTruncate } from "../intelligence/smart-truncate.js";
import { estimateTokenCount } from "../intelligence/token-estimator.js";
import { accountCompression } from "../proxy/shell-compression-log.js";
import {
  compressShellOutput,
  stripAnsiCodes,
} from "../proxy/shell-compressor.js";
import { compressLogText } from "../proxy/shell-strategies/log-text.js";
import { applyWireCap } from "../proxy/wire-cap.js";

const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "benchmarks",
  "compression-corpus"
);

interface ManifestFixture {
  id: string;
  category: "shell" | "file-read" | "json";
  path: string;
  bytes: number;
  sha256: string;
  mustSurvive: string;
  /** The agent's current task — fed to the S7 query-aware compressors. */
  task: string;
}
interface Manifest {
  fixtures: ManifestFixture[];
}

interface FixtureReport {
  id: string;
  category: string;
  mechanism: string;
  original_tokens: number;
  delivered_tokens: number;
  ratio: number; // delivered / original  (lower = more compression)
  saved_pct: number;
  fidelity_pass: boolean;
  /** Which signal ordered the survivors (§4 ranking_key): query|importance|positional. */
  ranking_key: string;
}

/**
 * Category-level rollup: gross savings (every fixture) vs the fidelity-GATED
 * headline (savings counted only on fixtures that preserved every must-survive
 * pattern — a probe failure contributes ZERO savings, i.e. delivered := original).
 */
interface CategoryRollup {
  category: string;
  n: number;
  gross_saved_pct: number;
  gated_saved_pct: number;
  fidelity_passes: number;
}

function loadManifest(): Manifest {
  return JSON.parse(
    readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8")
  ) as Manifest;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Split a raw source file into per-function chunks so the query-aware ranker
 * (T7.3 primitive) can float the on-task entity to the front before
 * smart-truncate keeps the head of the budget. Boundaries are
 * `export (async )?function` / `function ` / a doc-comment opener — chunk-level,
 * not token-level, so a function is never cut mid-body (the §8 rule:
 * token-level pruning breaks code, chunk-level is correct). Deterministic:
 * splitting is a pure pass over the lines.
 */
function chunkSourceByFunction(source: string): string[] {
  const lines = source.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const isBoundary = (line: string): boolean =>
    /^\s*(export\s+)?(async\s+)?function\s/.test(line) ||
    /^\s*\/\*\*/.test(line);
  for (const line of lines) {
    if (isBoundary(line) && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

/**
 * Run ONE fixture through the LIVE compressor for its category, fed with the
 * fixture's `task` so the S7 query-aware paths order survivors by relevance.
 * Returns the delivered (compressed) text + mechanism + which signal ordered
 * the survivors (§4 ranking_key). Pure — no metrics writes (shell compressor
 * gets persistStats:false and a throwaway cwd).
 */
async function compressFixture(
  f: ManifestFixture,
  raw: string
): Promise<{ delivered: string; mechanism: string; ranking_key: string }> {
  if (f.category === "shell") {
    const command = commandFor(f.id);
    const res = await compressShellOutput(command, raw, {
      cwd: join(CORPUS_DIR, ".harness-tmp"),
      persistStats: false,
      graph: null,
      qualityMonitor: null,
    });
    // T7.5: for log_text output the strategy ranks error lines by the current
    // query so the on-task error survives the error-line cut. compressShellOutput
    // doesn't thread the query, so for the log_text category we re-run the live
    // strategy with the task to exercise the query-aware path. Other shell
    // strategies (diff, yaml) already keep their structural anchor (first diff
    // header / `kind: Pod`) and stay query-agnostic — ranking_key 'positional'.
    if (res.classification.category === "log_text") {
      const stripped = stripAnsiCodes(raw);
      const delivered = compressLogText(stripped, command, f.task);
      return {
        delivered,
        mechanism: "shell_log_text",
        ranking_key: "query",
      };
    }
    return {
      delivered: res.text,
      mechanism: "shell_compressor",
      ranking_key: "positional",
    };
  }

  if (f.category === "file-read") {
    // file/entity reads go through smart-truncate. A tight budget forces the
    // structural truncation path; on its own it keeps the positional head of
    // the bodies and drops a mid-file entity. T7.3: rank the per-function
    // chunks by the task and reassemble most-relevant-first, so the on-task
    // handler survives the budget instead of whichever function sits at the top.
    const chunks = chunkSourceByFunction(raw);
    const ranked = rankChunksByQuery(
      chunks.map((text) => ({ text })),
      f.task
    );
    const orderedBodies = ranked.map((r) => chunks[r.index]).join("\n");
    const res = smartTruncate({
      metadata: `// file: ${f.id}.ts`,
      imports: "",
      signatures: "",
      bodies: orderedBodies,
      budget: 800,
    });
    return {
      delivered: res.content,
      mechanism: "smart_truncate",
      ranking_key: "query",
    };
  }

  // json — search_code-style result array through wire-cap. T7.4: passing the
  // task as the `query` arg orders entity rows by query relevance BEFORE the
  // positional slice, so the on-task entity (buried mid-array in the fixture)
  // survives the count cap instead of being dropped with the tail.
  const parsed = JSON.parse(raw) as { results: unknown[] };
  const capped = applyWireCap("search_code", parsed.results, {
    query: f.task,
  });
  return {
    delivered: JSON.stringify(capped.body),
    mechanism: "wire_cap",
    ranking_key: capped.metrics?.ranking_key ?? "positional",
  };
}

function commandFor(id: string): string {
  if (id.startsWith("build-log")) return "pnpm run build";
  if (id === "git-diff-large") return "git diff";
  if (id === "kubectl-yaml") return "kubectl get pods -o yaml";
  if (id === "test-results-fail") return "pnpm run test:run";
  return "echo";
}

async function runFixture(f: ManifestFixture): Promise<FixtureReport> {
  const raw = readFileSync(join(CORPUS_DIR, f.path), "utf8");
  // Reproducibility gate (T0.3): the fixture must match its pinned hash.
  expect(sha256(raw), `fixture ${f.id} drifted from manifest hash`).toBe(
    f.sha256
  );

  const { delivered, mechanism, ranking_key } = await compressFixture(f, raw);

  // ONE accounting path — both numbers from estimateTokenCount (T0.2).
  const acct = accountCompression(raw, delivered, mechanism);

  // Fidelity probe (T0.4): does the must-survive fact survive compression?
  const probe = new RegExp(f.mustSurvive);
  const fidelity_pass = probe.test(delivered);

  const ratio =
    acct.original_tokens === 0
      ? 1
      : acct.delivered_tokens / acct.original_tokens;
  const saved_pct =
    acct.original_tokens === 0
      ? 0
      : (1 - acct.delivered_tokens / acct.original_tokens) * 100;

  return {
    id: f.id,
    category: f.category,
    mechanism: acct.mechanism,
    original_tokens: acct.original_tokens,
    delivered_tokens: acct.delivered_tokens,
    ratio,
    saved_pct,
    fidelity_pass,
    ranking_key,
  };
}

/**
 * Tokens a fixture is allowed to count as "delivered" for the GATED headline:
 * the real delivered count when fidelity passed, else the full original count
 * (a probe failure earns ZERO savings, never its byte win — the §4 / benchmark-
 * integrity rule). This is the single place the gate is applied.
 */
function gatedDeliveredTokens(r: FixtureReport): number {
  return r.fidelity_pass ? r.delivered_tokens : r.original_tokens;
}

/**
 * Per-category gross vs fidelity-gated savings. Gross = savings over every
 * fixture's real delivered tokens. Gated = savings where each failing fixture
 * is charged its full original (zero savings). Both share the same original-
 * token denominator, so the gated number is always ≤ gross and never hides a
 * fidelity regression in the average (T4.3). Sorted by category for a stable,
 * reproducible table.
 */
function rollupByCategory(reports: FixtureReport[]): CategoryRollup[] {
  const byCat = new Map<string, FixtureReport[]>();
  for (const r of reports) {
    const arr = byCat.get(r.category) ?? [];
    arr.push(r);
    byCat.set(r.category, arr);
  }
  const rollups: CategoryRollup[] = [];
  for (const [category, rs] of byCat) {
    const orig = rs.reduce((s, r) => s + r.original_tokens, 0);
    const grossDeliv = rs.reduce((s, r) => s + r.delivered_tokens, 0);
    const gatedDeliv = rs.reduce((s, r) => s + gatedDeliveredTokens(r), 0);
    rollups.push({
      category,
      n: rs.length,
      gross_saved_pct: orig === 0 ? 0 : (1 - grossDeliv / orig) * 100,
      gated_saved_pct: orig === 0 ? 0 : (1 - gatedDeliv / orig) * 100,
      fidelity_passes: rs.filter((r) => r.fidelity_pass).length,
    });
  }
  // Stable order — category name — so RESULTS.md is byte-deterministic.
  rollups.sort((a, b) => a.category.localeCompare(b.category));
  return rollups;
}

async function runHarness(): Promise<FixtureReport[]> {
  const manifest = loadManifest();
  const reports: FixtureReport[] = [];
  for (const f of manifest.fixtures) {
    reports.push(await runFixture(f));
  }
  return reports;
}

function formatReport(reports: FixtureReport[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Compression harness report (S0 frozen corpus) ===");
  lines.push(
    `${
      "fixture".padEnd(22) +
      "mech".padEnd(18) +
      "orig".padStart(8) +
      "deliv".padStart(8) +
      "saved%".padStart(9)
    }  fidelity`
  );
  for (const r of reports) {
    lines.push(
      `${
        r.id.padEnd(22) +
        r.mechanism.padEnd(18) +
        String(r.original_tokens).padStart(8) +
        String(r.delivered_tokens).padStart(8) +
        `${r.saved_pct.toFixed(1)}%`.padStart(9)
      }  ${r.fidelity_pass ? "PASS" : "FAIL"}`
    );
  }
  lines.push("");
  lines.push("--- per-category (gross vs fidelity-GATED) ---");
  for (const c of rollupByCategory(reports)) {
    lines.push(
      `${c.category.padEnd(12)} n=${c.n}  gross=${c.gross_saved_pct.toFixed(1)}%  ` +
        `gated=${c.gated_saved_pct.toFixed(1)}%  fidelity ${c.fidelity_passes}/${c.n}`
    );
  }
  lines.push("");
  lines.push("Headline = the fidelity-GATED number (a dropped must-survive");
  lines.push("pattern earns zero savings, never its bytes).");
  lines.push("");
  return lines.join("\n");
}

/**
 * Publication-ready, deterministic results table (T4.5). Written to
 * benchmarks/compression-corpus/RESULTS.md via fs — never console — so a pipe
 * consumer of the test's stdout is never polluted. No clock, no random: the
 * same frozen corpus produces a byte-identical file every run, which is the
 * reproducibility the benchmark-integrity stance requires. The headline column
 * is the fidelity-gated number; gross sits beside it for honesty, never instead.
 */
function renderResultsMd(reports: FixtureReport[]): string {
  const rollups = rollupByCategory(reports);
  const totalOrig = reports.reduce((s, r) => s + r.original_tokens, 0);
  const totalGross = reports.reduce((s, r) => s + r.delivered_tokens, 0);
  const totalGated = reports.reduce((s, r) => s + gatedDeliveredTokens(r), 0);
  const grossPct = totalOrig === 0 ? 0 : (1 - totalGross / totalOrig) * 100;
  const gatedPct = totalOrig === 0 ? 0 : (1 - totalGated / totalOrig) * 100;
  const totalPasses = reports.filter((r) => r.fidelity_pass).length;

  const out: string[] = [];
  out.push("# Compression benchmark — fidelity-gated results");
  out.push("");
  out.push(
    "Frozen corpus, n=5 per category. The **headline is the fidelity-gated**"
  );
  out.push(
    "savings: a fixture's byte win counts only when every must-survive pattern"
  );
  out.push(
    "survived compression. A compression that drops the answer earns **zero**"
  );
  out.push(
    "savings, not its bytes — so the gated number never hides a regression."
  );
  out.push("");
  out.push(
    "Reproduce: `node benchmarks/compression-corpus/generate-fixtures.mjs` then"
  );
  out.push(
    "`pnpm run test:run src/__tests__/compression-harness.test.ts`. Same"
  );
  out.push("fixtures in → same numbers out (no clock, no randomness).");
  out.push("");
  out.push("## Per-category");
  out.push("");
  out.push("| category | n | gross saved % | gated saved % | fidelity pass |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const c of rollups) {
    out.push(
      `| ${c.category} | ${c.n} | ${c.gross_saved_pct.toFixed(1)}% | ` +
        `${c.gated_saved_pct.toFixed(1)}% | ${c.fidelity_passes}/${c.n} |`
    );
  }
  out.push(
    `| **all** | ${reports.length} | ${grossPct.toFixed(1)}% | ` +
      `${gatedPct.toFixed(1)}% | ${totalPasses}/${reports.length} |`
  );
  out.push("");
  out.push("## Per-fixture");
  out.push("");
  out.push(
    "| fixture | category | mechanism | ranking | orig→deliv tok | saved % | fidelity |"
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  // Stable order: category, then fixture id, so the table is byte-deterministic.
  const ordered = [...reports].sort(
    (a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id)
  );
  for (const r of ordered) {
    out.push(
      `| ${r.id} | ${r.category} | ${r.mechanism} | ${r.ranking_key} | ` +
        `${r.original_tokens}→${r.delivered_tokens} | ${r.saved_pct.toFixed(1)}% | ` +
        `${r.fidelity_pass ? "PASS" : "FAIL"} |`
    );
  }
  out.push("");
  out.push(
    "Savings framing: retrieval-slice (what one tool response delivers), not a"
  );
  out.push(
    "whole-session bill. `ranking=query` marks a survivor ordered by the S7"
  );
  out.push(
    "task-conditioned path; `importance` by S3 graph centrality; `positional` by"
  );
  out.push("structure. Understanding-code savings (graph/query ordering) and");
  out.push(
    "compressing-output savings (shell/JSON truncation) both land in this table."
  );
  out.push("");
  return out.join("\n");
}

const RESULTS_PATH = join(CORPUS_DIR, "RESULTS.md");

function writeResultsMd(reports: FixtureReport[]): string {
  const md = renderResultsMd(reports);
  writeFileSync(RESULTS_PATH, md, "utf8");
  return md;
}

describe("compression harness (S0 + S4)", () => {
  it("reports original->delivered tokens + fidelity per fixture, n>=5 per category", async () => {
    const reports = await runHarness();

    // n >= 5 per category (the A/B note's bar).
    const counts = new Map<string, number>();
    for (const r of reports)
      counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBeGreaterThanOrEqual(5);
    expect(counts.size).toBe(3);

    // Print the report to stderr (stdout stays clean for any JSON consumer).
    process.stderr.write(formatReport(reports));

    // Every compressor actually reduced its payload (delivered < original).
    for (const r of reports) {
      expect(r.delivered_tokens).toBeLessThan(r.original_tokens);
      expect(r.original_tokens).toBeGreaterThan(0);
    }

    // At least one big-shell-output fixture present (the A/B note's bar).
    const shell = reports.filter((r) => r.category === "shell");
    expect(shell.length).toBeGreaterThanOrEqual(5);
  });

  it("is deterministic — two runs yield identical token numbers", async () => {
    const a = await runHarness();
    const b = await runHarness();
    expect(b.map((r) => [r.id, r.original_tokens, r.delivered_tokens])).toEqual(
      a.map((r) => [r.id, r.original_tokens, r.delivered_tokens])
    );
  });

  it("accountCompression both sides use the same estimator path", () => {
    const original = "x".repeat(4000);
    const acct = accountCompression(original, "x".repeat(40), "probe");
    expect(acct.original_tokens).toBe(estimateTokenCount(original));
    expect(acct.delivered_tokens).toBe(estimateTokenCount("x".repeat(40)));
    expect(acct.original_tokens).toBeGreaterThan(acct.delivered_tokens);
  });

  // ── S4 — fidelity-gated headline + publication ─────────────────────────

  it("gated savings never exceed gross, and a fidelity failure earns zero savings (T4.3)", async () => {
    const reports = await runHarness();
    for (const c of rollupByCategory(reports)) {
      // The gate can only ever REMOVE savings, never add them — so the honest
      // headline is always ≤ the gross number.
      expect(c.gated_saved_pct).toBeLessThanOrEqual(c.gross_saved_pct + 1e-9);
      // When every fixture in a category passed, gated == gross (nothing
      // withheld); when some failed, gated is strictly lower.
      if (c.fidelity_passes === c.n) {
        expect(c.gated_saved_pct).toBeCloseTo(c.gross_saved_pct, 6);
      } else {
        expect(c.gated_saved_pct).toBeLessThan(c.gross_saved_pct);
      }
    }
  });

  it("S3/S7 query-aware ordering raises fidelity above the S0 positional baseline", async () => {
    // S0 baseline (positional / query-blind): shell 1/5, file-read 0/5,
    // json 0/5 — the LOW numbers that proved the probe works. Feeding the
    // per-fixture task into the LIVE query-aware paths (T7.3/T7.4/T7.5) must
    // recover the must-survive fact in far more fixtures.
    const reports = await runHarness();
    const passByCat = new Map<string, number>();
    for (const r of reports) {
      if (r.fidelity_pass)
        passByCat.set(r.category, (passByCat.get(r.category) ?? 0) + 1);
    }
    // Every category now clears its S0 baseline.
    expect(passByCat.get("json") ?? 0).toBeGreaterThan(0); // was 0/5
    expect(passByCat.get("file-read") ?? 0).toBeGreaterThan(0); // was 0/5
    expect(passByCat.get("shell") ?? 0).toBeGreaterThanOrEqual(1); // was 1/5

    // The whole corpus preserves the answer in a clear majority of fixtures —
    // a real, gated win over the all-low S0 baseline (1 of 15 passing).
    const totalPass = reports.filter((r) => r.fidelity_pass).length;
    expect(totalPass).toBeGreaterThan(reports.length / 2);

    // The query path actually ordered the survivors where a task was available.
    const queryOrdered = reports.filter((r) => r.ranking_key === "query");
    expect(queryOrdered.length).toBeGreaterThan(0);
  });

  it("writes a deterministic publication-ready RESULTS.md (T4.5)", async () => {
    const reports = await runHarness();
    const md = writeResultsMd(reports);
    // Written to disk via fs, not console.
    expect(readFileSync(RESULTS_PATH, "utf8")).toBe(md);
    // Frozen corpus → byte-identical artifact across runs.
    const again = renderResultsMd(await runHarness());
    expect(again).toBe(md);
    // The headline framing is present and the gated number is shown.
    expect(md).toContain("fidelity-gated");
    expect(md).toContain("gated saved %");
    // No competitor product is named anywhere in the artifact.
    expect(md.toLowerCase()).not.toMatch(/\b(tokenizer-as-a-service)\b/);
  });
});
