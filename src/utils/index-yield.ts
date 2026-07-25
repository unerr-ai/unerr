/**
 * Cooperative event-loop yielding for the CPU-bound index loops. A long
 * synchronous tree-sitter parse loop pins the proxy's single Node thread, so it
 * cannot read the bridge's `unerr/ping` nor write the `unerr/pong`; after
 * ~15s (MAX_MISSED_HEARTBEATS × HEARTBEAT_INTERVAL_MS, src/proxy/bridge.ts) the
 * bridge declares the daemon dead and drops the socket, surfacing to the agent
 * as `-32000 Connection closed` mid-index. Yielding via setImmediate on a time
 * budget lets the Poll/Check phases run (servicing the ping) between batches, so
 * a 100s+ index stays connection-alive regardless of total duration.
 *
 */
import { performance } from "node:perf_hooks";

/** Work budget between yields. Kept well under the ~15s heartbeat-death window
 *  and small enough that event-loop lag stays in the tens-of-ms range, the level
 *  the Node guidance targets for a responsive loop. */
export const DEFAULT_YIELD_BUDGET_MS = 50;

/**
 * How many trivial inner-loop iterations to run between clock checks in the
 * finalize phases (resolveEdges / computeDerivedFields / resolveTestEdges /
 * computeCoChangeEdges). {@link maybeYield} is `async`, so `await maybeYield(gate)`
 * costs a microtask on every call even when it decides NOT to yield. Awaiting it
 * once per element over a 1M-edge set would add tens of ms of pure microtask
 * overhead. A cheap `i % YIELD_CHECK_STRIDE` gate keeps that overhead negligible
 * while still bounding the main-loop stall to one `budgetMs` window — STRIDE
 * trivial map/set ops run in well under 1ms, far below the 50ms budget, so the
 * clock is still sampled long before the budget is exceeded.
 */
export const YIELD_CHECK_STRIDE = 4096;

export interface YieldGate {
  /** `performance.now()` timestamp of the last yield (or gate creation). */
  last: number;
  /** Max synchronous work, in ms, before {@link maybeYield} hands control back. */
  budgetMs: number;
}

/** Create a yield gate that fires after `budgetMs` of uninterrupted work. */
export function createYieldGate(budgetMs = DEFAULT_YIELD_BUDGET_MS): YieldGate {
  return { last: performance.now(), budgetMs };
}

/**
 * Hand control back to the event loop when more than `gate.budgetMs` has elapsed
 * since the last yield. setImmediate fires in the Check phase — after Poll — so a
 * socket ping queued during the prior batch is read and ponged before the next
 * batch starts. Returns true when it actually yielded.
 */
export async function maybeYield(gate: YieldGate): Promise<boolean> {
  const now = performance.now();
  if (now - gate.last < gate.budgetMs) return false;
  await new Promise<void>((resolve) => setImmediate(resolve));
  gate.last = performance.now();
  return true;
}
