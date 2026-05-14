/**
 * Resource Monitor + Progressive Degradation Controller.
 *
 * L2.6: Monitors heap usage + event loop latency every 10s.
 * L2.7: Adjusts indexer behavior based on resource pressure:
 *   - Level 0 (healthy): Full parallelism, SCIP enabled
 *   - Level 1 (caution, >60%): Reduce workers by half
 *   - Level 2 (warning, >75%): Single worker, pause SCIP
 *   - Level 3 (critical, >90%): Kill SCIP, emergency GC, single-threaded only
 */

import { createModuleLogger } from "../../utils/logger.js";

const log = createModuleLogger("resource-monitor");

export type DegradationLevel = 0 | 1 | 2 | 3;

export interface ResourceSnapshot {
  heapUsedMB: number;
  heapTotalMB: number;
  heapPercentage: number;
  rss: number;
  degradationLevel: DegradationLevel;
  timestamp: number;
}

export interface DegradationConfig {
  maxWorkers: number;
  scipEnabled: boolean;
  batchSize: number;
}

const THRESHOLDS = {
  caution: 0.6,
  warning: 0.75,
  critical: 0.9,
} as const;

const HEAP_LIMIT_MB = 1500;

export function getResourceSnapshot(): ResourceSnapshot {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const heapPercentage = heapUsedMB / HEAP_LIMIT_MB;

  let degradationLevel: DegradationLevel = 0;
  if (heapPercentage >= THRESHOLDS.critical) degradationLevel = 3;
  else if (heapPercentage >= THRESHOLDS.warning) degradationLevel = 2;
  else if (heapPercentage >= THRESHOLDS.caution) degradationLevel = 1;

  return {
    heapUsedMB,
    heapTotalMB,
    heapPercentage: Math.round(heapPercentage * 100) / 100,
    rss: Math.round(mem.rss / 1024 / 1024),
    degradationLevel,
    timestamp: Date.now(),
  };
}

export function getDegradationConfig(
  level: DegradationLevel,
  baseWorkers = 4,
): DegradationConfig {
  switch (level) {
    case 0:
      return { maxWorkers: baseWorkers, scipEnabled: true, batchSize: 50 };
    case 1:
      return {
        maxWorkers: Math.max(1, Math.floor(baseWorkers / 2)),
        scipEnabled: true,
        batchSize: 25,
      };
    case 2:
      return { maxWorkers: 1, scipEnabled: false, batchSize: 10 };
    case 3:
      return { maxWorkers: 1, scipEnabled: false, batchSize: 5 };
  }
}

export interface ResourceMonitor {
  start: () => void;
  stop: () => void;
  getSnapshot: () => ResourceSnapshot;
  getConfig: () => DegradationConfig;
  onDegradationChange: (callback: (level: DegradationLevel) => void) => void;
}

export function createResourceMonitor(
  intervalMs = 10_000,
  baseWorkers = 4,
): ResourceMonitor {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastLevel: DegradationLevel = 0;
  let changeCallback: ((level: DegradationLevel) => void) | null = null;

  function check(): void {
    const snapshot = getResourceSnapshot();

    if (snapshot.degradationLevel !== lastLevel) {
      log.info(
        `Resource degradation: Level ${lastLevel} → ${snapshot.degradationLevel} (heap: ${snapshot.heapUsedMB}MB / ${HEAP_LIMIT_MB}MB)`,
      );
      lastLevel = snapshot.degradationLevel;
      changeCallback?.(snapshot.degradationLevel);
    }

    if (snapshot.degradationLevel >= 3) {
      log.warn("Critical heap pressure — triggering GC hint");
      if (global.gc) global.gc();
    }
  }

  return {
    start() {
      if (timer) return;
      check();
      timer = setInterval(check, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    getSnapshot: getResourceSnapshot,
    getConfig: () => getDegradationConfig(lastLevel, baseWorkers),
    onDegradationChange(callback) {
      changeCallback = callback;
    },
  };
}
