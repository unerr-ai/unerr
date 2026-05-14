import { describe, expect, it } from "vitest";
import { createEfficiencyTracker } from "../proxy/efficiency-tracker.js";

describe("createEfficiencyTracker", () => {
  it("starts with zero state", () => {
    const tracker = createEfficiencyTracker();
    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(0);
    expect(snap.originalTokens).toBe(0);
    expect(snap.deliveredTokens).toBe(0);
    expect(snap.efficiency).toBe(0);
  });

  it("records token pairs and computes efficiency", () => {
    const tracker = createEfficiencyTracker();
    tracker.record(1000, 600);
    expect(tracker.getEfficiency()).toBe(40);
    expect(tracker.getSavedTokens()).toBe(400);
  });

  it("accumulates across multiple calls", () => {
    const tracker = createEfficiencyTracker();
    tracker.record(1000, 700);
    tracker.record(2000, 800);
    tracker.record(500, 500);

    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(3);
    expect(snap.originalTokens).toBe(3500);
    expect(snap.deliveredTokens).toBe(2000);
    expect(snap.savedTokens).toBe(1500);
    expect(snap.efficiency).toBe(43);
  });

  it("computes average savings per call", () => {
    const tracker = createEfficiencyTracker();
    tracker.record(1000, 500);
    tracker.record(2000, 1000);

    const snap = tracker.getSnapshot();
    expect(snap.avgSavingsPerCall).toBe(750);
  });

  it("handles 10 calls with known values", () => {
    const tracker = createEfficiencyTracker();
    for (let i = 0; i < 10; i++) {
      tracker.record(1000, 300);
    }
    expect(tracker.getEfficiency()).toBe(70);
    expect(tracker.getSavedTokens()).toBe(7000);
    expect(tracker.getSnapshot().totalCalls).toBe(10);
  });

  it("handles zero original tokens gracefully", () => {
    const tracker = createEfficiencyTracker();
    tracker.record(0, 0);
    expect(tracker.getEfficiency()).toBe(0);
  });

  it("never returns negative savings", () => {
    const tracker = createEfficiencyTracker();
    tracker.record(100, 200);
    expect(tracker.getSavedTokens()).toBe(0);
  });

  it("reset clears all state", () => {
    const tracker = createEfficiencyTracker();
    tracker.record(5000, 2000);
    tracker.reset();

    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(0);
    expect(snap.originalTokens).toBe(0);
    expect(snap.efficiency).toBe(0);
  });
});
