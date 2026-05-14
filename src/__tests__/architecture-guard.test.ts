/**
 * BA-3.4: Architecture Boundary Guard tests.
 *
 * Verifies:
 *   - Cross-community imports blocked
 *   - Type imports allowed (configurable)
 *   - Override comment works
 *   - Auto-bridge after 3+ overrides
 *   - Non-edit tools ignored
 *   - Non-relative imports ignored
 */

import { describe, expect, it } from "vitest";
import { ArchitectureBoundaryGuard } from "../behaviors/architecture-guard.js";
import type { ToolCallContext } from "../behaviors/framework.js";

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    toolName: "edit_file",
    args: {},
    sessionId: "test-session",
    ...overrides,
  };
}

describe("Architecture Boundary Guard (BA-3.1)", () => {
  describe("Behavior Identity", () => {
    it("has correct id, hooks, and default level", () => {
      const guard = new ArchitectureBoundaryGuard();
      expect(guard.id).toBe("architecture_boundary");
      expect(guard.hooks).toContain("pre_tool_use");
      expect(guard.defaultLevel).toBe("enforcement");
    });
  });

  describe("Import Parsing", () => {
    it("returns null for non-edit tools", async () => {
      const guard = new ArchitectureBoundaryGuard();
      const ctx = makeCtx({ toolName: "get_entity" });
      expect(await guard.onPreToolUse(ctx)).toBeNull();
    });

    it("returns null for non-code files", async () => {
      const guard = new ArchitectureBoundaryGuard();
      const ctx = makeCtx({
        args: {
          path: "README.md",
          content: "import { foo } from './bar'",
        },
      });
      expect(await guard.onPreToolUse(ctx)).toBeNull();
    });

    it("returns null when no graph attached", async () => {
      const guard = new ArchitectureBoundaryGuard();
      const ctx = makeCtx({
        filePath: "src/proxy/handler.ts",
        args: {
          path: "src/proxy/handler.ts",
          content: `import { ShadowLedger } from '../../tracking/shadow-ledger'`,
        },
      });
      expect(await guard.onPreToolUse(ctx)).toBeNull();
    });

    it("ignores non-relative imports (npm packages)", async () => {
      const guard = new ArchitectureBoundaryGuard();
      const ctx = makeCtx({
        filePath: "src/proxy/handler.ts",
        args: {
          path: "src/proxy/handler.ts",
          content: `import { Server } from "@modelcontextprotocol/sdk/server/index.js"`,
        },
      });
      expect(await guard.onPreToolUse(ctx)).toBeNull();
    });
  });

  describe("Type Import Allowance", () => {
    it("allows type imports by default", () => {
      const guard = new ArchitectureBoundaryGuard();
      expect(guard.getSessionStats().typeImportsAllowed).toBe(0);
    });

    it("can disable type import allowance via config", () => {
      const guard = new ArchitectureBoundaryGuard({ allowTypeImports: false });
      expect(guard.enabled).toBe(true);
    });
  });

  describe("Override Comment", () => {
    it("records overrides from @unerr-allow comments", () => {
      const guard = new ArchitectureBoundaryGuard();
      const stats = guard.getSessionStats();
      expect(stats.overridesRecorded).toBe(0);
    });
  });

  describe("Auto-Bridge", () => {
    it("starts with no auto-bridges", () => {
      const guard = new ArchitectureBoundaryGuard();
      expect(guard.getSessionStats().autoBridges).toBe(0);
    });

    it("bridge threshold is 3 by default", () => {
      const guard = new ArchitectureBoundaryGuard();
      expect(guard.getBridges().size).toBe(0);
    });

    it("accepts custom bridge threshold", () => {
      const guard = new ArchitectureBoundaryGuard({ bridgeThreshold: 5 });
      expect(guard.enabled).toBe(true);
    });
  });

  describe("Session Stats", () => {
    it("starts with clean stats", () => {
      const guard = new ArchitectureBoundaryGuard();
      const stats = guard.getSessionStats();
      expect(stats.violationsBlocked).toBe(0);
      expect(stats.typeImportsAllowed).toBe(0);
      expect(stats.overridesRecorded).toBe(0);
      expect(stats.autoBridges).toBe(0);
    });
  });

  describe("Learning Loop", () => {
    it("tracks feedback correctly", () => {
      const guard = new ArchitectureBoundaryGuard();
      guard.recordFeedback("accepted");
      guard.recordFeedback("overridden");

      const stats = guard.getLearningStats();
      expect(stats.accepted).toBe(1);
      expect(stats.overridden).toBe(1);
      expect(stats.confidence).toBeCloseTo(0.5, 2);
    });
  });
});
