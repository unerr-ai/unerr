/**
 * Full-file read-deny meter — the in-process emit for the read-routing guard.
 * When the PreToolUse Read hook DENIES a wasteful full-file CODE Read
 * (`preReadHandler`, navigation-hooks.ts), this records the matching
 * `full_file_read_denied` savings event straight into the shared cloud event
 * queue (`.unerr/events/…`), so the prevention is visible on the activation
 * dashboard instead of being inferred. The hook subprocess has no live
 * BehaviorEventWriter, so it constructs a short-lived one — the same pattern the
 * cross-agent delegation meter ({@link recordDelegationHandoff}) uses for shell
 * handoffs. Called from `runPreReadHook`, the only seam a full-file Read deny
 * crosses.
 *
 * This is distinct from the proxy-side `full_read_avoided` event (file_outline
 * SERVING a gated outline instead of the whole file). That fires when unerr's
 * own tool returns less; this fires when the hook BLOCKS the built-in Read —
 * different lever, different seam, both real preventions.
 *
 */
import { join } from "node:path";
import { BehaviorEventWriter } from "./behavior-events.js";
import { emitSavingsEvent } from "./savings-events.js";
import { resolveExecSessionContext } from "./session-records.js";

/**
 * Record a `full_file_read_denied` savings event for a denied full-file code
 * Read. Best-effort and synchronous (the sqlite/queue write is durable before
 * the short-lived hook process exits). Returns true when a row was emitted —
 * false when no live session id can be resolved (nothing to attribute the row
 * to) or on any failure. Never throws.
 */
export function recordFullFileReadDenied(
  repoRoot: string,
  filePath: string,
  agentName?: string
): boolean {
  try {
    const unerrDir = join(repoRoot, ".unerr");
    const ctx = resolveExecSessionContext(unerrDir);
    // No live session id ⇒ nothing to attribute the row to. Drop rather than
    // stamp an orphan event the drainer can't group with a conversation.
    if (!ctx.session_id) return false;

    const writer = new BehaviorEventWriter(unerrDir, ctx.session_id, {
      agent: agentName ?? ctx.agent,
    });
    return emitSavingsEvent(writer, "full_file_read_denied", {
      session_id: ctx.session_id,
      ...(ctx.turn > 0 ? { turn: ctx.turn } : {}),
      tool: "Read",
      files_saved: 1,
      note: filePath,
    });
  } catch {
    return false;
  }
}
