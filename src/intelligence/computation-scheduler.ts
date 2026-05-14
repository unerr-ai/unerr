/**
 * Resource-Aware Computation Scheduler — defers heavy ops under pressure.
 *
 * Checks heap usage before running expensive computations (Louvain, full
 * health grade, convention detection). If heap >75%, defers to next idle period.
 */

import { createModuleLogger } from "../utils/logger.js";
import {
  type DegradationLevel,
  getResourceSnapshot,
} from "./indexer/resource-monitor.js";

const log = createModuleLogger("computation-scheduler");

export type ComputationPriority = "critical" | "normal" | "background";

export interface ScheduledComputation {
  id: string;
  priority: ComputationPriority;
  fn: () => Promise<void>;
}

const pendingQueue: ScheduledComputation[] = [];
let isProcessing = false;

/**
 * Schedule a computation respecting resource limits.
 * Critical = always runs. Normal = defers if heap >75%. Background = defers if heap >60%.
 */
export async function scheduleComputation(
  id: string,
  priority: ComputationPriority,
  fn: () => Promise<void>,
): Promise<boolean> {
  const snap = getResourceSnapshot();

  if (priority === "critical") {
    await fn();
    return true;
  }

  if (priority === "normal" && snap.degradationLevel >= 2) {
    log.info(`Deferring ${id}: heap pressure level ${snap.degradationLevel}`);
    pendingQueue.push({ id, priority, fn });
    return false;
  }

  if (priority === "background" && snap.degradationLevel >= 1) {
    log.info(
      `Deferring background ${id}: heap pressure level ${snap.degradationLevel}`,
    );
    pendingQueue.push({ id, priority, fn });
    return false;
  }

  await fn();
  return true;
}

/**
 * Process pending computations when resources free up.
 */
export async function processPending(): Promise<number> {
  if (isProcessing || pendingQueue.length === 0) return 0;
  isProcessing = true;

  let processed = 0;
  const snap = getResourceSnapshot();

  if (snap.degradationLevel >= 2) {
    isProcessing = false;
    return 0;
  }

  while (pendingQueue.length > 0) {
    const current = getResourceSnapshot();
    if (current.degradationLevel >= 2) break;

    const task = pendingQueue.shift()!;
    try {
      await task.fn();
      processed++;
    } catch (err) {
      log.warn(
        `Scheduled computation ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  isProcessing = false;
  return processed;
}

/**
 * Get pending computation count.
 */
export function getPendingCount(): number {
  return pendingQueue.length;
}

/**
 * Clear all pending computations.
 */
export function clearPending(): void {
  pendingQueue.length = 0;
}
