import { describe, expect, it } from "vitest";
import {
  type QueryShape,
  classifyQueryShape,
} from "../intelligence/query-shape.js";

function shape(q: string): QueryShape {
  return classifyQueryShape(q).shape;
}

describe("classifyQueryShape", () => {
  describe("symbol lookups (lean path)", () => {
    it.each([
      "compressShellOutput",
      "QueryRouter",
      "QueryRouter.execute",
      "classify_task_size",
      "parseHeader",
      "fetchUser",
      "authentication", // lone English word is still a single-term lookup
      "src/proxy/proxy.ts",
      "handleUnerrContextProxy",
    ])("treats %j as a symbol", (q) => {
      expect(shape(q)).toBe("symbol");
    });

    it("treats all-identifier multi-token queries as a symbol search", () => {
      expect(shape("foo.bar baz_qux")).toBe("symbol");
      expect(shape("fetchUser parseHeader")).toBe("symbol");
    });

    it("defaults empty / whitespace to the lean path", () => {
      expect(shape("")).toBe("symbol");
      expect(shape("   ")).toBe("symbol");
    });
  });

  describe("task phrases (recon path)", () => {
    it.each([
      "add a retry to the boot path",
      "where is retry handled",
      "how does shell compression work",
      "fix the login bug",
      "refactor the error handling",
      "implement query-shape routing",
      "find callers of compressShellOutput",
      "what calls classifyTaskSize",
      "rename getUser to fetchUser",
      "trace the dispatch path from startProxy",
    ])("treats %j as a task", (q) => {
      expect(shape(q)).toBe("task");
    });

    it("routes a question to recon regardless of shape", () => {
      expect(shape("compressShellOutput?")).toBe("task");
      expect(shape("who calls execute")).toBe("task");
    });

    it("routes symbol + prose modifier to recon", () => {
      // 'callers' is a plain prose word, not a strong identifier.
      expect(shape("compressShellOutput callers")).toBe("task");
    });

    it("routes 4+ word non-identifier phrases to recon", () => {
      expect(shape("user session token refresh")).toBe("task");
    });
  });

  it("returns a non-empty reason for telemetry", () => {
    expect(classifyQueryShape("compressShellOutput").reason).toMatch(/symbol/);
    expect(
      classifyQueryShape("add a retry to fetchUser").reason.length
    ).toBeGreaterThan(0);
  });
});
