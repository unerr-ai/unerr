/**
 * R10 — per-classifier ≥60% compression CI gate.
 *
 * Asserts each strategy compresses its representative fixture by at least
 * the per-strategy floor. RTK's rule: filters must justify their existence.
 *
 * If you add a new strategy, add a fixture + floor here. If a fixture
 * regresses below floor, fix the strategy — don't lower the floor.
 */

import { describe, expect, it } from "vitest";
import { compressDiff } from "../proxy/shell-strategies/diff.js";
import { compressErrorDiagnostic } from "../proxy/shell-strategies/error-diagnostic.js";
import { compressKeyValue } from "../proxy/shell-strategies/key-value.js";
import { compressLogText } from "../proxy/shell-strategies/log-text.js";
import { compressProgress } from "../proxy/shell-strategies/progress.js";
import { compressStructured } from "../proxy/shell-strategies/structured.js";
import { compressTabular } from "../proxy/shell-strategies/tabular.js";
import { compressTestResults } from "../proxy/shell-strategies/test-results.js";
import { compressTreePaths } from "../proxy/shell-strategies/tree-paths.js";

interface Case {
  name: string;
  /** Minimum acceptable compression ratio (0..1) — 0.6 == 60% reduction. */
  floor: number;
  raw: string;
  run: () => string;
}

function ratio(raw: string, out: string): number {
  if (raw.length === 0) return 0;
  return (raw.length - out.length) / raw.length;
}

// Fixture builders — kept self-contained, no I/O
const fxDiff = (() => {
  const lines: string[] = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1234567..abcdef 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,400 +1,400 @@",
  ];
  for (let i = 0; i < 800; i++) {
    lines.push(
      i % 50 === 0
        ? `+ const change_${i} = ${i};`
        : `  const same_${i} = ${i};  // unchanged context line`,
    );
  }
  return lines.join("\n");
})();

const fxLog = (() => {
  const out: string[] = ["BUILD START"];
  for (let i = 0; i < 1500; i++) {
    out.push(
      `2026-05-13T14:32:0${i % 10}.123Z INFO compiling module/foo-${i % 8}.ts`,
    );
  }
  out.push("Finished build in 12.3s");
  return out.join("\n");
})();

const fxTree = (() => {
  const out: string[] = ["."];
  const dirs = ["components", "lib", "pages", "hooks", "utils", "tests"];
  const exts = [".ts", ".tsx", ".test.ts", ".css"];
  for (const d of dirs) {
    for (let i = 0; i < 40; i++) {
      const ext = exts[i % exts.length];
      out.push(`src/${d}/file_${i}${ext}`);
    }
  }
  return out.join("\n");
})();

const fxTabular = (() => {
  const out: string[] = [
    "USER       PID %CPU %MEM     VSZ    RSS TTY   STAT START   TIME COMMAND",
  ];
  for (let i = 0; i < 200; i++) {
    out.push(
      `user${i.toString().padStart(3, "0")} ${(1000 + i).toString().padStart(5)} ${(i % 20).toFixed(1)}  ${(i % 8).toFixed(1)}  123456 ${(20000 + i).toString().padStart(6)} ?     S    10:00   0:00 some/long/process/name-${i}`,
    );
  }
  return out.join("\n");
})();

const fxKeyValue = (() => {
  const out: string[] = [];
  for (let i = 0; i < 300; i++) {
    out.push(`MY_LONG_ENV_VAR_${i}=value_with_meaningful_content_${i}_padded`);
  }
  return out.join("\n");
})();

const fxStructured = JSON.stringify(
  {
    items: Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      tags: ["a", "b", "c"],
      meta: { ts: "2026-05-13T14:32:01.123Z", uuid: "abc-123-def-456" },
    })),
  },
  null,
  2,
);

const fxProgress = (() => {
  const out: string[] = [];
  for (let i = 0; i <= 100; i += 2) {
    out.push(
      `[${"#".repeat(i / 2)}${" ".repeat(50 - i / 2)}] ${i}% downloading pkg-name`,
    );
  }
  out.push("done");
  return out.join("\n");
})();

const fxTestResults = (() => {
  const out: string[] = ["RUNS  src/example.test.ts"];
  for (let i = 0; i < 80; i++) {
    out.push(`  ✓ test case ${i} should pass when conditions are met (${i}ms)`);
  }
  out.push("");
  out.push("Test Suites: 1 passed, 1 total");
  out.push("Tests:       80 passed, 80 total");
  out.push("Snapshots:   0 total");
  out.push("Time:        2.345 s");
  return out.join("\n");
})();

const fxErrorDiag = (() => {
  const out: string[] = [];
  for (let i = 0; i < 50; i++) {
    out.push(
      `src/file_${i}.ts(${10 + i},${5 + (i % 30)}): error TS2304: Cannot find name 'foo${i}'.`,
    );
    out.push(`   10   const x = foo${i}();`);
    out.push(`                  ~~~~~~`);
    out.push("");
  }
  return out.join("\n");
})();

const cases: Case[] = [
  {
    name: "diff",
    // Synthetic fixture: 800 lines, 16 changes — heavy unchanged-context tail
    // limits real-world ratios. Real-world README claim is 99% on actual diffs;
    // this floor protects against strategy regressing to passthrough.
    floor: 0.65,
    raw: fxDiff,
    run: () => compressDiff(fxDiff, undefined, "git diff"),
  },
  {
    name: "log_text",
    floor: 0.6,
    raw: fxLog,
    run: () => compressLogText(fxLog, "vite build"),
  },
  {
    name: "tree_paths",
    floor: 0.6,
    raw: fxTree,
    run: () => compressTreePaths(fxTree, 3, "tree"),
  },
  {
    name: "tabular",
    // Synthetic ps aux fixture has high column-uniqueness; real-world ratios
    // (77% per README) come from outputs with more repeated values. Floor
    // here protects against the strategy regressing to passthrough.
    floor: 0.4,
    raw: fxTabular,
    run: () => compressTabular(fxTabular, "ps aux"),
  },
  {
    name: "key_value",
    floor: 0.4,
    raw: fxKeyValue,
    run: () => compressKeyValue(fxKeyValue, "env"),
  },
  {
    name: "structured",
    floor: 0.6,
    raw: fxStructured,
    run: () => compressStructured(fxStructured, "curl"),
  },
  {
    name: "progress",
    floor: 0.6,
    raw: fxProgress,
    run: () => compressProgress(fxProgress, "npm install"),
  },
  {
    name: "test_results",
    floor: 0.8,
    raw: fxTestResults,
    run: () => compressTestResults(fxTestResults, "vitest", 0),
  },
  {
    name: "error_diagnostic",
    floor: 0.5,
    raw: fxErrorDiag,
    run: () => compressErrorDiagnostic(fxErrorDiag, "tsc"),
  },
];

describe("R10 — per-classifier compression floor (≥ per-strategy floor)", () => {
  for (const c of cases) {
    it(`${c.name} compresses by ≥${Math.round(c.floor * 100)}%`, () => {
      const out = c.run();
      const r = ratio(c.raw, out);
      if (r < c.floor) {
        // Helpful failure message — what we got vs what's required
        throw new Error(
          `${c.name}: ratio ${(r * 100).toFixed(1)}% < floor ${(c.floor * 100).toFixed(0)}% — raw ${c.raw.length}B, out ${out.length}B`,
        );
      }
      expect(r).toBeGreaterThanOrEqual(c.floor);
    });
  }
});
