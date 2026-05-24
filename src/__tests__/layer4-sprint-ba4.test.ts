/**
 * Sprint BA-4 — Output Token Efficiency tests.
 * BA-4.1: token-efficient skill enhancements
 * BA-4.2: context_complete flag
 * BA-4.3: output format legend
 */

import { describe, expect, it } from "vitest";
import {
  type Layer6FormatMeta,
  formatToolOutput,
} from "../proxy/format-encoder.js";
import {
  OUTPUT_FORMAT_LEGEND,
  createSessionLegendTracker,
} from "../proxy/session-legend.js";
// Post-consolidation (27→7): the token-efficient guidance is folded into
// USING_UNERR_SKILL (the always-on master). Tests assert the rules still
// ship — they just ride inside the master skill body now.
import { USING_UNERR_SKILL } from "../skills/local-pack.js";

describe("BA-4.1: token-efficient guidance (folded into using-unerr)", () => {
  it("master skill is on version ≥ 2.0.0 (post-consolidation)", () => {
    expect(USING_UNERR_SKILL.version.startsWith("2.")).toBe(true);
  });

  it("includes unified diff rule", () => {
    expect(USING_UNERR_SKILL.instructions).toContain("unified diff format");
    expect(USING_UNERR_SKILL.instructions).toContain("---/+++");
  });

  it("includes ur|ctx rule", () => {
    expect(USING_UNERR_SKILL.instructions).toContain("ur|ctx");
    expect(USING_UNERR_SKILL.instructions).toContain(
      "proceed directly to the action"
    );
  });

  it("includes the diff-only rule (no full-file regeneration)", () => {
    expect(USING_UNERR_SKILL.instructions).toContain(
      "show only the diff, not surrounding unchanged code"
    );
  });
});

describe("BA-4.3: output format legend", () => {
  it("consumeOutputFormatLegend fires once per session", () => {
    const L = createSessionLegendTracker();
    expect(L.consumeOutputFormatLegend()).toBe(true);
    expect(L.consumeOutputFormatLegend()).toBe(false);
  });

  it("invalidateAll resets output format legend", () => {
    const L = createSessionLegendTracker();
    expect(L.consumeOutputFormatLegend()).toBe(true);
    L.invalidateAll();
    expect(L.consumeOutputFormatLegend()).toBe(true);
  });

  it("columnar and output format legends are independent", () => {
    const L = createSessionLegendTracker();
    expect(L.consumeColumnarLegend()).toBe(true);
    expect(L.consumeOutputFormatLegend()).toBe(true);
    // Both consumed — neither fires again
    expect(L.consumeColumnarLegend()).toBe(false);
    expect(L.consumeOutputFormatLegend()).toBe(false);
  });

  it("OUTPUT_FORMAT_LEGEND mentions ur|ctx and diff", () => {
    expect(OUTPUT_FORMAT_LEGEND).toContain("ur|ctx");
    expect(OUTPUT_FORMAT_LEGEND).toContain("unified diff");
  });

  it("formatToolOutput attaches output_format_legend on first call", () => {
    const legend = createSessionLegendTracker();
    const meta: Layer6FormatMeta = {};
    formatToolOutput("get_callers", [{ k: "a", v: 1 }], meta, {
      legend,
      tier: "columnar",
    });
    expect(meta.output_format_legend).toBe(OUTPUT_FORMAT_LEGEND);

    // Second call — no legend
    const meta2: Layer6FormatMeta = {};
    formatToolOutput("get_callers", [{ k: "b", v: 2 }], meta2, {
      legend,
      tier: "columnar",
    });
    expect(meta2.output_format_legend).toBeUndefined();
  });

  it("formatToolOutput re-attaches legend after invalidation", () => {
    const legend = createSessionLegendTracker();
    const meta1: Layer6FormatMeta = {};
    formatToolOutput("get_callers", [{ k: "a", v: 1 }], meta1, {
      legend,
      tier: "columnar",
    });
    expect(meta1.output_format_legend).toBe(OUTPUT_FORMAT_LEGEND);

    legend.invalidateAll();

    const meta2: Layer6FormatMeta = {};
    formatToolOutput("get_callers", [{ k: "b", v: 2 }], meta2, {
      legend,
      tier: "columnar",
    });
    expect(meta2.output_format_legend).toBe(OUTPUT_FORMAT_LEGEND);
  });
});
