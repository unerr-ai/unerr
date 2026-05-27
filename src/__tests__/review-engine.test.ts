import { describe, expect, it } from "vitest";
import type { ReviewChecker } from "../review/checker.js";
import { ReviewEngine } from "../review/engine.js";
import {
  dedupFindings,
  gateFindings,
  meetsFloor,
  sortBySeverity,
} from "../review/gating.js";
import {
  type ChangeSet,
  DEFAULT_REVIEW_CONFIG,
  type ReviewConfig,
  type ReviewContext,
  type ReviewFinding,
  type ReviewGraph,
  type Severity,
} from "../review/types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const emptyGraph: ReviewGraph = {
  getEntitiesByFile: async () => [],
  getCallersOf: async () => [],
};

const emptyChangeSet: ChangeSet = {
  entities: [],
  files: [],
  source: "manual",
};

function ctx(config: Partial<ReviewConfig> = {}): ReviewContext {
  return {
    changeSet: emptyChangeSet,
    graph: emptyGraph,
    notes: null,
    drift: null,
    rules: null,
    search: null,
    intent: null,
    config: { ...DEFAULT_REVIEW_CONFIG, ...config },
  };
}

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    checkerId: "stub",
    tier: 1,
    severity: "high",
    anchor: { kind: "e", value: "foo" },
    title: "stub finding",
    evidence: ["src/a.ts:1 calls foo()"],
    action: "call get_references({direction:'callers'}) on foo",
    needsModel: false,
    ...over,
  };
}

/** A checker that returns a fixed list of findings. */
function stubChecker(
  id: string,
  findings: ReviewFinding[],
  tier: 1 | 2 = 1,
  defaultSeverity: Severity = "medium"
): ReviewChecker {
  return { id, tier, defaultSeverity, check: async () => findings };
}

/** A checker that throws — used to prove error isolation. */
function throwingChecker(id: string, message: string): ReviewChecker {
  return {
    id,
    tier: 1,
    defaultSeverity: "high",
    check: async () => {
      throw new Error(message);
    },
  };
}

// ── Engine dispatch ──────────────────────────────────────────────────────────

describe("ReviewEngine.run — dispatch", () => {
  it("runs all registered checkers and collects their findings", async () => {
    const engine = new ReviewEngine().registerAll([
      stubChecker("a", [
        finding({ checkerId: "a", anchor: { kind: "e", value: "a1" } }),
      ]),
      stubChecker("b", [
        finding({ checkerId: "b", anchor: { kind: "e", value: "b1" } }),
      ]),
    ]);
    const report = await engine.run(ctx());
    expect(report.findings).toHaveLength(2);
    expect(report.checkersRun.sort()).toEqual(["a", "b"]);
    expect(report.checkersErrored).toEqual([]);
    expect(report.clean).toBe(false);
  });

  it("returns a clean report when no checker produces findings", async () => {
    const engine = new ReviewEngine().register(stubChecker("a", []));
    const report = await engine.run(ctx());
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.checkersRun).toEqual(["a"]);
  });

  it("rejects duplicate checker ids at registration", () => {
    const engine = new ReviewEngine().register(stubChecker("dup", []));
    expect(() => engine.register(stubChecker("dup", []))).toThrow(
      /duplicate checker id/
    );
  });
});

// ── Error isolation (adversarial) ─────────────────────────────────────────────

describe("ReviewEngine.run — per-checker error isolation", () => {
  it("records a throwing checker and still ships the rest of the report", async () => {
    const engine = new ReviewEngine().registerAll([
      throwingChecker("boom", "graph offline"),
      stubChecker("ok", [finding({ checkerId: "ok" })]),
    ]);
    const report = await engine.run(ctx());
    expect(report.findings).toHaveLength(1);
    expect(report.checkersRun).toEqual(["ok"]);
    expect(report.checkersErrored).toEqual([
      { checkerId: "boom", error: "graph offline" },
    ]);
  });
});

// ── Config opt-out ─────────────────────────────────────────────────────────────

