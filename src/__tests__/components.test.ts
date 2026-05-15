/**
 * Tests for Sprint 1 Ink components (Task 1.2).
 *
 * Tests validate:
 *   - Banner: renders brand name and tagline
 *   - Section: renders title with line decoration
 *   - KeyValue: renders label and value with alignment
 *   - ProgressBar: sub-character Unicode blocks, clamping, label
 *   - GradeBadge: colored grade with optional score
 *   - StepLine: icon + label + value for each status
 *   - HealthCard: grade + bar + dead functions + chokepoints
 *   - DriftSummary: modified/added/deleted counts
 *   - ViolationList: severity icons + messages + suggestions
 *   - SessionSummaryCard: tool calls, local rate, savings, latency
 *   - InkSpinner: renders frame and label
 *   - ConfirmPrompt: renders message and hint
 */

import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { Banner } from "../components/Banner.js";
import { ConfirmPrompt } from "../components/ConfirmPrompt.js";
import { DriftSummary } from "../components/DriftSummary.js";
import { GradeBadge } from "../components/GradeBadge.js";
import { HealthCard } from "../components/HealthCard.js";
import { InkSpinner } from "../components/InkSpinner.js";
import { KeyValue } from "../components/KeyValue.js";
import { BLOCKS, ProgressBar } from "../components/ProgressBar.js";
import { Section } from "../components/Section.js";
import { SessionSummaryCard } from "../components/SessionSummaryCard.js";
import { StepLine } from "../components/StepLine.js";
import { ViolationList } from "../components/ViolationList.js";
import { createSessionStats } from "../proxy/session-stats.js";

// ── Banner ───────────────────────────────────────────────────────

describe("Banner", () => {
  it("renders brand name", () => {
    const { lastFrame } = render(React.createElement(Banner));
    expect(lastFrame()).toContain("unerr");
  });

  it("renders tagline", () => {
    const { lastFrame } = render(React.createElement(Banner));
    expect(lastFrame()).toContain("Code intelligence");
  });

  it("renders separator", () => {
    const { lastFrame } = render(React.createElement(Banner));
    expect(lastFrame()).toContain("▸");
  });
});

// ── Section ──────────────────────────────────────────────────────

