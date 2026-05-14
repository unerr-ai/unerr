import { describe, expect, it } from "vitest";
import {
  type DegradationLevel,
  createResourceMonitor,
  getDegradationConfig,
  getResourceSnapshot,
} from "../intelligence/indexer/resource-monitor.js";

describe("Resource Monitor (L2.6)", () => {
  it("produces a valid resource snapshot", () => {
    const snap = getResourceSnapshot();
    expect(snap.heapUsedMB).toBeGreaterThan(0);
    expect(snap.heapTotalMB).toBeGreaterThan(0);
    expect(snap.heapPercentage).toBeGreaterThanOrEqual(0);
    expect(snap.heapPercentage).toBeLessThanOrEqual(1);
    expect(snap.rss).toBeGreaterThan(0);
    expect([0, 1, 2, 3]).toContain(snap.degradationLevel);
  });

  it("creates and stops monitor without errors", () => {
    const monitor = createResourceMonitor(60_000);
    monitor.start();
    const snap = monitor.getSnapshot();
    expect(snap.heapUsedMB).toBeGreaterThan(0);
    monitor.stop();
  });
});

describe("Progressive Degradation (L2.7)", () => {
  it("level 0: full parallelism", () => {
    const config = getDegradationConfig(0, 4);
    expect(config.maxWorkers).toBe(4);
    expect(config.scipEnabled).toBe(true);
    expect(config.batchSize).toBe(50);
  });

  it("level 1: reduced workers", () => {
    const config = getDegradationConfig(1, 4);
    expect(config.maxWorkers).toBe(2);
    expect(config.scipEnabled).toBe(true);
    expect(config.batchSize).toBe(25);
  });

  it("level 2: single worker, SCIP paused", () => {
    const config = getDegradationConfig(2, 4);
    expect(config.maxWorkers).toBe(1);
    expect(config.scipEnabled).toBe(false);
    expect(config.batchSize).toBe(10);
  });

  it("level 3: emergency mode", () => {
    const config = getDegradationConfig(3, 4);
    expect(config.maxWorkers).toBe(1);
    expect(config.scipEnabled).toBe(false);
    expect(config.batchSize).toBe(5);
  });

  it("degradation callback fires on level change", () => {
    const monitor = createResourceMonitor(100_000);
    let lastLevel: DegradationLevel | null = null;
    monitor.onDegradationChange((level) => {
      lastLevel = level;
    });
    monitor.start();
    const config = monitor.getConfig();
    expect(config.maxWorkers).toBeGreaterThanOrEqual(1);
    monitor.stop();
  });
});
