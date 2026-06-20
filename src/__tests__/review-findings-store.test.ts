/**
 * P5/P6 — review findings store + lifecycle, SARIF export, recap framing.
 *
 * Covers:
 *  - FindingsStore upsert-by-content-key (no dupes across re-reviews),
 *    auto-resolve of fallen-out findings, dismiss, dismissed-survives-rereview.
 *  - reviewReportToSarif → valid SARIF 2.1.0 (rules, levels, locations).
 *  - buildRecapSnapshot / buildPreventionRecap / renderRecapText (free vs paid).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FindingsStore, computeFindingKey } from "../review/findings-store.js";
import {
  buildPreventionRecap,
  buildRecapSnapshot,
  buildReviewReportView,
  renderRecapText,
} from "../review/report.js";
import { reviewReportToSarif, severityToSarifLevel } from "../review/sarif.js";
import type {
  FindingAnchor,
  ReviewFinding,
  ReviewReport,
} from "../review/types.js";

function finding(
  over: Partial<ReviewFinding> & { anchor: FindingAnchor }
): ReviewFinding {
  return {
    checkerId: "breaking_caller",
    tier: 1,
    severity: "high",
    title: "9 callers mismatch changed signature of foo",
    evidence: ["src/a.ts:42 calls foo(x)"],
    action: "update the 9 callers of foo",
    needsModel: false,
    ...over,
  };
}

function report(findings: ReviewFinding[]): ReviewReport {
  return {
    findings,
    suppressed: 0,
    checkersRun: ["breaking_caller"],
    checkersErrored: [],
    durationMs: 3,
    clean: findings.length === 0,
  };
}

function view(findings: ReviewFinding[]) {
  return buildReviewReportView(report(findings), "staged", 2);
}

describe("computeFindingKey", () => {
  it("is stable for the same material and distinct for different titles", () => {
    const a = computeFindingKey({
      checkerId: "breaking_caller",
      targetFile: "src/a.ts",
      title: "9 callers mismatch",
    });
    const b = computeFindingKey({
      checkerId: "breaking_caller",
      targetFile: "src/a.ts",
      title: "9 callers mismatch",
    });
    const c = computeFindingKey({
      checkerId: "breaking_caller",
      targetFile: "src/a.ts",
      title: "8 callers mismatch",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("FindingsStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-findings-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts in place — re-recording the same finding stays one row", () => {
    const f = finding({ anchor: { kind: "f", value: "src/a.ts", line: 10 } });
    const store = new FindingsStore(dir);
    store.record(view([f]));
    expect(store.all()).toHaveLength(1);
    const firstSeen = store.all()[0]?.firstSeenAt;

    // Re-review: same finding → same key → still one row, firstSeenAt preserved.
    store.record(view([f]), {}, Date.now() + 1000);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]?.firstSeenAt).toBe(firstSeen);
  });

  it("persists across instances (atomic write + reload)", () => {
    const f = finding({ anchor: { kind: "f", value: "src/a.ts" } });
    const s1 = new FindingsStore(dir);
    s1.record(view([f]));
    s1.save();

    const s2 = new FindingsStore(dir);
    expect(s2.all()).toHaveLength(1);
    expect(s2.open()).toHaveLength(1);
  });

  it("auto-resolves findings no longer present", () => {
    const f1 = finding({ anchor: { kind: "f", value: "src/a.ts" } });
    const f2 = finding({
      anchor: { kind: "f", value: "src/b.ts" },
      title: "dead import in src/b.ts",
      checkerId: "dead_code",
    });
    const store = new FindingsStore(dir);
    store.record(view([f1, f2]));
    expect(store.open()).toHaveLength(2);

    // Next review only f1 remains → f2 should resolve.
    const present = store.record(view([f1]));
    store.markResolved(present);
    expect(store.open()).toHaveLength(1);
    expect(store.all().filter((x) => x.state === "resolved")).toHaveLength(1);
  });

  it("dismiss is terminal and survives re-review", () => {
    const f = finding({ anchor: { kind: "f", value: "src/a.ts" } });
    const store = new FindingsStore(dir);
    const present = store.record(view([f]));
    const key = [...present][0];
    expect(key).toBeDefined();
    expect(store.dismiss(key as string)).toBe(true);
    expect(store.get(key as string)?.state).toBe("dismissed");

    // Re-recording the same finding must NOT re-open it.
    store.record(view([f]));
    expect(store.get(key as string)?.state).toBe("dismissed");
    expect(store.open()).toHaveLength(0);
  });

  it("dismiss on an unknown key returns false", () => {
    const store = new FindingsStore(dir);
    expect(store.dismiss("nope")).toBe(false);
  });

  it("tags blast_radius findings as advisory, others as defect", () => {
    const advisory = finding({
      checkerId: "blast_radius",
      anchor: { kind: "e", value: "src/a.ts:foo" },
      title: "foo has fan-in 12",
    });
    const defect = finding({ anchor: { kind: "f", value: "src/a.ts" } });
    const store = new FindingsStore(dir);
    store.record(view([advisory, defect]));
    const kinds = store
      .all()
      .map((f) => f.kind)
      .sort();
    expect(kinds).toEqual(["advisory", "defect"]);
  });
});

describe("reviewReportToSarif", () => {
  it("maps severities to SARIF levels", () => {
    expect(severityToSarifLevel("critical")).toBe("error");
    expect(severityToSarifLevel("high")).toBe("warning");
    expect(severityToSarifLevel("medium")).toBe("note");
    expect(severityToSarifLevel("low")).toBe("note");
    expect(severityToSarifLevel("info")).toBe("note");
  });

  it("produces a valid 2.1.0 log with rules, results and locations", () => {
    const f = finding({ anchor: { kind: "f", value: "src/a.ts", line: 42 } });
    const log = reviewReportToSarif(view([f]), "0.3.4");

    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif-schema-2.1.0");
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0];
    expect(run?.tool.driver.name).toBe("unerr");
    expect(run?.tool.driver.version).toBe("0.3.4");
    expect(run?.tool.driver.rules.map((r) => r.id)).toContain(
      "breaking_caller"
    );

    const result = run?.results[0];
    expect(result?.ruleId).toBe("breaking_caller");
    expect(result?.level).toBe("warning");
    const loc = result?.locations?.[0]?.physicalLocation;
    expect(loc?.artifactLocation.uri).toBe("src/a.ts");
    expect(loc?.region?.startLine).toBe(42);
  });

  it("omits physicalLocation for entity-bound findings", () => {
    const f = finding({ anchor: { kind: "e", value: "src/a.ts:foo" } });
    const log = reviewReportToSarif(view([f]));
    expect(log.runs[0]?.results[0]?.locations).toBeUndefined();
  });
});

describe("recap framing", () => {
  it("free snapshot is counts only with an upgrade nudge", () => {
    const f = finding({ anchor: { kind: "f", value: "src/a.ts" } });
    const v = view([f]);
    const snap = buildRecapSnapshot(v);
    expect(snap.total).toBe(1);
    expect(snap.bySeverity.high).toBe(1);

    const text = renderRecapText(v, report([f]), { gated: false });
    expect(text).toContain("1 finding ready");
    expect(text).toContain("(Pro)");
    // No prevention detail / token total in the free framing.
    expect(text).not.toContain("tokens saved");
  });

  it("paid recap names defects, top findings and tokens prevented", () => {
    const f = finding({
      anchor: { kind: "f", value: "src/a.ts", line: 10 },
      tokensPrevented: 1200,
    });
    const v = view([f]);
    const recap = buildPreventionRecap(v, report([f]));
    expect(recap.defects).toBe(1);
    expect(recap.tokensPrevented).toBe(1200);
    expect(recap.topFindings[0]?.location).toBe("src/a.ts:10");

    const text = renderRecapText(v, report([f]), { gated: true });
    expect(text).toContain("unerr prevented 1 issue");
    expect(text).toContain("1200 tokens saved");
    expect(text).toContain("→ update the 9 callers of foo");
  });

  it("clean report recap is a single clean line on both tiers", () => {
    const v = view([]);
    expect(renderRecapText(v, report([]), { gated: false })).toContain("clean");
    expect(renderRecapText(v, report([]), { gated: true })).toContain("clean");
  });
});
