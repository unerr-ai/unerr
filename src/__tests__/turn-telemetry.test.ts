import { describe, expect, it } from "vitest";
import {
  RECON_SEQUENCE,
  buildTurnTelemetry,
  createReconDetector,
  detectReconPattern,
  longestOrderedSubsequence,
  normalizeToolName,
  toolCallHistogram,
} from "../tracking/turn-telemetry.js";

describe("normalizeToolName", () => {
  it("strips client and server prefixes to the canonical token", () => {
    expect(normalizeToolName("mcp__unerr__search_code")).toBe("search_code");
    expect(normalizeToolName("unerr_recall_notes")).toBe("recall_notes");
    expect(normalizeToolName("search_code")).toBe("search_code");
  });
});

describe("toolCallHistogram", () => {
  it("counts by normalized name", () => {
    const hist = toolCallHistogram([
      "search_code",
      "mcp__unerr__search_code",
      "file_read",
    ]);
    expect(hist).toEqual({ search_code: 2, file_read: 1 });
  });

  it("returns empty for no calls", () => {
    expect(toolCallHistogram([])).toEqual({});
  });
});

describe("longestOrderedSubsequence", () => {
  it("counts in-order recon steps, tolerating interleaved tools", () => {
    const seq = [
      "recall_notes",
      "Bash",
      "search_code",
      "Read",
      "file_outline",
    ];
    expect(longestOrderedSubsequence(seq, RECON_SEQUENCE)).toBe(3);
  });

  it("does not reward out-of-order calls beyond the longest chain", () => {
    // entity before recall: only get_entity OR the recall→search chain counts
    const seq = ["get_entity", "recall_notes", "search_code"];
    expect(longestOrderedSubsequence(seq, RECON_SEQUENCE)).toBe(2);
  });

  it("counts the full chain when present in order", () => {
    expect(longestOrderedSubsequence([...RECON_SEQUENCE], RECON_SEQUENCE)).toBe(
      RECON_SEQUENCE.length
    );
  });

  it("is zero for empty input", () => {
    expect(longestOrderedSubsequence([], RECON_SEQUENCE)).toBe(0);
  });
});

describe("detectReconPattern", () => {
  it("flags a hit at or above the threshold", () => {
    const r = detectReconPattern(["recall_notes", "search_code", "file_read"]);
    expect(r.hit).toBe(true);
    expect(r.matched).toBe(3);
  });

  it("does not flag below the threshold", () => {
    const r = detectReconPattern(["search_code", "Bash"]);
    expect(r.hit).toBe(false);
    expect(r.matched).toBe(1);
  });
});

describe("buildTurnTelemetry", () => {
  it("assembles count + histogram + recon verdict", () => {
    const t = buildTurnTelemetry([
      "recall_notes",
      "search_code",
      "file_outline",
      "file_read",
    ]);
    expect(t.totalCalls).toBe(4);
    expect(t.reconMatched).toBe(4);
    expect(t.reconPatternHit).toBe(true);
    expect(t.histogram.search_code).toBe(1);
  });
});

describe("createReconDetector", () => {
  it("emits exactly once per episode", () => {
    const d = createReconDetector();
    expect(d.note("recall_notes")).toBeNull();
    expect(d.note("search_code")).toBeNull();
    const ev = d.note("file_read"); // crosses threshold of 3
    expect(ev).not.toBeNull();
    expect(ev?.matched).toBe(3);
    // still in the same episode — no repeat emission
    expect(d.note("get_entity")).toBeNull();
    expect(d.note("file_outline")).toBeNull();
  });

  it("re-arms after the window rolls clear of the pattern", () => {
    const d = createReconDetector({ threshold: 3, windowSize: 4 });
    expect(d.note("recall_notes")).toBeNull();
    expect(d.note("search_code")).toBeNull();
    expect(d.note("file_read")).not.toBeNull(); // episode 1
    // flood unrelated tools to push the recon calls out of the 4-wide window
    d.note("Bash");
    d.note("Bash");
    d.note("Bash");
    d.note("Bash");
    // new recon episode
    expect(d.note("recall_notes")).toBeNull();
    expect(d.note("search_code")).toBeNull();
    expect(d.note("file_outline")).not.toBeNull(); // episode 2
  });

  it("reset() clears state", () => {
    const d = createReconDetector();
    d.note("recall_notes");
    d.note("search_code");
    d.reset();
    expect(d.note("file_read")).toBeNull(); // only 1 in window after reset
  });
});
