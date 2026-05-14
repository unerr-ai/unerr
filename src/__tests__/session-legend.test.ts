/**
 * Layer 6 Sprint FE-E — session legend tracker.
 */

import { describe, expect, it } from "vitest";
import { createSessionLegendTracker } from "../proxy/session-legend.js";

describe("SessionLegendTracker", () => {
  it("consumes columnar legend only once until invalidated", () => {
    const L = createSessionLegendTracker();
    expect(L.consumeColumnarLegend()).toBe(true);
    expect(L.consumeColumnarLegend()).toBe(false);
    L.invalidateAll();
    expect(L.consumeColumnarLegend()).toBe(true);
  });

  it("invalidateAll resets columnar channel", () => {
    const L = createSessionLegendTracker();
    expect(L.consumeColumnarLegend()).toBe(true);
    L.invalidateAll();
    expect(L.consumeColumnarLegend()).toBe(true);
  });
});
