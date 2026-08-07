/**
 * unerr cloud — the login gate (single enforcement predicate).
 *
 * unerr's local features (indexing, serving, install, the process manager)
 * need no account at all (OSS conversion, 2026-08). Only two kinds of surface
 * still consult this predicate:
 *
 *   - The `preAction` wall on `conventions` (`src/entrypoints/cli-main.ts`) —
 *     the one command that reads/writes the team's shared cloud document, so
 *     it alone still refuses to run while signed out.
 *   - Agent/hook passthrough surfaces — hooks (`hook-runtime.ts`), `exec`,
 *     `compress-output` — which skip graph-aware or cloud-touching work while
 *     signed out and emit at most one throttled login nudge, but never block.
 *
 * Both kinds decide with the ONE predicate here, so they can never disagree
 * about "is this machine logged in enough to proceed?".
 *
 * It composes `authState()` (the auth state machine) rather than the raw
 * `isLoggedIn()` file check, because the file check can't tell a deliberate
 * offline-grace session (still usable) from a logged-out machine (must block).
 * The block set is exactly the states that mean "no honored plan, and no path
 * to one without reconnecting":
 *
 *   - `logged_out`   — never logged in here.
 *   - `degraded_free`— had a login, but the 7-day grace fully expired.
 *   - `revoked`      — team disconnected this machine.
 *
 * A logged-in FREE user is `active` (because `authState()` returns `active`
 * whenever the cached entitlement is fresh, regardless of plan), so blocking
 * `degraded_free` never locks out legitimate free users.
 *
 * Login PRESENCE is a separate question from plan freshness. An entitlement
 * cache can be fresh with NO actual login behind it — a dev-minted token
 * (`.unerr/dev.json` tier), or a stale leftover after a partial logout. Such a
 * machine is not logged in, so `loginBlocked()` additionally requires real
 * credential metadata (or `UNERR_TOKEN`): a cached entitlement alone never
 * counts as a login. The entitlement cache governs the PLAN, not presence —
 * so in dev the `tier` sets features but no longer skips the wall.
 *
 * The one escape hatch is `UNERR_TOKEN`: an explicit headless credential set in
 * the environment (CI, agent runs with no human to complete a browser flow).
 * Per the MCP stdio convention — servers take credentials from the environment,
 * not an interactive flow — its mere presence means "allowed"; the server
 * rejects it on the wire if it's actually invalid. Without this, CI running
 * `conventions` while signed out would hang on an interactive login it can't
 * complete.
 *
 * Pure and side-effect-free: it never prompts, never opens a browser, never
 * touches the network. The interactive login + re-dispatch lives in the
 * `preAction` wall (see `src/entrypoints/cli-main.ts`), which calls this to
 * decide WHETHER to act.
 */

import { type AuthStateName, authState } from "./auth-state.js";
import { readCredentialMetadata } from "./credentials.js";

/** Auth states that mean "no usable login". Every gated surface refuses on these. */
const BLOCKED_STATES: ReadonlySet<AuthStateName> = new Set([
  "logged_out",
  "degraded_free",
  "revoked",
]);

/**
 * True when an explicit headless credential (`UNERR_TOKEN`) is present. This is
 * the documented CI / non-interactive escape hatch; its presence alone means
 * "treat as logged in" (the server validates it on the wire).
 */
export function hasHeadlessToken(): boolean {
  const token = process.env.UNERR_TOKEN;
  return typeof token === "string" && token.trim().length > 0;
}

/**
 * The single predicate every gated surface calls. Returns true when the command
 * or tool must refuse and route the user to login.
 */
export function loginBlocked(now: number = Date.now()): boolean {
  if (hasHeadlessToken()) return false;
  // A real login must exist on this machine. A fresh entitlement cache with no
  // credential behind it — a dev-minted `.unerr/dev.json` token, or a stale
  // leftover after a partial logout — is a PLAN, not a login, and must not
  // satisfy the wall.
  if (readCredentialMetadata() === null) return true;
  return BLOCKED_STATES.has(authState(now).state);
}

/**
 * Entry shapes that must bypass the interactive command wall: the IDE bridge
 * (`--mcp`, non-interactive — MCP tool calls need no login at all) and the
 * process-manager child (`--daemon-child`, a background process that can
 * never complete a browser login).
 */
export function isInternalEntryShape(
  argv: readonly string[] = process.argv
): boolean {
  return argv.includes("--mcp") || argv.includes("--daemon-child");
}

/**
 * The action line shown when a gated command is refused. Carries the
 * reconnect-specific copy for a revoked machine and the expiry copy for a
 * lapsed grace window, so the message matches why the gate fired.
 */
export function loginGateNotice(now: number = Date.now()): string {
  switch (authState(now).state) {
    case "revoked":
      return "This machine was disconnected by your team — run `unerr login` to reconnect.";
    case "degraded_free":
      return "Your unerr session expired — run `unerr login` to continue.";
    default:
      return "Shared team conventions need an account — run `unerr login`.";
  }
}
