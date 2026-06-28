/**
 * Turn telemetry — Sprint 0 instrumentation for the token-overhead reduction
 * work (see `.internal/archive/TOKEN_ECONOMICS_AND_SAVINGS.md`).
 *
 * What this module CAN observe: the sequence of tool calls unerr receives in a
 * session (a server-side proxy for "round-trips"), a histogram by tool name,
 * and whether a turn's call sequence matches the recon chain that Sprint 1's
 * `unerr recon` command is meant to collapse.
 *
 * What this module CANNOT observe: the LLM client's `cache_read` /
 * `cache_write` / billed round-trip counts. Those live in the agent's
 * transcript (`.jsonl`), not on the MCP server. Use
 * `scripts/measure-token-baseline.mjs` for those — see the benchmark corpus
 * doc. Keeping that boundary explicit is the whole point of Sprint 0: we
 * instrument what is honestly observable here, and measure the rest offline.
 *
 * Pure functions only — no I/O, no clock. Fully unit-testable in isolation.
 */

/**
 * Canonical recon chain (normalized tool names) that `unerr recon` replaces:
 * recall → search → outline → read → entity. Order matters — the detector
 * scores the longest in-order match, so a shuffled set scores lower than the
 * real recon walk.
 */
export const RECON_SEQUENCE: readonly string[] = [
  "recall_notes",
  "search_code",
  "file_outline",
  "file_read",
  "get_entity",
];

/** Minimum in-order matches before a sequence counts as a recon pattern. */
export const RECON_THRESHOLD = 3;

/** Rolling window of recent calls the detector scores over. */
export const RECON_WINDOW = 12;

/**
 * Strip transport/namespace prefixes so client-side names
 * (`mcp__unerr__search_code`) and server-side names (`unerr_recall_notes`)
 * both reduce to the canonical token (`search_code`, `recall_notes`).
 */
export function normalizeToolName(name: string): string {
  return name.replace(/^mcp__unerr__/, "").replace(/^unerr_/, "");
}

/** Count tool calls by normalized name. */
export function toolCallHistogram(tools: string[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const raw of tools) {
    const name = normalizeToolName(raw);
    hist[name] = (hist[name] ?? 0) + 1;
  }
  return hist;
}

/**
 * Length of the longest subsequence of `pattern` that appears, in order,
 * within `seq` (a standard LCS — both orders respected). Because the recon
 * pattern has distinct elements, this is exactly "how many recon steps were
 * taken in the canonical order", tolerating other tools interleaved.
 *
 * `pattern` is assumed already normalized; `seq` is normalized per element.
 */
export function longestOrderedSubsequence(
  seq: string[],
  pattern: readonly string[]
): number {
  const n = seq.length;
  const m = pattern.length;
  if (n === 0 || m === 0) return 0;

  const dp = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const si = normalizeToolName(seq[i - 1]!);
    let prevDiag = 0; // dp[i-1][j-1]
    for (let j = 1; j <= m; j++) {
      const above = dp[j]!; // dp[i-1][j], becomes dp[i-1][j-1] next iter
      dp[j] =
        si === pattern[j - 1] ? prevDiag + 1 : Math.max(above, dp[j - 1]!);
      prevDiag = above;
    }
  }
  return dp[m]!;
}

export interface ReconPatternResult {
  /** in-order recon steps detected */
  matched: number;
  /** total calls considered */
  toolCount: number;
  /** crossed the RECON_THRESHOLD */
  hit: boolean;
}

/** One-shot scoring of a tool-call list against the recon pattern. */
export function detectReconPattern(
  tools: string[],
  threshold = RECON_THRESHOLD
): ReconPatternResult {
  const matched = longestOrderedSubsequence(tools, RECON_SEQUENCE);
  return { matched, toolCount: tools.length, hit: matched >= threshold };
}

export interface TurnTelemetry {
  totalCalls: number;
  histogram: Record<string, number>;
  reconMatched: number;
  reconPatternHit: boolean;
}

/** Snapshot of a tool-call sequence (e.g. from ToolUsageTracker.getRecentTools). */
export function buildTurnTelemetry(
  tools: string[],
  threshold = RECON_THRESHOLD
): TurnTelemetry {
  const recon = detectReconPattern(tools, threshold);
  return {
    totalCalls: tools.length,
    histogram: toolCallHistogram(tools),
    reconMatched: recon.matched,
    reconPatternHit: recon.hit,
  };
}

export interface ReconPatternEvent {
  matched: number;
  tool_count: number;
  window: string[];
}

export interface ReconDetector {
  /**
   * Feed one tool name. Returns an event the FIRST time the recon pattern
   * crosses the threshold within the rolling window, then stays silent until
   * the window rolls clear of the pattern (one event per "episode"). Returns
   * null otherwise.
   */
  note: (tool: string) => ReconPatternEvent | null;
  reset: () => void;
}

/**
 * Stateful, per-session recon-pattern detector. Emits at most once per
 * episode so wiring it into the hot dispatch path stays cheap and non-chatty.
 */
export function createReconDetector(opts?: {
  threshold?: number;
  windowSize?: number;
}): ReconDetector {
  const threshold = opts?.threshold ?? RECON_THRESHOLD;
  const windowSize = opts?.windowSize ?? RECON_WINDOW;
  const window: string[] = [];
  let armed = true;

  return {
    note(tool: string): ReconPatternEvent | null {
      window.push(normalizeToolName(tool));
      if (window.length > windowSize) window.shift();

      const matched = longestOrderedSubsequence(window, RECON_SEQUENCE);
      if (matched < threshold) {
        armed = true; // window rolled clear — re-arm for the next episode
        return null;
      }
      if (!armed) return null; // already emitted for this episode

      armed = false;
      return { matched, tool_count: window.length, window: [...window] };
    },
    reset(): void {
      window.length = 0;
      armed = true;
    },
  };
}
