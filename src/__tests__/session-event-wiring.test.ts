/**
 * Sprint 4, Task 4.3: Session event wiring tests.
 *
 * Tests that the proxy-level event detection logic correctly identifies
 * when to record violations, circular deps, signature preservations,
 * chokepoint warnings, and dead code references from tool results.
 */

import { describe, expect, it } from "vitest";
import {
  createSessionStats,
  recordChokepointWarning,
  recordCircularDep,
  recordDeadCodeReference,
  recordSignaturePreservation,
  recordViolation,
  totalCaughtEvents,
} from "../proxy/session-stats.js";

// ── Convention Violation Wiring ──────────────────────────────────────

describe("Convention violation wiring (check_rules)", () => {
  it("records one violation per check_rules violation entry", () => {
    const stats = createSessionStats();

    // Simulate check_rules result with 3 violations
    const checkResult = {
      violations: [
        { ruleKey: "naming-1", message: "bad name" },
        { ruleKey: "naming-2", message: "wrong case" },
        { ruleKey: "struct-1", message: "missing type" },
      ],
    };

    if (checkResult.violations && checkResult.violations.length > 0) {
      for (let i = 0; i < checkResult.violations.length; i++) {
        recordViolation(stats);
      }
    }

    expect(stats.violationsCaught).toBe(3);
    expect(stats.events.conventionViolationsCaught).toBe(3);
  });

  it("does not record violations when check_rules has empty violations", () => {
    const stats = createSessionStats();
    const checkResult = { violations: [] as Array<{ ruleKey: string }> };

    if (checkResult.violations && checkResult.violations.length > 0) {
      for (let i = 0; i < checkResult.violations.length; i++) {
        recordViolation(stats);
      }
    }

    expect(stats.violationsCaught).toBe(0);
  });

  it("does not record violations when check_rules has no violations field", () => {
    const stats = createSessionStats();
    const checkResult = { _meta: { source: "local" } } as {
      violations?: Array<{ ruleKey: string }>;
    };

    if (checkResult.violations && checkResult.violations.length > 0) {
      for (let i = 0; i < checkResult.violations.length; i++) {
        recordViolation(stats);
      }
    }

    expect(stats.violationsCaught).toBe(0);
  });
});

// ── Circular Dependency Detection ────────────────────────────────────

describe("Circular dependency detection (get_imports)", () => {
  it("detects circular import when file appears in its own imports", () => {
    const stats = createSessionStats();

    // File A imports B, and its own file path — circular
    const imports = [
      { imported_file: "src/b.ts" },
      { imported_file: "src/a.ts" },
    ];
    const filePath = "src/a.ts";

    const importedFiles = new Set(imports.map((e) => e.imported_file));
    for (const target of importedFiles) {
      if (target === filePath) {
        recordCircularDep(stats);
        break;
      }
    }

    expect(stats.events.circularDepsDetected).toBe(1);
  });

  it("does not detect circular when file is not in its own imports", () => {
    const stats = createSessionStats();

    // A imports B and C — no circular
    const imports = [
      { imported_file: "src/b.ts" },
      { imported_file: "src/c.ts" },
    ];
    const filePath = "src/a.ts";

    const importedFiles = new Set(imports.map((e) => e.imported_file));
    for (const target of importedFiles) {
      if (target === filePath) {
        recordCircularDep(stats);
        break;
      }
    }

    expect(stats.events.circularDepsDetected).toBe(0);
  });

  it("counts only once per call", () => {
    const stats = createSessionStats();

    const imports = [
      { imported_file: "src/a.ts" },
      { imported_file: "src/b.ts" },
    ];
    const filePath = "src/a.ts";

    const importedFiles = new Set(imports.map((e) => e.imported_file));
    for (const target of importedFiles) {
      if (target === filePath) {
        recordCircularDep(stats);
        break;
      }
    }

    expect(stats.events.circularDepsDetected).toBe(1);
  });

  it("handles empty imports array", () => {
    const stats = createSessionStats();
    const imports: Array<{ imported_file: string }> = [];

    const importedFiles = new Set(imports.map((e) => e.imported_file));
    for (const target of importedFiles) {
      if (target === "src/a.ts") {
        recordCircularDep(stats);
        break;
      }
    }

    expect(stats.events.circularDepsDetected).toBe(0);
  });
});

