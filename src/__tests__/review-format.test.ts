import { describe, expect, it } from "vitest";
import {
  findingTag,
  formatFindingLine,
  formatReviewFindings,
} from "../review/format.js";
import type { ReviewFinding, Severity } from "../review/types.js";

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    checkerId: "breaking_callers",
    tier: 1,
    severity: "high",
    anchor: { kind: "e", value: "k_foo" },
    title: "parameter_added on foo — 3 caller(s) now mismatch",
    evidence: ["src/a.ts:4 a calls foo"],
    action: "call get_references({key:'k_foo', direction:'callers'})",
    needsModel: false,
    ...over,
  };
}

describe("findingTag", () => {
  it("maps high/critical deterministic findings to rsk", () => {
    expect(findingTag(finding({ severity: "high" }))).toBe("rsk");
    expect(findingTag(finding({ severity: "critical" }))).toBe("rsk");
  });

  it("maps medium/low/info findings to fct", () => {
    for (const s of ["medium", "low", "info"] as Severity[]) {
      expect(findingTag(finding({ severity: s }))).toBe("fct");
    }
  });

  it("maps a needsModel finding to fct regardless of severity", () => {
    expect(
      findingTag(finding({ severity: "critical", needsModel: true }))
    ).toBe("fct");
  });
});

describe("formatFindingLine", () => {
  it("emits ur|<tag> <title> → <action>", () => {
    const line = formatFindingLine(finding());
    expect(line).toBe(
      "ur|rsk parameter_added on foo — 3 caller(s) now mismatch → call get_references({key:'k_foo', direction:'callers'})"
    );
  });
});

describe("formatReviewFindings", () => {
  it("returns empty string for no findings", () => {
    expect(formatReviewFindings([], 0)).toBe("");
  });

  it("renders one line per finding, most-severe lead preserved", () => {
    const block = formatReviewFindings([
      finding({ severity: "critical", title: "secret in config.ts" }),
      finding({ severity: "medium", title: "foo untested" }),
    ]);
    const lines = block.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ur|rsk");
    expect(lines[0]).toContain("secret in config.ts");
    expect(lines[1]).toContain("ur|fct");
  });

  it("caps the visible findings and summarises the overflow", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      finding({ title: `finding ${i}` })
    );
    const block = formatReviewFindings(many, 0, 5);
    const lines = block.split("\n");
    expect(lines).toHaveLength(6); // 5 + overflow summary
    expect(lines[5]).toContain("+3 more review finding(s)");
  });

  it("appends a tail line when findings were suppressed below the floor", () => {
    const block = formatReviewFindings([finding()], 4);
    const lines = block.split("\n");
    expect(lines[lines.length - 1]).toContain("+4 lower-severity finding(s)");
    expect(lines[lines.length - 1]).toContain("unerr review");
  });

  it("excludes Tier-2 (needsModel) findings — they route to synthesis, not verdicts", () => {
    // A lone Tier-2 finding produces no verdict block; it is the synthesis
    // layer's job to render it as an evidence block (§9.3).
    expect(formatReviewFindings([finding({ needsModel: true })])).toBe("");
    // Mixed: only the Tier-1 verdict surfaces here.
    const block = formatReviewFindings([
      finding({ title: "tier1 verdict" }),
      finding({ needsModel: true, title: "tier2 evidence" }),
    ]);
    expect(block).toContain("tier1 verdict");
    expect(block).not.toContain("tier2 evidence");
  });
});
