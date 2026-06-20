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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

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
  /** Whether the prompt-submit hook has already injected the mark_intent
   *  one-shot reminder this session. Per Anthropic #47565 (argue-back
   *  failure), this reminder fires AT MOST once — repeating it makes the
   *  agent argue with the hook instead of complying. */
  mark_intent_emitted: boolean;
  /** Number of times the agent satisfied the mark_intent contract this
   *  session (mark_intent tool call landed). Telemetry only — not used
   *  for gating. */
  mark_intent_compliant_count: number;
  /** Number of code-task prompts seen this session where mark_intent was
   *  expected. Pairs with mark_intent_compliant_count for a session-level
   *  compliance ratio. */
  mark_intent_required_count: number;
  /** T3.4 — Whether the prompt-submit hook has already injected the
   *  cross-session stitch line (last intent + open blockers from the
   *  prior session's ledger) for this session. Fires AT MOST once per
   *  UNERR_SESSION_ID. */
  cross_session_stitch_emitted: boolean;
  /** Lever C — number of times the prompt-submit hook injected the
   *  Moment 1 (`unerr_recall_notes`) directive this session. Fires every
   *  coding-task prompt (not one-shot) — the four-moment contract requires
   *  Moment 1 on every prompt receipt. */
  moment1_emitted_count: number;
  /** Moment 3 plan-cite directive — one-shot per session. Once the agent
   *  has been told to cite recalled notes by note_id in its plan,
   *  re-injecting is argue-back noise. */
  moment3_emitted: boolean;
  /** Implementation-phase "speak plainly" directive — one-shot per
   *  session. Fires the first turn where the agent has demonstrably leaned
   *  on unerr tools (≥2 MCP calls) so the reminder lands when it's
   *  relevant rather than ahead of demand. */
  impl_mention_emitted: boolean;
  /** Running count of coding-task prompts where the close-out reminder
   *  (`buildTurnSummaryLine`) was injected. Pairs with
   *  `turn_summary_emitted_count` to detect when the agent skipped the
   *  `unerr_turn_summary` call. */
  turn_summary_required_count: number;
  /** Running count of `unerr_turn_summary` tool invocations actually
   *  observed this session. Bumped by the proxy on every dispatch to
   *  `handleTurnSummaryProxy`. */
  turn_summary_emitted_count: number;
  /** Tier-2 accumulator — consecutive coding-task turns where the
   *  close-out reminder was injected but the agent did NOT call
   *  `unerr_turn_summary`. Resets to 0 the moment the tool runs. When this
   *  hits the threshold the next prompt receives the escalated receipt
   *  nudge instead of the standard one-liner. */
  consecutive_receipt_misses: number;
  /** Token-tax fix (#7) — whether the prompt-submit hook has already emitted
   *  the static tool-roster + skill catalog this session. Both duplicate the
   *  cached CLAUDE.md tool-routing section and the installed `.claude/skills/`
   *  menu, so re-injecting them every turn is uncacheable re-bill. Emit once
   *  per session; later turns carry only prompt-specific signal (recall,
   *  drift, stitch, the four-moment ur|act lines, Path A skill dispatch). */
  static_boilerplate_emitted: boolean;
  /** Token-tax fix (#9) — whether the `unerr exec` rotating tool-adoption
   *  nudge has already been emitted this session. The roster duplicates the
   *  cached CLAUDE.md tool table, so re-emitting it on every Bash call is
   *  per-operation re-bill; emit once per session, then stay silent. */
  exec_nudge_emitted: boolean;
}

function defaultState(): NudgeSessionState {
  return {
    tier0_emitted: false,
    tier1_emitted_kinds: [],
    drift_count: 0,
    tier2_emitted: false,
    mark_intent_emitted: false,
    mark_intent_compliant_count: 0,
    mark_intent_required_count: 0,
    cross_session_stitch_emitted: false,
    moment1_emitted_count: 0,
    moment3_emitted: false,
    impl_mention_emitted: false,
    turn_summary_required_count: 0,
    turn_summary_emitted_count: 0,
    consecutive_receipt_misses: 0,
    static_boilerplate_emitted: false,
    exec_nudge_emitted: false,
  };
}

