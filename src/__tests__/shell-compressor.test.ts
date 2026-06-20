/**
 * Layer 6 Sprint FE-F — shell compressor + graph-aware diff hints.
 */

import { describe, expect, it, vi } from "vitest";
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
