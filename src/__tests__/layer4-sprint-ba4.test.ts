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
import { TOKEN_EFFICIENT_SKILL } from "../skills/local-pack.js";

describe("BA-4.1: token-efficient skill", () => {
  it("version is 1.1.0", () => {
    expect(TOKEN_EFFICIENT_SKILL.version).toBe("1.1.0");
  });

  it("includes unified diff rule", () => {
    expect(TOKEN_EFFICIENT_SKILL.instructions).toContain("unified diff format");
    expect(TOKEN_EFFICIENT_SKILL.instructions).toContain("---/+++");
  });

  it("includes ur|ctx rule", () => {
    expect(TOKEN_EFFICIENT_SKILL.instructions).toContain("ur|ctx");
    expect(TOKEN_EFFICIENT_SKILL.instructions).toContain(
      "proceed directly to the action"
    );
  });

  it("has 9 instruction rules", () => {
    const rules = TOKEN_EFFICIENT_SKILL.instructions.split("\n");
    expect(rules).toHaveLength(9);
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