// ── Signature Preservation ───────────────────────────────────────────

describe("Signature preservation detection (drift)", () => {
  it("records preservation when drift status is 'modified'", () => {
    const stats = createSessionStats();

    const drift = { entityStatus: "modified" } as {
      entityStatus: string | null;
    };

    if (drift.entityStatus === "modified") {
      recordSignaturePreservation(stats);
    }

    expect(stats.events.signaturePreservations).toBe(1);
  });

  it("does not record for 'added' drift status", () => {
    const stats = createSessionStats();

    const drift = { entityStatus: "added" } as {
      entityStatus: string | null;
    };

    if (drift.entityStatus === "modified") {
      recordSignaturePreservation(stats);
    }

    expect(stats.events.signaturePreservations).toBe(0);
  });

  it("does not record when drift is null", () => {
    const stats = createSessionStats();

    const drift = null as { entityStatus: string | null } | null;

    if (drift?.entityStatus === "modified") {
      recordSignaturePreservation(stats);
    }

    expect(stats.events.signaturePreservations).toBe(0);
  });
});

// ── Chokepoint Warning ───────────────────────────────────────────────

describe("Chokepoint warning detection", () => {
  it("records warning when fan_in > 10 and risk is high", () => {
    const stats = createSessionStats();

    const entityRisk = { fan_in: 15, fan_out: 3, risk_level: "high" };

    if (entityRisk.risk_level === "high" && entityRisk.fan_in > 10) {
      recordChokepointWarning(stats);
    }

    expect(stats.events.chokepointWarningsIssued).toBe(1);
  });

  it("does not record when fan_in <= 10 even with high risk", () => {
    const stats = createSessionStats();

    const entityRisk = { fan_in: 8, fan_out: 3, risk_level: "high" };

    if (entityRisk.risk_level === "high" && entityRisk.fan_in > 10) {
      recordChokepointWarning(stats);
    }

    expect(stats.events.chokepointWarningsIssued).toBe(0);
  });
});

// ── Dead Code Reference ──────────────────────────────────────────────

describe("Dead code reference detection", () => {
  it("records when fan_in is exactly 0", () => {
    const stats = createSessionStats();

    const entityRisk = { fan_in: 0, fan_out: 3, risk_level: "normal" };

    if (entityRisk.fan_in === 0) {
      recordDeadCodeReference(stats);
    }

    expect(stats.events.deadCodeReferences).toBe(1);
  });

  it("does not record when fan_in > 0", () => {
    const stats = createSessionStats();

    const entityRisk = { fan_in: 2, fan_out: 3, risk_level: "normal" };

    if (entityRisk.fan_in === 0) {
      recordDeadCodeReference(stats);
    }

    expect(stats.events.deadCodeReferences).toBe(0);
  });
});

// ── Combined Event Tracking ──────────────────────────────────────────

describe("Combined event tracking across tool calls", () => {
  it("totalCaughtEvents reflects all event types from a session", () => {
    const stats = createSessionStats();

    // Simulate a session with multiple events
    recordViolation(stats); // check_rules found violation
    recordViolation(stats); // check_rules found another
    recordChokepointWarning(stats); // high-risk entity queried
    recordCircularDep(stats); // circular import detected
    recordSignaturePreservation(stats); // modified entity accessed
    recordDeadCodeReference(stats); // dead code flagged

    expect(totalCaughtEvents(stats.events)).toBe(6);
    expect(stats.events.conventionViolationsCaught).toBe(2);
    expect(stats.events.chokepointWarningsIssued).toBe(1);
    expect(stats.events.circularDepsDetected).toBe(1);
    expect(stats.events.signaturePreservations).toBe(1);
    expect(stats.events.deadCodeReferences).toBe(1);
  });

  it("violationsCaught is separate from events.conventionViolationsCaught", () => {
    const stats = createSessionStats();
    recordViolation(stats);

    // Both should track (violationsCaught is the legacy counter)
    expect(stats.violationsCaught).toBe(1);
    expect(stats.events.conventionViolationsCaught).toBe(1);
  });
});
