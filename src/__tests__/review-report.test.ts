/**
 * P3 — structured review report (Surface C).
 *
 * `buildReviewReportView` folds a raw engine `ReviewReport` into the grouped,
 * anchored view the on-demand tool (JSON) and CLI (text) both render. These
 * tests pin the grouping, severity-driven ordering, the summary line, and the
 * plain-text render (lead vs verbose evidence, errored-checker surfacing).
 */

import { describe, expect, it } from "vitest";
import {
  buildReviewReportView,
  renderReviewReportText,
  summarizeReviewReport,
} from "../review/report.js";
import type {
  FindingAnchor,
  ReviewFinding,
  ReviewReport,
  Severity,
} from "../review/types.js";

function finding(
  over: Partial<ReviewFinding> & { anchor: FindingAnchor }
): ReviewFinding {
  return {
    checkerId: "test_checker",
    tier: 1,
    severity: "medium",
    title: "a finding",
    evidence: ["line one", "line two"],
    action: "do the thing",
    needsModel: false,
    ...over,
  };
}

function report(over: Partial<ReviewReport> = {}): ReviewReport {
  return {
    findings: [],
    suppressed: 0,
    checkersRun: ["a", "b"],
    checkersErrored: [],
    durationMs: 3,
    clean: true,
    ...over,
  };
}

describe("buildReviewReportView", () => {
  it("reports a clean pass with zero findings", () => {
    const view = buildReviewReportView(report({ clean: true }), "staged", 4);
    expect(view.clean).toBe(true);
    expect(view.total).toBe(0);
    expect(view.groups).toHaveLength(0);
    expect(view.scope).toBe("staged");
    expect(view.filesReviewed).toBe(4);
    expect(summarizeReviewReport(view)).toContain("clean");
  });

  it("groups findings by anchor and orders groups by top severity desc", () => {
    // Engine output arrives severity-desc; two anchors, the second more severe.
    const findings = [
      finding({
        anchor: { kind: "f", value: "src/a.ts" },
        severity: "medium",
        title: "medium on a",
      }),
      finding({
        anchor: { kind: "e", value: "src/b.ts::foo" },
        severity: "critical",
        title: "critical on foo",
      }),
      finding({
        anchor: { kind: "f", value: "src/a.ts" },
        severity: "low",
        title: "low on a",
      }),
    ];
    const view = buildReviewReportView(
      report({ findings, clean: false }),
      "staged",
      2
    );

    expect(view.total).toBe(3);
    expect(view.groups).toHaveLength(2);
    // Critical group sorts first despite arriving second.
    expect(view.groups[0]?.anchor).toBe("e:src/b.ts::foo");
    expect(view.groups[0]?.anchorKind).toBe("entity");
    expect(view.groups[0]?.topSeverity).toBe("critical");
    // The file group keeps both findings, its top severity is the medium.
    expect(view.groups[1]?.anchor).toBe("f:src/a.ts");
    expect(view.groups[1]?.anchorKind).toBe("file");
    expect(view.groups[1]?.topSeverity).toBe("medium");
    expect(view.groups[1]?.findings).toHaveLength(2);
  });

  it("counts findings by severity and flags needsModel + suppressed", () => {
    const findings = [
      finding({ anchor: { kind: "f", value: "x.ts" }, severity: "high" }),
      finding({
        anchor: { kind: "f", value: "y.ts" },
        severity: "high",
        needsModel: true,
        tier: 2,
      }),
    ];
    const view = buildReviewReportView(
      report({ findings, suppressed: 4, clean: false }),
      "main..HEAD",
      3
    );
    expect(view.bySeverity.high).toBe(2);
    expect(view.bySeverity.medium).toBe(0);
    expect(view.needsModel).toBe(1);
    expect(view.suppressed).toBe(4);
    expect(summarizeReviewReport(view)).toContain("2 high");
    expect(summarizeReviewReport(view)).toContain("4 below floor");
  });

  it("carries the finding's line onto the view", () => {
    const view = buildReviewReportView(
      report({
        findings: [finding({ anchor: { kind: "f", value: "x.ts", line: 42 } })],
        clean: false,
      }),
      "staged",
      1
    );
    expect(view.groups[0]?.findings[0]?.line).toBe(42);
  });
});

describe("renderReviewReportText", () => {
  const findings = [
    finding({
      anchor: { kind: "f", value: "src/config.ts", line: 7 },
      checkerId: "secret_scan",
      severity: "critical",
      title: "hardcoded AWS key",
      evidence: ["src/config.ts:7 — AWS access key", "second evidence"],
      action: "move the key to an env var",
    }),
  ];

  it("renders header, anchor, finding, lead evidence and action", () => {
    const view = buildReviewReportView(
      report({ findings, clean: false }),
      "staged",
      1
    );
    const text = renderReviewReportText(view);
    expect(text).toContain("unerr review — staged");
    expect(text).toContain("f:src/config.ts");
    expect(text).toContain("[critical] secret_scan:7 — hardcoded AWS key");
    expect(text).toContain("src/config.ts:7 — AWS access key");
    expect(text).toContain("→ move the key to an env var");
    // Lead evidence only by default.
    expect(text).not.toContain("second evidence");
  });

  it("shows every evidence line when verbose", () => {
    const view = buildReviewReportView(
      report({ findings, clean: false }),
      "staged",
      1
    );
    const text = renderReviewReportText(view, { verbose: true });
    expect(text).toContain("second evidence");
  });

  it("renders a needs-model tag for Tier-2 findings", () => {
    const view = buildReviewReportView(
      report({
        findings: [
          finding({
            anchor: { kind: "e", value: "foo" },
            needsModel: true,
            tier: 2,
            severity: "high" as Severity,
          }),
        ],
        clean: false,
      }),
      "staged",
      1
    );
    expect(renderReviewReportText(view)).toContain("[needs-model]");
  });

  it("surfaces errored checkers so a silent failure is not read as clean", () => {
    const view = buildReviewReportView(
      report({
        clean: true,
        checkersErrored: [{ checkerId: "blast_radius", error: "boom" }],
      }),
      "staged",
      1
    );
    const text = renderReviewReportText(view);
    expect(text).toContain("1 checker(s) errored");
    expect(text).toContain("blast_radius: boom");
  });
});
