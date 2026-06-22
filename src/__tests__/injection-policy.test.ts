import { describe, expect, it } from "vitest";
import {
  type ActCandidate,
  MAX_ACT_LINES_PER_TURN,
  MAX_NUDGE_LINE_CHARS,
  PREFIX_VOLATILE_BOUNDARY,
  assembleInjectionBlock,
} from "../hooks/injection-policy.js";

const fixed = (text: string): ActCandidate => ({ text, volatile: false });
const vol = (text: string): ActCandidate => ({ text, volatile: true });

describe("assembleInjectionBlock (Issue 6 — one injection-policy brain)", () => {
  it("drops null/empty candidates and keeps only real lines", () => {
    const r = assembleInjectionBlock(
      [fixed("a"), { text: null, volatile: false }, fixed("")],
      "",
      []
    );
    expect(r.stableHead).toBe("a");
    expect(r.ordered).toBe("a");
  });

  it("caps at MAX_ACT_LINES_PER_TURN lines (priority order)", () => {
    const cands = Array.from({ length: 8 }, (_, i) => fixed(`L${i}`));
    const r = assembleInjectionBlock(cands, "", []);
    const lines = r.stableHead.split("\n");
    expect(lines).toHaveLength(MAX_ACT_LINES_PER_TURN);
    expect(lines[0]).toBe("L0");
    expect(lines[MAX_ACT_LINES_PER_TURN - 1]).toBe(
      `L${MAX_ACT_LINES_PER_TURN - 1}`
    );
  });

  it("truncates an oversize line to MAX_NUDGE_LINE_CHARS with an ellipsis", () => {
    const long = "x".repeat(MAX_NUDGE_LINE_CHARS + 50);
    const r = assembleInjectionBlock([fixed(long)], "", []);
    expect(r.stableHead).toHaveLength(MAX_NUDGE_LINE_CHARS);
    expect(r.stableHead.endsWith("…")).toBe(true);
  });

  it("splits stable vs volatile and orders head → boundary → tail", () => {
    const r = assembleInjectionBlock(
      [fixed("STABLE"), vol("VOLATILE")],
      "",
      []
    );
    expect(r.stableHead).toBe("STABLE");
    expect(r.volatileTail).toBe("VOLATILE");
    expect(r.ordered).toBe(`STABLE\n\n${PREFIX_VOLATILE_BOUNDARY}\nVOLATILE`);
  });

  it("folds the static tail into the stable head", () => {
    const r = assembleInjectionBlock([fixed("ACT")], "ROSTER", []);
    expect(r.stableHead).toBe("ACT\n\nROSTER");
  });

  it("orders volatile prefixes ahead of the volatile act text", () => {
    const r = assembleInjectionBlock([vol("ACTVOL")], "", ["STITCH", "SHIFT"]);
    expect(r.volatileTail).toBe("STITCH\nSHIFT\nACTVOL");
  });

  it("emits only the volatile tail (no boundary) when the head is empty", () => {
    const r = assembleInjectionBlock([], "", ["STITCH"]);
    expect(r.stableHead).toBe("");
    expect(r.ordered).toBe("STITCH");
    expect(r.ordered).not.toContain(PREFIX_VOLATILE_BOUNDARY);
  });

  it("emits only the stable head when there is no volatile tail", () => {
    const r = assembleInjectionBlock([fixed("ONLY")], "", []);
    expect(r.ordered).toBe("ONLY");
    expect(r.ordered).not.toContain(PREFIX_VOLATILE_BOUNDARY);
  });

  it("returns all-empty when nothing is injectable", () => {
    const r = assembleInjectionBlock([], "", ["", "  "]);
    expect(r.stableHead).toBe("");
    expect(r.volatileTail).toBe("");
    expect(r.ordered).toBe("");
  });
});
