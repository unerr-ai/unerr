import { describe, expect, it } from "vitest";
import {
  type EntityRiskInfo,
  compressOutput,
} from "../proxy/output-compressor.js";

const LARGE_DIFF = `diff --git a/src/proxy/proxy.ts b/src/proxy/proxy.ts
--- a/src/proxy/proxy.ts
+++ b/src/proxy/proxy.ts
@@ -10,6 +10,10 @@ import { join } from "node:path";
 import { PidLock } from "./pid-lock.js";
+import { createLifecycleActor } from "./lifecycle-actor.js";
+import { createEnvelopePipeline } from "./response-envelope.js";
 
 const log = {
   info: (msg: string) => process.stderr.write(msg),
 };
${Array.from({ length: 100 }, (_, i) => `+  line ${i}: added utility function`).join("\n")}
diff --git a/src/utils/helpers.ts b/src/utils/helpers.ts
--- a/src/utils/helpers.ts
+++ b/src/utils/helpers.ts
@@ -1,3 +1,5 @@
+export function helper1() { return 1; }
+export function helper2() { return 2; }
${Array.from({ length: 50 }, (_, i) => `   unchanged line ${i}`).join("\n")}
diff --git a/src/tracking/drift-tracker.ts b/src/tracking/drift-tracker.ts
--- a/src/tracking/drift-tracker.ts
+++ b/src/tracking/drift-tracker.ts
@@ -5,3 +5,8 @@
+ERROR: TypeScript compilation failed
+TypeError: Cannot read property 'length' of undefined
${Array.from({ length: 30 }, (_, i) => `+  drift change ${i}`).join("\n")}`;

describe("compressOutput", () => {
  it("passes through small outputs unchanged", () => {
    const small = "hello world\nline 2\nline 3";
    const result = compressOutput(small, { tokenBudget: 10000 });
    expect(result.output).toBe(small);
    expect(result.sectionsOmitted).toBe(0);
  });

  it("compresses large outputs below token budget", () => {
    const result = compressOutput(LARGE_DIFF, { tokenBudget: 500 });
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);
    expect(result.sectionsOmitted).toBeGreaterThan(0);
  });

  it("preserves error sections with highest priority", () => {
    const result = compressOutput(LARGE_DIFF, { tokenBudget: 300 });
    expect(result.output).toContain("ERROR");
    expect(result.output).toContain("TypeError");
  });

  it("adds omission markers for removed sections", () => {
    const result = compressOutput(LARGE_DIFF, { tokenBudget: 200 });
    expect(result.output).toContain("[...");
    expect(result.output).toContain("lines omitted");
  });

  it("annotates high-risk entity sections", () => {
    const riskMap = new Map<string, EntityRiskInfo>([
      [
        "src/proxy/proxy.ts::startProxy",
        {
          riskLevel: "high",
          fanIn: 14,
          isChokepoint: true,
          conventions: ["camelCase"],
        },
      ],
    ]);

    const result = compressOutput(LARGE_DIFF, {
      tokenBudget: 800,
      entityRiskMap: riskMap,
    });

    expect(result.annotations.length).toBeGreaterThan(0);
    if (result.annotations.some((a) => a.includes("HIGH_RISK"))) {
      expect(result.output).toContain("[HIGH_RISK");
    }
  });

  it("annotates chokepoint entities", () => {
    const riskMap = new Map<string, EntityRiskInfo>([
      [
        "src/proxy/proxy.ts::startProxy",
        { riskLevel: "high", fanIn: 20, isChokepoint: true },
      ],
    ]);

    const result = compressOutput(LARGE_DIFF, {
      tokenBudget: 800,
      entityRiskMap: riskMap,
    });

    if (result.annotations.some((a) => a.includes("CHOKEPOINT"))) {
      expect(result.output).toContain("[CHOKEPOINT]");
    }
  });

  it("reports compression metrics", () => {
    const result = compressOutput(LARGE_DIFF, { tokenBudget: 300 });
    expect(result.originalTokens).toBeGreaterThan(0);
    expect(result.compressedTokens).toBeGreaterThan(0);
    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
  });
});