describe("Section", () => {
  it("renders title with line decoration", () => {
    const { lastFrame } = render(
      React.createElement(Section, { title: "First Look" })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("──");
    expect(frame).toContain("First Look");
  });

  it("renders with custom width", () => {
    const { lastFrame } = render(
      React.createElement(Section, { title: "Test", width: 30 })
    );
    expect(lastFrame()).toContain("──");
    expect(lastFrame()).toContain("Test");
  });
});

// ── KeyValue ─────────────────────────────────────────────────────

describe("KeyValue", () => {
  it("renders label and value", () => {
    const { lastFrame } = render(
      React.createElement(KeyValue, {
        label: "Repository",
        value: "acme/widgets",
      })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Repository");
    expect(frame).toContain("acme/widgets");
  });

  it("pads label to specified width", () => {
    const { lastFrame } = render(
      React.createElement(KeyValue, {
        label: "Key",
        value: "val",
        labelWidth: 10,
      })
    );
    // Label "Key" padded to 10 chars
    expect(lastFrame()).toContain("Key");
    expect(lastFrame()).toContain("val");
  });
});

// ── ProgressBar ──────────────────────────────────────────────────

describe("ProgressBar", () => {
  it("renders empty bar for value 0", () => {
    const { lastFrame } = render(
      React.createElement(ProgressBar, { value: 0, width: 10 })
    );
    const frame = lastFrame() ?? "";
    // Should be all spaces (empty bar)
    expect(frame.includes("█")).toBe(false);
  });

  it("renders full bar for value 1", () => {
    const { lastFrame } = render(
      React.createElement(ProgressBar, { value: 1, width: 10 })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("██████████");
  });

  it("renders partial fill for value 0.5", () => {
    const { lastFrame } = render(
      React.createElement(ProgressBar, { value: 0.5, width: 10 })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("█████");
  });

  it("shows percentage label when showLabel is true", () => {
    const { lastFrame } = render(
      React.createElement(ProgressBar, {
        value: 0.62,
        width: 10,
        showLabel: true,
      })
    );
    expect(lastFrame()).toContain("62%");
  });

  it("clamps value above 1 to 100%", () => {
    const { lastFrame } = render(
      React.createElement(ProgressBar, {
        value: 1.5,
        width: 5,
        showLabel: true,
      })
    );
    expect(lastFrame()).toContain("100%");
  });

  it("clamps value below 0 to 0%", () => {
    const { lastFrame } = render(
      React.createElement(ProgressBar, {
        value: -0.5,
        width: 5,
        showLabel: true,
      })
    );
    expect(lastFrame()).toContain("0%");
  });

  it("BLOCKS array has 9 sub-character elements", () => {
    expect(BLOCKS).toHaveLength(9);
    expect(BLOCKS[0]).toBe(" ");
    expect(BLOCKS[8]).toBe("█");
  });
});

// ── GradeBadge ───────────────────────────────────────────────────

describe("GradeBadge", () => {
  it("renders grade letter", () => {
    const { lastFrame } = render(
      React.createElement(GradeBadge, { grade: "A" })
    );
    expect(lastFrame()).toContain("A");
  });

  it("renders grade with score when provided", () => {
    const { lastFrame } = render(
      React.createElement(GradeBadge, { grade: "C+", score: 62 })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("C+");
    expect(frame).toContain("62/100");
  });

  it("renders without score when not provided", () => {
    const { lastFrame } = render(
      React.createElement(GradeBadge, { grade: "B+" })
    );
    expect(lastFrame()).toContain("B+");
    expect(lastFrame()).not.toContain("/100");
  });
});

// ── StepLine ─────────────────────────────────────────────────────

describe("StepLine", () => {
  it("renders done status with check icon", () => {
    const { lastFrame } = render(
      React.createElement(StepLine, {
        label: "Authenticated",
        value: "Org",
        status: "done",
      })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
    expect(frame).toContain("Authenticated");
    expect(frame).toContain("Org");
  });

  it("renders active status with filled circle", () => {
    const { lastFrame } = render(
      React.createElement(StepLine, {
        label: "Loading",
        status: "active",
      })
    );
    expect(lastFrame()).toContain("●");
    expect(lastFrame()).toContain("Loading");
  });

  it("renders error status with cross icon", () => {
    const { lastFrame } = render(
      React.createElement(StepLine, {
        label: "Failed",
        status: "error",
      })
    );
    expect(lastFrame()).toContain("✗");
  });

  it("renders pending status with empty circle", () => {
    const { lastFrame } = render(
      React.createElement(StepLine, {
        label: "Waiting",
        status: "pending",
      })
    );
    expect(lastFrame()).toContain("○");
  });
});

// ── HealthCard ───────────────────────────────────────────────────

describe("HealthCard", () => {
  const baseHealth = {
    grade: "C+",
    totalEntities: 2341,
    totalEdges: 1892,
    totalRules: 12,
    deadFunctionCount: 23,
    highRiskEntities: [
      {
        name: "processPayment",
        kind: "function",
        file_path: "src/billing.ts",
        fan_in: 14,
        fan_out: 8,
      },
    ],
    score: 62,
  };

  it("renders grade and score in full mode", () => {
    const { lastFrame } = render(
      React.createElement(HealthCard, { health: baseHealth })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("C+");
    expect(frame).toContain("62/100");
  });

  it("renders dead function warning", () => {
    const { lastFrame } = render(
      React.createElement(HealthCard, { health: baseHealth })
    );
    expect(lastFrame()).toContain("23 dead functions");
  });

  it("renders chokepoint warning with fan counts", () => {
    const { lastFrame } = render(
      React.createElement(HealthCard, { health: baseHealth })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("processPayment");
    expect(frame).toContain("14 callers");
    expect(frame).toContain("8 callees");
    expect(frame).toContain("chokepoint");
  });

  it("renders compact mode with entity/edge counts", () => {
    const { lastFrame } = render(
      React.createElement(HealthCard, { health: baseHealth, compact: true })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("C+");
    expect(frame).toContain("2341 entities");
    expect(frame).toContain("1892 edges");
  });

  it("omits dead function line when count is 0", () => {
    const healthy = { ...baseHealth, deadFunctionCount: 0 };
    const { lastFrame } = render(
      React.createElement(HealthCard, { health: healthy })
    );
    expect(lastFrame()).not.toContain("dead function");
  });
});

// ── DriftSummary ─────────────────────────────────────────────────

describe("DriftSummary", () => {
  it("renders zero drift message", () => {
    const { lastFrame } = render(
      React.createElement(DriftSummary, {
        drift: { modified: 0, added: 0, deleted: 0 },
      })
    );
    expect(lastFrame()).toContain("No drift detected");
  });

  it("renders modified count", () => {
    const { lastFrame } = render(
      React.createElement(DriftSummary, {
        drift: { modified: 5, added: 0, deleted: 0 },
      })
    );
    expect(lastFrame()).toContain("5 modified");
  });

  it("renders all drift types", () => {
    const { lastFrame } = render(
      React.createElement(DriftSummary, {
        drift: { modified: 3, added: 2, deleted: 1 },
      })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("6 drifted entities");
    expect(frame).toContain("3 modified");
    expect(frame).toContain("2 added");
    expect(frame).toContain("1 deleted");
  });

  it("uses singular 'entity' for count of 1", () => {
    const { lastFrame } = render(
      React.createElement(DriftSummary, {
        drift: { modified: 1, added: 0, deleted: 0 },
      })
    );
    expect(lastFrame()).toContain("1 drifted entity");
  });
});

// ── ViolationList ────────────────────────────────────────────────

describe("ViolationList", () => {
  it("renders no-violations message when empty", () => {
    const { lastFrame } = render(
      React.createElement(ViolationList, { violations: [] })
    );
    expect(lastFrame()).toContain("No violations");
  });

  it("renders error violation with cross icon", () => {
    const { lastFrame } = render(
      React.createElement(ViolationList, {
        violations: [
          { message: "Missing return type", severity: "error" as const },
        ],
      })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("Missing return type");
  });

  it("renders warning violation with warning icon", () => {
    const { lastFrame } = render(
      React.createElement(ViolationList, {
        violations: [
          { message: "Unused import", severity: "warning" as const },
        ],
      })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚠");
    expect(frame).toContain("Unused import");
  });

  it("renders file path when provided", () => {
    const { lastFrame } = render(
      React.createElement(ViolationList, {
        violations: [
          {
            message: "Bad naming",
            severity: "info" as const,
            file: "src/foo.ts",
          },
        ],
      })
    );
    expect(lastFrame()).toContain("src/foo.ts");
  });

  it("renders suggestion when provided", () => {
    const { lastFrame } = render(
      React.createElement(ViolationList, {
        violations: [
          {
            message: "Unused var",
            severity: "warning" as const,
            suggestion: "Remove or prefix with _",
          },
        ],
      })
    );
    expect(lastFrame()).toContain("Remove or prefix with _");
  });

  it("renders violation count in title", () => {
    const { lastFrame } = render(
      React.createElement(ViolationList, {
        violations: [
          { message: "Issue 1", severity: "error" as const },
          { message: "Issue 2", severity: "warning" as const },
        ],
        title: "Violations",
      })
    );
    expect(lastFrame()).toContain("2 violations");
  });
});

// ── SessionSummaryCard ───────────────────────────────────────────

describe("SessionSummaryCard", () => {
  it("renders tool call counts in full summary", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 15;
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("15 (all local)");
  });

  it("renders local rate with progress bar", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 16;
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats })
    );
    expect(lastFrame()).toContain("100%");
    expect(lastFrame()).toContain("Local rate");
  });

  it("renders session section header with duration", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 20;
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats })
    );
    expect(lastFrame()).toContain("unerr session");
  });

  it("renders specific caught event labels", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 20;
    stats.events.conventionViolationsCaught = 3;
    stats.events.chokepointWarningsIssued = 2;
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Caught:");
    expect(frame).toContain("3 convention violations before commit");
    expect(frame).toContain("2 chokepoint modifications warned");
  });

  it("renders one-liner for short sessions (≤10 tool calls)", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 5;
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("5 tool calls");
    // Should NOT show full section header
    expect(frame).not.toContain("Tool calls");
  });

  it("renders nothing when zero tool calls", () => {
    const stats = createSessionStats();
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats })
    );
    expect(lastFrame()).toBe("");
  });

  it("renders deep link when provided", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 20;
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, {
        stats,
        deepLink: "https://app.unerr.dev/r/repo_123?utm_source=cli_session",
      })
    );
    expect(lastFrame()).toContain("https://app.unerr.dev/r/repo_123");
  });

  it("renders cumulative this-week stats", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 20;
    const cumulative = {
      totalTokensSaved: 100000,
      totalDollarsSaved: 5.6,
      totalSessions: 4,
      weekStart: "2026-04-06",
      violationsCaughtAllTime: 12,
      chokepointWarningsAllTime: 3,
    };
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats, cumulative })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("This week:");
    expect(frame).toContain("4 sessions");
    expect(frame).toContain("$5.60");
  });

  it("omits caught section when no events", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 20;
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats })
    );
    expect(lastFrame()).not.toContain("Caught:");
  });

  it("renders token savings", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 20;
    stats.estimatedTokensSaved = 64000;
    const { lastFrame } = render(
      React.createElement(SessionSummaryCard, { stats })
    );
    expect(lastFrame()).toContain("64.0k tokens");
  });
});

// ── InkSpinner ───────────────────────────────────────────────────

describe("InkSpinner", () => {
  it("renders label text", () => {
    const { lastFrame } = render(
      React.createElement(InkSpinner, { label: "Loading graph..." })
    );
    expect(lastFrame()).toContain("Loading graph...");
  });

  it("renders a spinner frame character", () => {
    const { lastFrame } = render(
      React.createElement(InkSpinner, { label: "test" })
    );
    const frame = lastFrame() ?? "";
    // Should contain one of the braille spinner chars
    expect(frame.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)).toBeTruthy();
  });
});

// ── ConfirmPrompt ────────────────────────────────────────────────

describe("ConfirmPrompt", () => {
  it("renders message and default-yes hint", () => {
    const { lastFrame } = render(
      React.createElement(ConfirmPrompt, {
        message: "Delete this?",
        onConfirm: () => {},
        defaultYes: true,
      })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Delete this?");
    expect(frame).toContain("[Y/n]");
  });

  it("renders default-no hint", () => {
    const { lastFrame } = render(
      React.createElement(ConfirmPrompt, {
        message: "Proceed?",
        onConfirm: () => {},
        defaultYes: false,
      })
    );
    expect(lastFrame()).toContain("[y/N]");
  });
});
