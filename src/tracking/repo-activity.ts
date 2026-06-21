/**
 * Spool repo-lifecycle moments (added / removed / started / stopped /
 * agent_attached) into the per-repo `.unerr/events/` JSONL store. The events
 * drainer pushes them
 * to the cloud as `repo_activity` events — a true timeline of a repo's life
 * with unerr, including `removed`, which the fleet snapshot can never express.
 *
 * Spooling must never break the proxy or daemon: every helper swallows its own
 * errors. `added`/`started` carry the unerr-standpoint repo profile; the others
 * omit it.
 *
 * @sem domain=cloud role=identity
 */
import type { MetricsStore } from "./metrics-store.js";
import {
  type ProfileGraph,
  type RepoProfileData,
  type RepoProfileExtras,
  buildRepoProfile,
} from "./repo-profile.js";

/** The lifecycle moment. Mirrors the contract's repo_activity `action` enum. */
export type RepoActivityAction =
  | "added"
  | "removed"
  | "started"
  | "stopped"
  | "agent_attached";

/** Session/agent correlation + timing for one lifecycle row. All optional. */
export interface RepoActivityContext {
  sessionId?: string;
  nativeSessionId?: string;
  agent?: string;
  turn?: number;
  toolUseId?: string;
  profile?: RepoProfileData;
  /** When the moment happened (ISO-8601). Defaults to now. */
  at?: string;
}

/** Actions that carry the repo profile (the others are not a graph snapshot). */
const PROFILE_ACTIONS = new Set<RepoActivityAction>(["added", "started"]);

/**
 * Write one lifecycle row. Synchronous (no profile build) — pass a prebuilt
 * profile in `ctx.profile` if you want one. Returns the new rowid, 0 on any
 * failure (a closed store, a spool error). Never throws.
 */
export function recordRepoActivity(
  store: MetricsStore,
  action: RepoActivityAction,
  ctx: RepoActivityContext = {}
): number {
  try {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    return store.insertRepoActivity({
      ts: now,
      ts_iso: nowIso,
      action,
      at: ctx.at ?? nowIso,
      profile: ctx.profile ? JSON.stringify(ctx.profile) : null,
      session_id: ctx.sessionId ?? null,
      native_session_id: ctx.nativeSessionId ?? null,
      turn: ctx.turn ?? null,
      agent: ctx.agent ?? null,
      tool_use_id: ctx.toolUseId ?? null,
    });
  } catch {
    return 0;
  }
}

/**
 * Build the profile (for added/started) from the graph, then spool the row.
 * The profile build is best-effort: a graph that's not ready yields a row with
 * no profile rather than a thrown emit. Never throws.
 */
export async function emitRepoActivity(
  store: MetricsStore,
  action: RepoActivityAction,
  opts: {
    graph?: ProfileGraph;
    extras?: RepoProfileExtras;
    context?: RepoActivityContext;
  } = {}
): Promise<number> {
  let profile: RepoProfileData | undefined;
  if (opts.graph && PROFILE_ACTIONS.has(action)) {
    try {
      profile = await buildRepoProfile(opts.graph, opts.extras);
    } catch {
      /* graph not ready — spool the row without a profile */
    }
  }
  return recordRepoActivity(store, action, { ...opts.context, profile });
}
