/**
 * Layer 6 Sprint FE-E — Layer 6 tier escalation on repeated retries.
 */

import { describe, expect, it } from "vitest";
import { createCompressionQualityMonitor } from "../proxy/compression-quality-monitor.js";

describe("CompressionQualityMonitor Layer 6 tiers (FE-E)", () => {
  it("starts at columnar tier", () => {
    const m = createCompressionQualityMonitor();
    expect(m.getLayer6Tier("get_callers")).toBe("columnar");
    expect(m.getLayer6RetryCount("get_callers")).toBe(0);
  });

  it("escalates to minified after 3 retries", () => {
    const m = createCompressionQualityMonitor();
    m.recordLayer6Retry("search_code");
    m.recordLayer6Retry("search_code");
    expect(m.getLayer6Tier("search_code")).toBe("columnar");
    m.recordLayer6Retry("search_code");
    expect(m.getLayer6Tier("search_code")).toBe("minified");
    expect(m.getLayer6RetryCount("search_code")).toBe(3);
  });

  it("escalates to expanded after 6 retries", () => {
    const m = createCompressionQualityMonitor();
    for (let i = 0; i < 6; i++) m.recordLayer6Retry("get_function");
    expect(m.getLayer6Tier("get_function")).toBe("expanded");
  });

  it("tracks layer6 content types for retention", () => {
    const m = createCompressionQualityMonitor();
    expect(m.getRetention("layer6_columnar")).toBeGreaterThanOrEqual(0.4);
  });

  it("FE-F: shell category retention defaults exist", () => {
    const m = createCompressionQualityMonitor();
    expect(m.getRetention("shell_diff")).toBeGreaterThanOrEqual(0.4);
    expect(m.getRetention("shell_structured")).toBeGreaterThanOrEqual(0.4);
    expect(m.getRetention("shell_error_diagnostic")).toBeGreaterThanOrEqual(
      0.4,
    );
    m.recordCompression("s1", "shell_tabular", 0.5);
    m.recordAgentAction("e", true, false);
    expect(m.getSignalCount()).toBeGreaterThan(0);
  });
});
