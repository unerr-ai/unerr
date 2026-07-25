/**
 * Dispatch-level hard deadline — the last-resort backstop for a single MCP tool
 * call so ONE hung tool cannot burn an entire agent-task budget.
 *
 * Each tool already carries its own, better-shaped internal deadline:
 *   - local graph queries reject at the cozo circuit breaker's 120s
 *     (DEFAULT_REQUEST_TIMEOUT_MS, cozo-worker-client.ts),
 *   - fetch_url single-page fetches cap at totalDeadlineMs = 120s,
 *   - fetch_url bulk caps at batchDeadlineMs = 30s.
 * This deadline sits ABOVE all of them: it only fires when a tool defeats its
 * OWN deadline — e.g. an AbortController that fails to interrupt a stalled
 * DNS/connect syscall — and returns a degraded, agent-actionable result instead
 * of hanging until the MCP client's ~1800s abort.
 *
 * NOTE (event-loop starvation): if the proxy's single loop is pinned by an
 * on-loop synchronous stretch (a non-yielding index finalize phase), this
 * timer cannot fire either — a timer race never fixes starvation. The durable
 * fix for that class is cooperative yielding in the indexer; this deadline
 * covers the I/O-bound class where the loop IS free (network hangs, a tool that
 * ignores its own abort).
 */

/** Wall-clock cap on one `router.execute(...)` dispatch, in ms.
 *
 *  150s is chosen to sit safely above the two 120s internal tool deadlines
 *  (cozo circuit breaker, fetch_url totalDeadlineMs) so each tool's own,
 *  well-shaped degraded result fires first, while still returning control to the
 *  agent ~12x sooner than the MCP client's ~1800s abort. Deliberately NOT lower
 *  (e.g. 90s): that would strangle a legitimately-slow local query sitting on
 *  the cozo backstop or a fetch_url using its full 120s budget. */
export const DISPATCH_DEADLINE_MS = 150_000;

/** Degraded MCP tool result shape — a plain text `isError` payload. */
export interface DegradedToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

/** Build the agent-actionable payload returned when the dispatch deadline trips. */
export function makeDispatchTimeoutResult(
  toolName: string,
  deadlineMs: number
): DegradedToolResult {
  const seconds = Math.round(deadlineMs / 1000);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: `unerr tool '${toolName}' did not return within ${seconds}s and was abandoned. Retry the call, or use the built-in equivalent (Read / Grep / Glob / WebFetch) for this step.`,
          tool: toolName,
          timed_out_ms: deadlineMs,
        }),
      },
    ],
    isError: true,
  };
}

/** Outcome of racing a tool execution against the dispatch deadline. */
export type ToolExecutionOutcome<T> =
  | { timedOut: false; result: T }
  | { timedOut: true; degraded: DegradedToolResult };

/**
 * Race a tool-execution promise against the dispatch deadline.
 *
 * - Resolves `{ timedOut:false, result }` when `exec` settles first.
 * - Resolves `{ timedOut:true, degraded }` when the deadline wins — the caller
 *   returns `degraded` immediately and MUST skip all post-tool processing
 *   (stats, ledger, behaviors) so a timed-out call is never double-counted.
 * - REJECTS (propagates) if `exec` rejects, preserving the existing
 *   throw → `isError` handling in the caller's catch block.
 *
 * The abandoned `exec` promise keeps running in the background; its late result
 * is discarded (never re-enters post-processing). The timer is `unref`'d so it
 * cannot keep the process alive, and always cleared so it cannot leak.
 */
export async function raceToolExecution<T>(
  exec: Promise<T>,
  toolName: string,
  deadlineMs: number = DISPATCH_DEADLINE_MS
): Promise<ToolExecutionOutcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const TIMED_OUT = Symbol("dispatch_timed_out");
  try {
    const raced = await Promise.race<T | typeof TIMED_OUT>([
      exec,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    if (raced === TIMED_OUT) {
      return {
        timedOut: true,
        degraded: makeDispatchTimeoutResult(toolName, deadlineMs),
      };
    }
    return { timedOut: false, result: raced as T };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
