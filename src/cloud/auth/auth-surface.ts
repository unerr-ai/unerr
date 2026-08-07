/**
 * unerr cloud — Tier-1 in-band auth surfacing (the can't-miss channel).
 *
 * Maps an `AuthState` (the single source of truth) to the one `ur|<tag>` line
 * the per-repo proxy attaches to a tool response, per
 * `.internal/archive/LOGIN_UX_STRATEGY.md` §5. This is the reliable surface — it
 * reaches the human exactly when they're working, through the agent.
 *
 * Loudness comes from the state, not from this file inventing tone:
 *  - `revoked` / `degraded_free` / grace+unauthorized → `act` (a command: the
 *    account changed, the user must act → `unerr login`).
 *  - grace+offline → `fct` (informational: the machine is offline, it will
 *    reconnect on its own → no command, no alarm).
 *  - `active` / `stale_refreshing` / `logged_out` → NOTHING in-band. A working
 *    plan needs no words; a deliberate free user is never nagged (the free→Pro
 *    pull lives on contextual feature-gate denials, not a login banner — see §5
 *    research note). The first-session `logged_out` invite is A5, surfaced
 *    elsewhere so it stays a one-time event.
 *
 * Every line names the ONE command (`unerr login`), states that local features
 * keep working, and never blocks — the cross-tier invariant (§5).
 *
 * Pure: a state in, an optional signal out. No I/O. The proxy owns dedupe.
 */

import type { AuthState, AuthStateName } from "./auth-state.js";

/** The wire tag for the auth line — `act` (command) or `fct` (information). */
export type AuthSignalTag = "act" | "fct";

/** One in-band auth signal: a wire tag + the body line the proxy emits. */
export interface AuthSignal {
  tag: AuthSignalTag;
  /** The body line, already obeying the CLAUDE.md nudge rules. */
  content: string;
  /**
   * The dedupe scope key. The state name, so the proxy emits each distinct
   * state at most once per session (`once per session per state`, §5) yet
   * re-emits when the state genuinely transitions (degraded → revoked).
   */
  dedupKey: string;
}

/** Render an ISO timestamp as a bare `YYYY-MM-DD` date, or null if unusable. */
function asDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * The Tier-1 in-band line for a state, or `null` when nothing should surface
 * in-band (the happy path and the deliberate-free path stay silent).
 */
export function authSurfaceSignal(state: AuthState): AuthSignal | null {
  switch (state.state) {
    case "revoked":
      return {
        tag: "act",
        content:
          "RUN `unerr login` — this machine was removed from your unerr org; local features keep working",
        dedupKey: "revoked",
      };

    case "degraded_free": {
      const by = asDate(state.reconnect_by);
      const expired = by ? ` (Pro entitlement expired ${by})` : "";
      return {
        tag: "act",
        content: `RUN \`unerr login\` — Pro features paused${expired}; local features unaffected`,
        dedupKey: "degraded_free",
      };
    }

    case "grace_expiring": {
      const by = asDate(state.reconnect_by);
      const reconnectBy = by ? ` reconnect by ${by}` : "";
      if (state.reason === "unauthorized") {
        // The account changed server-side — a command is required.
        return {
          tag: "act",
          content: `RUN \`unerr login\` — your unerr Pro access changed;${reconnectBy} or Pro features pause; local features unaffected`,
          dedupKey: "grace_expiring:unauthorized",
        };
      }
      // Offline — quiet, informational; it reconnects on its own.
      return {
        tag: "fct",
        content: `unerr Pro couldn't reach the server (offline) — it reconnects automatically;${
          by ? ` Pro pauses after ${by} if still offline;` : ""
        } local features unaffected`,
        dedupKey: "grace_expiring:offline",
      };
    }

    // active / stale_refreshing / logged_out — silent in-band by design.
    default:
      return null;
  }
}

/**
 * The badge severity for a passive surface (status line, UI header). Drives
 * colour/weight, not wording: `ok` = no attention, `info` = a benign notice,
 * `warn` = action will soon be needed, `attention` = act now.
 */
export type AuthBadge = "ok" | "info" | "warn" | "attention";

/** Map each state to its passive-surface badge severity. */
export function authBadge(state: AuthStateName): AuthBadge {
  switch (state) {
    case "active":
      return "ok";
    case "logged_out":
    case "stale_refreshing":
      return "info";
    case "grace_expiring":
      return "warn";
    case "degraded_free":
    case "revoked":
      return "attention";
  }
}

/**
 * The Tier-2 passive one-liner for `unerr status` / `whoami` / `doctor` and the
 * dashboard header (§5). Unlike the in-band signal, this ALWAYS returns a line
 * (every state has a resting description) — it never interrupts, it just
 * reports. Names the org/machine when known and the reconnect date in grace.
 */
export function authStateLine(state: AuthState): string {
  const who = state.machine_name || "this machine";
  const at = state.organization_id ? ` → ${state.organization_id}` : "";
  const plan = state.plan;
  const by = asDate(state.reconnect_by);

  switch (state.state) {
    case "logged_out":
      return "not connected to a team";
    case "active":
      return `connected as ${who}${at} (${plan} plan)`;
    case "stale_refreshing":
      return `connected as ${who}${at} (${plan} plan, refreshing)`;
    case "grace_expiring":
      if (state.reason === "unauthorized") {
        return `connected as ${who}${at} (${plan} access changed — run unerr login${
          by ? `; pauses ${by}` : ""
        })`;
      }
      return `connected as ${who}${at} (${plan} plan, offline — reconnects automatically${
        by ? `; pauses ${by}` : ""
      })`;
    case "degraded_free":
      return "Pro paused — run unerr login to restore (local features unaffected)";
    case "revoked":
      return "this machine was removed from your team — run unerr login to reconnect";
  }
}
