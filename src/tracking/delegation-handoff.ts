/**
 * Cross-agent delegation meter — the in-process emit for a delegation handoff
 * that runs as a SHELL command instead of a Claude-Code marker. Claude Code
 * delivers the Issue-5 delegation savings family through the Stop-hook marker
 * scrape (`mark_intent: delegate <class>`); Codex / Cursor / Copilot CLI have
 * `hooks.stop=false`, so their handoffs (`codex exec -m`, `cursor-agent -p -m`,
 * `copilot … --model`) were invisible to the meter. This producer recognizes the
 * handoff command and records the SAME `harness_subagent_model` +
 * `delegated_to_junior` rows straight into the shared `.unerr/metrics.db`
 * behavior_events table — so the delegation meter fires on every host, not just
 * Claude Code. Called from the two seams a shell handoff crosses:
 *   - `unerr exec` (`runExecMain`) — the rewrite-capable hosts (Codex) route the
 *     handoff through `unerr exec -- codex exec -m …`,
 *   - the pre-shell hook (`runPreShellHook`) — Cursor / Copilot can't rewrite, so
 *     their raw handoff command surfaces there.
 * A given handoff crosses exactly one seam per host (wrapped → exec, raw →
 * pre-shell), so there is no double count.
 *
 * @sem domain=tracking role=producer
 */
import { join } from "node:path";
import { detectDelegationHandoff } from "../skills/junior-agent.js";
import { BehaviorEventWriter } from "./behavior-events.js";
import { emitDelegationSavings } from "./savings-events.js";
import { resolveExecSessionContext } from "./session-records.js";

/**
 * Record the delegation savings family if `cmd` is a cheaper-model handoff.
 * Best-effort and synchronous (better-sqlite3 writes are sync, so the event is
 * durable before the short-lived exec/hook process exits). Returns the number of
 * savings rows emitted — 0 when the command is not a handoff, when no live
 * session id can be resolved, or on any failure. Never throws.
 */
export function recordDelegationHandoff(repoRoot: string, cmd: string): number {
  try {
    const hit = detectDelegationHandoff(cmd);
    if (!hit) return 0;

    const unerrDir = join(repoRoot, ".unerr");
    const ctx = resolveExecSessionContext(unerrDir);
    // No live session id ⇒ nothing to attribute the row to. Drop rather than
    // stamp an orphan event the drainer can't group with a conversation.
    if (!ctx.session_id) return 0;

    const writer = new BehaviorEventWriter(unerrDir, ctx.session_id, {
      agent: ctx.agent,
    });
    return emitDelegationSavings(writer, {
      session_id: ctx.session_id,
      ...(ctx.turn > 0 ? { turn: ctx.turn } : {}),
      // The shell handoff carries the tier (from the model) but not the task
      // class (tests vs recon vs lint), so the class-gated kinds
      // (recon_in_cheap_subagent / worker_batch_parallel) stay off; the two
      // tier-only kinds fire — the core "a sub-task ran off the senior on a
      // cheaper tier" signal.
      delegable_class: "cross_agent",
      sweep: false,
      tier: hit.tier,
      tool: `${hit.host} exec`,
    });
  } catch {
    return 0;
  }
}