/**
 * Pin the stable per-repo session id into `process.env.UNERR_SESSION_ID` so
 * every nudge-state read/write in THIS process keys on it instead of
 * `pid-<pid>`. Each Claude Code hook and each `unerr exec` is a fresh
 * short-lived process that does NOT inherit the long-lived proxy's
 * UNERR_SESSION_ID; without this, session-scoped one-shots (tool roster, the
 * exec nav-nudge, mark_intent, …) re-fire on every turn / every Bash call
 * because each PID gets its own empty flags file. Resolves the id the proxy
 * persists at `.unerr/state/session.id`. Best-effort: never overrides an
 * inherited id, never throws — a miss just leaves the prior per-PID fallback.
 */
export function pinSessionIdEnv(cwd: string): void {
  if (process.env.UNERR_SESSION_ID) return;
  try {
    const id = readFileSync(
      join(cwd, ".unerr", "state", "session.id"),
      "utf8"
    ).trim();
    if (id.length > 0) process.env.UNERR_SESSION_ID = id;
  } catch {
    // No live proxy / no session.id file — leave unset; statePath falls back
    // to pid-<pid> exactly as before.
  }
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
      mark_intent_emitted: Boolean(parsed.mark_intent_emitted),
      mark_intent_compliant_count:
        typeof parsed.mark_intent_compliant_count === "number"
          ? parsed.mark_intent_compliant_count
          : 0,
      mark_intent_required_count:
        typeof parsed.mark_intent_required_count === "number"
          ? parsed.mark_intent_required_count
          : 0,
      cross_session_stitch_emitted: Boolean(
        parsed.cross_session_stitch_emitted
      ),
      moment1_emitted_count:
        typeof parsed.moment1_emitted_count === "number"
          ? parsed.moment1_emitted_count
          : 0,
      moment3_emitted: Boolean(parsed.moment3_emitted),
      impl_mention_emitted: Boolean(parsed.impl_mention_emitted),
      turn_summary_required_count:
        typeof parsed.turn_summary_required_count === "number"
          ? parsed.turn_summary_required_count
          : 0,
      turn_summary_emitted_count:
        typeof parsed.turn_summary_emitted_count === "number"
          ? parsed.turn_summary_emitted_count
          : 0,
      consecutive_receipt_misses:
        typeof parsed.consecutive_receipt_misses === "number"
          ? parsed.consecutive_receipt_misses
          : 0,
      // Missing key on an older state file defaults to false → the catalog +
      // roster emit once after upgrade, then gate. Forward-compatible.
      static_boilerplate_emitted: Boolean(parsed.static_boilerplate_emitted),
      exec_nudge_emitted: Boolean(parsed.exec_nudge_emitted),
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

const NUDGE_FLAG_RE = /^nudge-.+\.flags$/;

/**
 * Delete every `nudge-<session>.flags` file in `.unerr/state/` except the
 * CURRENT session's, at boot.
 *
 * Flag files are pure per-session scratch state. `readNudgeState` only ever
 * reads the live session's own path (keyed by `UNERR_SESSION_ID`, or
 * `pid-<pid>` when unset), so a dead session's file is read by nothing — not
 * the nudge system, and not the dashboard compliance ribbon
 * (`buildComplianceRibbon` also reads only the live session via
 * `readNudgeState`). They carry no cross-session value, so the sweep deletes
 * them outright rather than retaining a TTL/cap window. One file is minted per
 * session and nothing else removes them (we found 890 accreted), so this boot
 * sweep is the sole reclaimer. The current session's file is always spared.
 * Best-effort; never throws. Returns the number of files removed.
 */
export function sweepNudgeFlags(cwd: string): number {
  const dir = join(cwd, ".unerr", "state");
  if (!existsSync(dir)) return 0;
  const active = basename(statePath(cwd));
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!NUDGE_FLAG_RE.test(name)) continue;
      if (name === active) continue; // never touch the live session's file
      const full = join(dir, name);
      try {
        if (!statSync(full).isFile()) continue;
        unlinkSync(full);
        removed++;
      } catch {
        /* best effort — skip this entry */
      }
    }
  } catch {
    /* dir disappeared mid-sweep */
  }
  return removed;
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
