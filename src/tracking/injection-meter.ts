/**
 * Injection-policy telemetry (Issue 6/7) — observability for the per-turn
 * prompt-injection brain (`promptSubmitHandler` / injection-policy.ts). It
 * records what the policy DID each turn, so the activation dashboard can see the
 * brain working instead of inferring it:
 *   - `conversation_routed` (routing) — the turn was routed to a non-default
 *     path (a delegate handoff, a Path A skill, or the orchestrator fallback).
 *   - `injection_suppressed` (savings) — a redundant once-per-session block
 *     (tool roster / skill catalog) was withheld instead of re-billed.
 *   - `one_shot_refire_detected` (leak) — a once-per-session injection emitted
 *     AGAIN within the same session (the pid-keyed nudge-state regression).
 *
 * These are cache-safe, tail-appended injections — telemetry value is trust /
 * maintainability, not token savings (see the injection-policy notes). The hook
 * subprocess has no live writer, so each producer builds a short-lived
 * BehaviorEventWriter — the same pattern the cross-agent meter uses.
 *
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BehaviorEventWriter } from "./behavior-events.js";
import { emitSavingsEvent } from "./savings-events.js";
import { resolveExecSessionContext } from "./session-records.js";

/**
 * Record the routing + suppression signals for one prompt-submit turn. Pass only
 * the signals that fired (`routed` names the chosen route, `suppressed` names the
 * withheld block); each emits one event. Best-effort and synchronous — returns
 * the number of rows emitted, 0 when no live session id resolves or on failure.
 * Never throws.
 */
export function recordInjectionTelemetry(
  repoRoot: string,
  signals: { routed?: string; suppressed?: string }
): number {
  try {
    if (!signals.routed && !signals.suppressed) return 0;
    const unerrDir = join(repoRoot, ".unerr");
    const ctx = resolveExecSessionContext(unerrDir);
    if (!ctx.session_id) return 0;
    const writer = new BehaviorEventWriter(unerrDir, ctx.session_id, {
      agent: ctx.agent,
    });
    const base = {
      session_id: ctx.session_id,
      tool: "UserPromptSubmit",
      ...(ctx.turn > 0 ? { turn: ctx.turn } : {}),
    };
    let n = 0;
    if (
      signals.routed &&
      emitSavingsEvent(writer, "conversation_routed", {
        ...base,
        note: signals.routed,
      })
    )
      n += 1;
    if (
      signals.suppressed &&
      emitSavingsEvent(writer, "injection_suppressed", {
        ...base,
        note: signals.suppressed,
      })
    )
      n += 1;
    return n;
  } catch {
    return 0;
  }
}

/**
 * Detect (and record) a one-shot injection that re-emitted within a session.
 * Keyed on the DURABLE session id (`session.id` file), NOT the per-pid
 * nudge-state flags — so the stamp survives the same flags-file reset that
 * causes the refire, which a nudge-state counter could never observe. Returns
 * true (and emits `one_shot_refire_detected`) when `key` already stamped this
 * session; otherwise stamps it and returns false. Best-effort — never throws.
 */
export function recordOneShotEmit(repoRoot: string, key: string): boolean {
  try {
    const unerrDir = join(repoRoot, ".unerr");
    const ctx = resolveExecSessionContext(unerrDir);
    if (!ctx.session_id) return false;
    const safe = `${ctx.session_id}.${key}`.replace(/[^\w.-]/g, "_");
    const stamp = join(unerrDir, "state", `oneshot-${safe}.flag`);
    if (existsSync(stamp)) {
      const writer = new BehaviorEventWriter(unerrDir, ctx.session_id, {
        agent: ctx.agent,
      });
      emitSavingsEvent(writer, "one_shot_refire_detected", {
        session_id: ctx.session_id,
        tool: "UserPromptSubmit",
        ...(ctx.turn > 0 ? { turn: ctx.turn } : {}),
        note: `one-shot '${key}' re-emitted in session`,
      });
      return true;
    }
    mkdirSync(join(unerrDir, "state"), { recursive: true });
    writeFileSync(stamp, "1", "utf8");
    return false;
  } catch {
    return false;
  }
}
