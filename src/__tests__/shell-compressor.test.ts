/**
 * Layer 6 Sprint FE-F — shell compressor + graph-aware diff hints.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { compressShellOutput } from "../proxy/shell-compressor.js";
import { compressTestResults } from "../proxy/shell-strategies/test-results.js";

describe("compressShellOutput graph boost (FE-F.6)", () => {
  it("annotates diff lines when entity lookup returns high fan-in", async () => {
    const graph = {
      findEntityByName: vi.fn(async (name: string) => {
        if (name !== "riskyFn") return null;
        return {
          key: "k",
          kind: "function",
          name: "riskyFn",
          file_path: "src/x.ts",
          start_line: 1,
          signature: "()",
          body: "",
          fan_in: 40,
          fan_out: 0,
          risk_level: "high",
          community: 0,
        };
      }),
    } as unknown as CozoGraphStore;

    const diff =
      "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n+riskyFn();\nexport function riskyFn() {}\n";
    const r = await compressShellOutput("git diff", diff, {
      graph,
      persistStats: false,
    });
    expect(r.text).toContain("[HIGH-RISK:riskyFn");
    expect(graph.findEntityByName).toHaveBeenCalled();
  });
});

describe("compressShellOutput empty-output guard", () => {
  it("passes empty output through without recording a zero-byte event", async () => {
    const r = await compressShellOutput("echo", "");
    expect(r.text).toBe("");
    expect(r.classification.category).toBe("structured");
  });

  it("passes whitespace-only output through unchanged", async () => {
    const r = await compressShellOutput("echo", "   \n\n  ");
    expect(r.text).toBe("   \n\n  ");
  });
});

describe("compressShellOutput never inflates (test_results 2× bug)", () => {
  it("does not double a single-line grep-of-test-json misclassified as test_results", async () => {
    // Reproduces metrics.db id 26276: a `grep` over a minified jest results file
    // lands as ONE huge line. The generic fallback found a summary line (the same
    // single line, which matches /failed/) and prepended it to a body that already
    // contained it → exactly 2× the input. The output must never exceed the input.
    const oneHugeLine = `{"numFailedTests":2,"numPassedTests":${"x".repeat(5000)},"numTotalTests":99,"failureMessage":"Error: boom"}`;
    const r = await compressShellOutput(
      "grep -E 'numFailedTests|numPassedTests|numTotalTests' .unerr/test-out.json",
      oneHugeLine,
      { persistStats: false }
    );
    expect(r.text.length).toBeLessThanOrEqual(oneHugeLine.length);
  });

  it("compressTestResults generic fallback does not duplicate the summary line", () => {
    // The summary line is found within the SAME lines the fallback keeps, so it
    // must not be prepended a second time.
    const out = [
      "checking widget",
      "12 tests, 1 failure",
      "stack at frobnicate",
    ].join("\n");
    const compressed = compressTestResults(out, "./custom-runner");
    expect(compressed.split("12 tests, 1 failure").length - 1).toBe(1);
    expect(compressed.length).toBeLessThanOrEqual(out.length);
  });

  it("compressTestResults does not double a single matching line", () => {
    const oneLine = `summary blob: ${"y".repeat(2000)} — 3 failed`;
    const compressed = compressTestResults(oneLine, "grep -E failed");
    expect(compressed.length).toBeLessThanOrEqual(oneLine.length);
  });
});

// Regression: cat/head/tail of a source file was tagged log_text at 0.82
// confidence (above the 0.7 gate) and rewritten into a frequency histogram
// by compressLogText's pattern-dedup — destroying every verbatim edit
// anchor. See CLAUDE.md / arXiv 2607.12161 for the measured blast radius.
describe("compressShellOutput source-code passthrough", () => {
  it("cat of a source file returns byte-identical content", async () => {
    const bodyLines: string[] = [
      'import { readFile } from "node:fs";',
      "",
      "export function run(list: number[]): number {",
    ];
    for (let i = 0; i < 100; i++) {
      bodyLines.push(`  if (list[${i}]) {`);
      bodyLines.push(`    doThing(${i});`);
      bodyLines.push("  }");
    }
    bodyLines.push("  return 0;");
    bodyLines.push("}");
    const source = bodyLines.join("\n");

    const r = await compressShellOutput(
      "cat src/proxy/example-module.ts",
      source,
      { persistStats: false }
    );

    expect(r.text).toBe(source);
    expect(r.classification.category).toBe("structured");
    expect(r.classification.confidence).toBe(1);
    expect(r.text).not.toContain("[×");
  });

  it("large source file well over 4KB stays byte-identical — size does not gate the guard", async () => {
    const bodyLines: string[] = ["export function generated() {"];
    for (let i = 0; i < 3000; i++) {
      bodyLines.push(`  step(${i});`);
      bodyLines.push("}");
    }
    const source = bodyLines.join("\n");
    // Comfortably clears both the old N8 4KB cap and the 4KB size mentioned
    // in the bug report — size must never gate this guard.
    expect(source.length).toBeGreaterThan(4096 * 5);

    const r = await compressShellOutput("cat src/generated/steps.ts", source, {
      persistStats: false,
    });

    expect(r.text).toBe(source);
  });

  it("a genuine log stream (non-file-dump command) still compresses", async () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `Compiling module_${i % 4}.js... done in ${i}ms`
    );
    const raw = lines.join("\n");

    const r = await compressShellOutput("npm run build", raw, {
      persistStats: false,
    });

    expect(r.classification.category).toBe("log_text");
    expect(r.text.length).toBeLessThan(raw.length);
    expect(r.text).toContain("[×");
  });

  it("the reordering gate does not fire below its threshold (cat of a non-source dump, confidence 0.82)", async () => {
    // First 20 lines feed the classifier's content heuristic — kept boring
    // (no digits, no WARN/build keywords, no timestamps) so content scoring
    // stays null and the command hint alone decides: cat -> log_text at the
    // command-name-only confidence (0.82), below REORDER_CONFIDENCE_GATE (0.9).
    const headLines = [
      "Configuration loaded from project settings",
      "Database connection established successfully",
      "Cache warmed with initial dataset",
      "Router initialized with fifteen active routes",
      "Session store connected to backend",
      "Feature flags synchronized from remote",
      "Worker pool spun up for background jobs",
      "Metrics exporter registered on startup",
      "Health check endpoint mounted",
      "Static assets served from local directory",
      "Template engine compiled default views",
      "Locale files loaded for three languages",
      "Rate limiter configured with default policy",
      "Webhook listeners attached to event bus",
      "Scheduler primed with recurring tasks",
      "Plugin registry populated from manifest",
      "Search index opened in read-write mode",
      "Notification channel connected to queue",
      "Audit log writer flushed pending entries",
      "Startup sequence completed without warnings",
    ];
    const repeatedTail = Array.from({ length: 100 }, () => "}");
    const raw = [...headLines, ...repeatedTail].join("\n");

    const r = await compressShellOutput("cat notes.log", raw, {
      persistStats: false,
    });

    expect(r.classification.category).toBe("log_text");
    expect(r.classification.confidence).toBeLessThan(0.9);
    expect(r.text).toBe(raw);
    expect(r.text).not.toContain("[×");
  });
});

// The "verify bundle" end-to-end: a real test-runner log routed through the
// full compressor must surface a compact failure bundle with a lossless
// recovery pointer, keep failing detail byte-exact, and leave a passing run
// and a non-test command untouched.
describe("compressShellOutput — verify bundle (test-runner extraction)", () => {
  let cwd: string;
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "unerr-verify-"));
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("failing pytest run: compact bundle + verbatim detail + recovery pointer", async () => {
    const lines = [
      "============================= test session starts ==============================",
      "platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0",
      "rootdir: /workspace/app",
      "collected 59 items",
      "",
    ];
    for (let i = 0; i < 58; i++) {
      lines.push(
        `tests/test_bulk.py::test_case_${i} PASSED                                 [ ${i}%]`
      );
    }
    lines.push(
      "tests/test_math.py::test_add FAILED                                       [100%]",
      "",
      "=================================== FAILURES ===================================",
      "___________________________________ test_add ___________________________________",
      "",
      "    def test_add():",
      "        result = add(2, 2)",
      ">       assert result == 5",
      "E       assert 4 == 5",
      "E        +  where 4 = add(2, 2)",
      "",
      "tests/test_math.py:12: AssertionError",
      "=========================== short test summary info ============================",
      "FAILED tests/test_math.py::test_add - assert 4 == 5",
      "========================= 1 failed, 58 passed in 0.42s =========================="
    );
    const raw = lines.join("\n");
    expect(raw.length).toBeGreaterThan(1024); // clears the tee size gate

    const r = await compressShellOutput("pytest -v", raw, {
      cwd,
      exitCode: 1,
      persistStats: false,
    });

    expect(r.classification.category).toBe("test_results");
    // Counts (FAILED-first ordering) + verbatim assertion + verbatim file:line.
    expect(r.text).toContain("58 passed");
    expect(r.text).toContain("1 failed");
    expect(r.text).toContain("E       assert 4 == 5");
    expect(r.text).toContain("tests/test_math.py:12: AssertionError");
    // Passing-test noise is gone.
    expect(r.text).not.toContain("test_case_0 PASSED");
    // Lossless recovery: the full raw log is teed and pointed at by file_read.
    expect(r.text).toContain("[full output");
    expect(r.text).toContain("file_read({file_path:");
    // The bundle is a real compression, not the raw log.
    expect(r.text.length).toBeLessThan(raw.length);
  });

  it("passing pytest run: minimal summary, no over-compression, no pointer", async () => {
    const lines = [
      "============================= test session starts ==============================",
    ];
    for (let i = 0; i < 12; i++) {
      lines.push(
        `tests/test_ok.py::test_${i} PASSED                               [ ${i}%]`
      );
    }
    lines.push(
      "========================= 12 passed in 0.15s =================================="
    );
    const raw = lines.join("\n");

    const r = await compressShellOutput("pytest", raw, {
      cwd,
      exitCode: 0,
      persistStats: false,
    });

    expect(r.classification.category).toBe("test_results");
    expect(r.text).toContain("12 passed");
    // A green run collapses to one short line — no failure blocks, no pointer.
    expect(r.text.split("\n").length).toBeLessThanOrEqual(2);
    expect(r.text).not.toContain("[full output");
  });

  it("non-test command is not hijacked into the test bundle", async () => {
    // A git log — nothing test-shaped. It must not route to test_results, and
    // no fabricated pass/fail counts may be injected. (Byte-for-byte behavior
    // of every non-test path is unchanged: this change only touches the pytest
    // parser + the test-results line cap.)
    const raw = [
      "a1b2c3d fix parser edge case",
      "e4f5g6h add retry to fetch",
      "i7j8k9l bump deps",
    ].join("\n");
    const r = await compressShellOutput("git log --oneline -3", raw, {
      cwd,
      persistStats: false,
    });
    expect(r.classification.category).not.toBe("test_results");
    expect(r.text).toContain("fix parser edge case");
    expect(r.text).not.toMatch(/\d+ passed/);
  });
});