describe("ReviewEngine.run — config", () => {
  it("skips a checker explicitly disabled in config (opt-out, not opt-in)", async () => {
    const engine = new ReviewEngine().registerAll([
      stubChecker("on", [finding({ checkerId: "on" })]),
      stubChecker("off", [finding({ checkerId: "off" })]),
    ]);
    const report = await engine.run(ctx({ checkers: { off: false } }));
    expect(report.checkersRun).toEqual(["on"]);
    expect(report.findings.every((f) => f.checkerId === "on")).toBe(true);
  });

  it("runs a checker absent from the config map (default enabled)", async () => {
    const engine = new ReviewEngine().register(
      stubChecker("x", [finding({ checkerId: "x" })])
    );
    const report = await engine.run(ctx({ checkers: {} }));
    expect(report.checkersRun).toEqual(["x"]);
  });
});

// ── Severity gating ────────────────────────────────────────────────────────────

describe("severity gating", () => {
  it("meetsFloor compares by rank", () => {
    expect(meetsFloor("high", "medium")).toBe(true);
    expect(meetsFloor("low", "medium")).toBe(false);
    expect(meetsFloor("medium", "medium")).toBe(true);
  });

  it("suppresses below-floor findings and counts them", async () => {
    const engine = new ReviewEngine().register(
      stubChecker("multi", [
        finding({
          checkerId: "multi",
          severity: "low",
          anchor: { kind: "e", value: "lo" },
        }),
        finding({
          checkerId: "multi",
          severity: "high",
          anchor: { kind: "e", value: "hi" },
        }),
      ])
    );
    const report = await engine.run(ctx(), { minSeverity: "medium" });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe("high");
    expect(report.suppressed).toBe(1);
  });

  it("falls back to ctx.config.minSeverity when no run override is given", async () => {
    const engine = new ReviewEngine().register(
      stubChecker("c", [finding({ checkerId: "c", severity: "low" })])
    );
    const report = await engine.run(ctx({ minSeverity: "high" }));
    expect(report.findings).toHaveLength(0);
    expect(report.suppressed).toBe(1);
  });
});

// ── Dedup + sort ───────────────────────────────────────────────────────────────

describe("dedupFindings", () => {
  it("collapses identical findings, unions evidence, keeps higher severity", () => {
    const out = dedupFindings([
      finding({ severity: "medium", evidence: ["src/a.ts:1 calls foo()"] }),
      finding({ severity: "high", evidence: ["src/b.ts:2 calls foo()"] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("high");
    expect(out[0]?.evidence).toEqual([
      "src/a.ts:1 calls foo()",
      "src/b.ts:2 calls foo()",
    ]);
  });

  it("keeps findings from different checkers on the same anchor", () => {
    const out = dedupFindings([
      finding({ checkerId: "breaking_callers" }),
      finding({ checkerId: "blast_radius" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("sortBySeverity", () => {
  it("orders critical → info, ties broken by checker id", () => {
    const out = sortBySeverity([
      finding({
        checkerId: "z",
        severity: "low",
        anchor: { kind: "e", value: "1" },
      }),
      finding({
        checkerId: "a",
        severity: "critical",
        anchor: { kind: "e", value: "2" },
      }),
      finding({
        checkerId: "b",
        severity: "critical",
        anchor: { kind: "e", value: "3" },
      }),
    ]);
    expect(out.map((f) => [f.severity, f.checkerId])).toEqual([
      ["critical", "a"],
      ["critical", "b"],
      ["low", "z"],
    ]);
  });
});

describe("gateFindings", () => {
  it("dedups, applies floor, and sorts in one pass", () => {
    const { kept, suppressed } = gateFindings(
      [
        finding({
          checkerId: "a",
          severity: "low",
          anchor: { kind: "e", value: "x" },
        }),
        finding({
          checkerId: "b",
          severity: "critical",
          anchor: { kind: "e", value: "y" },
        }),
        finding({
          checkerId: "b",
          severity: "high",
          anchor: { kind: "e", value: "y" },
        }),
      ],
      "medium"
    );
    // The two "b@y" findings dedup to one (critical wins); "a@x" low is suppressed.
    expect(kept).toHaveLength(1);
    expect(kept[0]?.severity).toBe("critical");
    expect(suppressed).toBe(1);
  });
});
