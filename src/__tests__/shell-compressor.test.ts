/**
 * Layer 6 Sprint FE-F — shell compressor + graph-aware diff hints.
 */

import { describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { compressShellOutput } from "../proxy/shell-compressor.js";

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
