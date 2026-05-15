/**
 * Per-session flag state for the Tier 0/1/2 nudge system (N1, N3, N5).
 *
 * State is a small JSON file at `.unerr/state/nudge-<session>.flags`. Session
 * id comes from UNERR_SESSION_ID (set by the daemon/IDE). If unset, we fall
 * back to a per-PID file — no cross-process state, but still beats v1.
 *
 * The store is best-effort and idempotent: if read or write fails, we treat
 * it as "no state" — at worst the agent sees the Tier-0 reminder twice. We
 * never throw; nudge emission must never crash the host command.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface NudgeSessionState {
  tier0_emitted: boolean;
  /** Drift kinds that already got their one-per-session Tier-1 nudge. */
  tier1_emitted_kinds: string[];
  /** Running count of detected drift events. */
  drift_count: number;
  /** Whether the Tier-2 catch-all has already fired this session. */
  tier2_emitted: boolean;
  /** Timestamp of the last successful unerr MCP tool call this session. */
  last_unerr_tool_at?: string;
}

function defaultState(): NudgeSessionState {
  return {
    tier0_emitted: false,
    tier1_emitted_kinds: [],
    drift_count: 0,
    tier2_emitted: false,
  };
}

function statePath(cwd: string): string {
  const sessionId = process.env.UNERR_SESSION_ID ?? `pid-${process.pid}`;
  return join(cwd, ".unerr", "state", `nudge-${sessionId}.flags`);
}

export function readNudgeState(cwd: string): NudgeSessionState {
  try {
    const path = statePath(cwd);
    if (!existsSync(path)) return defaultState();
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<NudgeSessionState>;
    return {
      tier0_emitted: Boolean(parsed.tier0_emitted),
      tier1_emitted_kinds: Array.isArray(parsed.tier1_emitted_kinds)
        ? parsed.tier1_emitted_kinds.filter((s) => typeof s === "string")
        : [],
      drift_count:
        typeof parsed.drift_count === "number" ? parsed.drift_count : 0,
      tier2_emitted: Boolean(parsed.tier2_emitted),
      last_unerr_tool_at:
        typeof parsed.last_unerr_tool_at === "string"
          ? parsed.last_unerr_tool_at
          : undefined,
    };
  } catch {
    return defaultState();
  }
}

export function writeNudgeState(cwd: string, state: NudgeSessionState): void {
  try {
    const path = statePath(cwd);
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    /* best effort */
  }
}

/** Convenience helper: read, mutate, write atomically. */
export function updateNudgeState(
  cwd: string,
  mutator: (s: NudgeSessionState) => void
): NudgeSessionState {
  const s = readNudgeState(cwd);
  mutator(s);
  writeNudgeState(cwd, s);
  return s;
}

/** Reset all flags for the current session — escape hatch for tests. */
export function _resetNudgeState(cwd: string): void {
  try {
    writeNudgeState(cwd, defaultState());
  } catch {
    /* ignore */
  }
}

/**
 * Called by the MCP layer on every successful unerr tool invocation.
 * Resets the drift accumulator and stamps the last-used timestamp so
 * Tier-2 escalation only fires on persistent drift.
 */
export function markUnerrToolUsed(cwd: string): void {
  try {
    updateNudgeState(cwd, (s) => {
      s.drift_count = 0;
      s.tier2_emitted = false;
      s.last_unerr_tool_at = new Date().toISOString();
    });
  } catch {
    /* best effort */
  }
}
