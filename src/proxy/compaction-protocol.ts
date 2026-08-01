/**
 * Compaction control-channel protocol (cost lever 3).
 *
 * The single source of truth for the `unerr/compaction` request/response shape
 * exchanged over the per-repo UDS socket (`.unerr/state/proxy.sock`). The proxy
 * answers it (see proxy.ts UDS handler); the compaction hooks build the request
 * and read the ack. Both sides import THIS module so the wire contract can never
 * drift between producer and consumer.
 *
 * Why it exists: file-body dedup (`BodyDedupStore`, session-dedup.ts) may only
 * answer "you already have this file" while the earlier copy is still in the
 * agent's context. Compaction evicts it, and the harness — not unerr — knows
 * when that happened. Claude Code reports it twice: `PostCompact` (matcher
 * `manual|auto`) and `SessionStart` (matcher `compact`, plus `clear` for a
 * context wipe). Each path sends ONE frame here; the flush is idempotent, so a
 * double-fire drops the entries once and the second call acks `dropped: 0`.
 *
 * Transport: a lightweight JSON-RPC method intercepted before MCP tool dispatch
 * — the hook connects, sends one frame, reads one response, disconnects, with no
 * MCP `initialize` handshake (mirrors `unerr/blast_radius` and `unerr/ping`).
 */

/** JSON-RPC method name for the compaction flush. */
export const COMPACTION_METHOD = "unerr/compaction";

/**
 * Why the agent's context no longer holds what we delivered.
 *
 * Normalized on the hook side to keep the proxy free of harness vocabulary:
 *   - `compact` — the transcript was summarized, older turns evicted
 *     (Claude Code `PostCompact` trigger `manual`/`auto`, or `SessionStart`
 *     source `compact`). The conversation id survives, so the flush is scoped
 *     to that conversation.
 *   - `clear` — the context was wiped wholesale (`SessionStart` source
 *     `clear`). Nothing delivered before it survives anywhere in that harness
 *     process, and the new conversation carries a NEW id that would match no
 *     entry, so the flush is unscoped (drops every tracked body).
 */
export type CompactionTrigger = "compact" | "clear";

/** Request params for {@link COMPACTION_METHOD}. */
export interface CompactionRequestParams {
  /** The agent's own conversation id (Claude Code `session_id`). `null` when
   *  the payload carried none — the flush then falls back to unscoped. */
  session_id?: string | null;
  /** What happened to the context. Defaults to `compact` when absent. */
  trigger?: CompactionTrigger;
}

/** Result payload for {@link COMPACTION_METHOD}. */
export interface CompactionResult {
  /** How many delivered-body dedup entries the flush dropped. 0 means the
   *  flush was already applied (idempotent double-fire) or nothing was
   *  tracked. */
  dropped: number;
}

/**
 * The flush target the handler drives — structurally the `clearBodies` half of
 * `BodyDedupStore`, so the store itself satisfies it and a test can pass a bare
 * stub. Typed here (not imported) to keep this protocol module dependency-free:
 * the hook-side client imports it and must not pull the dedup store's fs work
 * into a short-lived hook process.
 */
export interface CompactionFlushTarget {
  /** Drop delivered-body entries for a conversation (or all when the
   *  conversation is unknown). Returns the number of entries dropped. */
  clearBodies(nativeSessionId?: string | null): number;
}

/** Runtime shape check for a reply read off the wire. */
export function isCompactionResult(value: unknown): value is CompactionResult {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).dropped === "number";
}

/**
 * Apply a compaction flush. Always returns a well-formed ack (`dropped: 0` when
 * there is no target) so the hook never has to special-case a reply.
 *
 * Scope rule: a `compact` keeps the conversation id, so the flush is scoped to
 * it and a second concurrent conversation against the same repo keeps its
 * entries. A `clear` (or a missing conversation id) cannot be scoped, so it
 * drops everything — over-dropping costs one re-read, under-dropping would hand
 * the agent a pointer to content it no longer has.
 */
export function handleCompactionRequest(
  target: CompactionFlushTarget | null,
  params: CompactionRequestParams | undefined
): CompactionResult {
  if (!target) return { dropped: 0 };
  const trigger: CompactionTrigger = params?.trigger ?? "compact";
  const scope = trigger === "clear" ? null : params?.session_id?.trim() || null;
  try {
    return { dropped: target.clearBodies(scope) };
  } catch {
    // The control channel must always answer — a faulted store is reported as
    // "nothing dropped" rather than a JSON-RPC error the hook can't act on.
    return { dropped: 0 };
  }
}
