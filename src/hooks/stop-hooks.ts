/**
 * Stop hook — surfaces the close-out economy line when the agent finishes a
 * turn, with ZERO extra round-trip.
 *
 * Previously the agent had to call the `unerr_turn_summary` MCP tool at the end
 * of every coding turn and paste the returned `line` verbatim — a guaranteed
 * round-trip plus a compliance burden the agent often skipped. The Stop event
 * fires automatically at turn end, so unerr computes the same line server-side
 * from the on-disk event stream and hands it to the user directly.
 *
 * Channel: Claude Code's Stop event has NO additionalContext (it cannot inject
 * model-readable context), so the line rides a user-facing `systemMessage`.
 * That is exactly right — the economy line was always user-facing telemetry.
 *
 * Cursor / Cline have no Stop-with-systemMessage channel; their adapters format
 * to "{}" and those sessions keep the MCP `unerr_turn_summary` paste path as a
 * fallback (the tool stays registered — DEMOTE not delete).
 */

import { join } from "node:path";
import { gatherNotices, renderNoticesRed } from "../notices/status-notices.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { renderStopReportLive } from "../proxy/turn-report.js";
import {
  currentTurnSlice,
  latestPromptBoundaryTs,
  readNamedEvents,
} from "../tracking/named-events.js";
import { readEditLogSince } from "../tracking/session-edit-log.js";
import { enqueueTranscriptClaim } from "../tracking/transcript-claim.js";
import { enrich, runStopHookAsync } from "./hook-runner.js";

/**
 * Minimal one-line presence marker for the Stop / SubagentStop hooks.
 *
 * The rich end-of-turn receipt (`renderStopReportLive`) renders "" on an
 * honest-zero turn — no tokens saved, no headroom banked, no bucketed event —
 * and the session/turn does not resolve at all on a turn with no tracked tool
 * calls. Both cases used to emit a silent "{}". Instead the hook emits this line
 * so every turn confirms unerr is active (no silent passthrough). User-facing
 * telemetry (`unerr » ` prefix, which agents never echo or act on). Agents with
 * no Stop output channel (Codex, Cline, Antigravity, Copilot CLI) still drop it
 * at the adapter; Claude Code (systemMessage) and Windsurf (stderr) surface it.
 */
export function stopPresenceLine(currentTurn: number | null): string {
  return currentTurn && currentTurn > 0
    ? `unerr » turn ${currentTurn} · active · no tracked changes this turn`
    : "unerr » active · no tracked tool calls this turn";
}

/**
 * Resolve the live session id + current (max) turn from the on-disk named-event
 * stream. The most recently appended event names the active session; the
 * current turn is the largest turn index seen for that session. Returns null
 * when there are no events yet (nothing to summarise).
 *
 * Also exposes `nativeSessionId` — the agent's own conversation id
 * (`native_session_id` on the last event). When non-null, callers use it as
 * the primary correlation key so that proxy-written edits and hook-written
 * prompt-boundary events (which may carry different `session_id` values but
 * share the same `native_session_id`) are gathered into one stream.
 */
export function resolveCurrentSessionTurn(unerrDir: string): {
  sessionId: string;
  nativeSessionId: string | null;
  currentTurn: number;
  agent: string;
} | null {
  const events = readNamedEvents(unerrDir, {});
  if (events.length === 0) return null;

  // Append order ⇒ the last event belongs to the active session.
  const last = events[events.length - 1]!;
  const sessionId = last.session_id;
  if (!sessionId) return null;

  // Use native_session_id as the primary cross-process correlation key.
  // Null for legacy/exec rows that pre-date native id stamping.
  const nativeSessionId = last.native_session_id ?? null;

  // Max turn across all events that belong to the same native conversation
  // (or the same session_id for legacy rows without a native id).
  let currentTurn = 0;
  for (const ev of events) {
    const sameConversation = nativeSessionId
      ? ev.native_session_id === nativeSessionId
      : ev.session_id === sessionId;
    if (sameConversation && ev.turn > currentTurn) {
      currentTurn = ev.turn;
    }
  }
  return { sessionId, nativeSessionId, currentTurn, agent: last.agent };
}

/**
 * Verification-awareness (W4) result of {@link evaluateVerifyGate}: a soft
 * advisory line to append to the existing systemMessage. Never blocks the
 * Stop — verify findings are advisory only.
 */
type VerifyGateResult = { line: string };

/**
 * Exit-code-aware outcome of the last check command relative to a turn's last
 * edit: "green" (passed at/after the edit — verified), "red" (a real check
 * ran at/after the edit and FAILED, with no later green superseding it),
 * "unknown" (a check ran at/after the edit through an env that only stamps
 * `check_cmd_last_ts`, not the exit code — e.g. hooks partially installed),
 * or "none" (no recognized check ran after the edit).
 */
type CheckOutcome = "green" | "red" | "unknown" | "none";

const VERIFY_SOFT_LINE =
  "unerr » edits landed with no check run this turn — delegate a verify-run (typecheck + targeted tests) to unerr-junior before building on it";

const VERIFY_SOFT_LINE_RED =
  "unerr » the check run after this turn's edits FAILED — fix the failure and rerun until green before building on it";

/**
 * Whether this turn had file edits and, if so, the exit-code-aware outcome
 * (`checkGreenLastTs` / `checkRedLastTs` / `checkCmdLastTs`, from
 * `runExecMain`'s exit-code stamp and `postBashHandler`'s ran-only fallback)
 * of the last check relative to the last edit — see {@link CheckOutcome}.
 * Merges two independent edit sources so a native Write/Edit — which never
 * emits a `code_edit_applied` named event — is not invisible to the gate: (1)
 * `code_edit_applied` events in the current-turn slice (`readNamedEvents` +
 * `currentTurnSlice`, unchanged), and (2) `session-edits.jsonl` ledger rows
 * ({@link readEditLogSince}) at or after this turn's prompt boundary
 * (`latestPromptBoundaryTs`). The ledger persists across turns/sessions, so
 * with no prompt boundary its rows never count — counting a stale cross-turn
 * row risks trapping the agent in a block loop. `referenceTs`, the timestamp
 * a check must beat, is the max across whichever source(s) contributed.
 */
function turnVerifyStatus(
  unerrDir: string,
  currentTurn: number,
  checkCmdLastTs: number,
  checkGreenLastTs: number,
  checkRedLastTs: number
): { hadEdits: boolean; outcome: CheckOutcome } {
  const events = readNamedEvents(unerrDir, {});
  const turnEvents = currentTurnSlice(events, currentTurn);
  const namedEdits = turnEvents.filter(
    (e) => e.event_type === "code_edit_applied"
  );
  const promptBoundaryTs = latestPromptBoundaryTs(events);

  const ledgerEdits =
    promptBoundaryTs !== null
      ? readEditLogSince(unerrDir, promptBoundaryTs)
      : [];

  if (namedEdits.length === 0 && ledgerEdits.length === 0) {
    return { hadEdits: false, outcome: "none" };
  }

  const namedTimestamps = namedEdits
    .map((e) => Date.parse(e.ts))
    .filter((t) => Number.isFinite(t));
  const namedRef =
    namedEdits.length > 0
      ? namedTimestamps.length > 0
        ? Math.max(...namedTimestamps)
        : (promptBoundaryTs ?? 0)
      : null;

  const ledgerTimestamps = ledgerEdits
    .map((e) => Date.parse(e.ts))
    .filter((t) => Number.isFinite(t));
  const ledgerRef =
    ledgerTimestamps.length > 0 ? Math.max(...ledgerTimestamps) : null;

  const contributions = [namedRef, ledgerRef].filter(
    (t): t is number => t !== null
  );
  const referenceTs = contributions.length > 0 ? Math.max(...contributions) : 0;

  // Priority order: a later GREEN always wins (verified) even over an earlier
  // red; else a red that beats the edit blocks; else a check ran but its exit
  // code is invisible (unwrapped env) — fail OPEN rather than trap the agent;
  // else no recognized check ran at all.
  const outcome: CheckOutcome =
    checkGreenLastTs > 0 && checkGreenLastTs >= referenceTs
      ? "green"
      : checkRedLastTs > 0 && checkRedLastTs >= referenceTs
        ? "red"
        : checkCmdLastTs > 0 && checkCmdLastTs >= referenceTs
          ? "unknown"
          : "none";

  return { hadEdits: true, outcome };
}

/**
 * Verification-awareness (W4) Stop gate, exit-code aware. When this turn's
 * edits have no GREEN check after them: green ({@link CheckOutcome}) stays
 * silent (verified); "unknown" (a check ran but its exit code is invisible —
 * an unwrapped env) also stays silent — fail OPEN rather than trap the agent
 * on lost visibility; "red" (a real check ran and FAILED) or "none" (no
 * check ran) both earn a soft advisory line appended to the systemMessage
 * (capped at 2 per session, `verify_soft_count`) — never a block. "red" uses
 * the red-specific line (`VERIFY_SOFT_LINE_RED`) so the agent is told the
 * check FAILED, not merely that none ran. Returns null once there is nothing
 * to say: no edits this turn, green/unknown outcome, or the cap is spent.
 * Best-effort — any internal error degrades to null (unchanged Stop behavior).
 *
 */
export function evaluateVerifyGate(
  unerrDir: string,
  repoRoot: string,
  currentTurn: number
): VerifyGateResult | null {
  try {
    const state = readNudgeState(repoRoot);
    const status = turnVerifyStatus(
      unerrDir,
      currentTurn,
      state.check_cmd_last_ts,
      state.check_green_last_ts,
      state.check_red_last_ts
    );
    if (!status.hadEdits) return null;
    if (status.outcome === "green" || status.outcome === "unknown") {
      return null;
    }

    const isRed = status.outcome === "red";
    const softLine = isRed ? VERIFY_SOFT_LINE_RED : VERIFY_SOFT_LINE;

    if (state.verify_soft_count < 2) {
      updateNudgeState(repoRoot, (s) => {
        s.verify_soft_count += 1;
      });
      return { line: softLine };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stop hook entry. Computes the close-out line for the active session/turn
 * and returns it as a user-facing systemMessage. When the turn has no rich
 * receipt (honest-zero) or an internal error occurs, it falls back to a one-line
 * presence marker (`stopPresenceLine`) instead of a silent "{}" — every turn
 * confirms unerr is active. Only truly unparseable stdin still yields "{}".
 * Verification awareness (W4): when this turn had edits with no GREEN check
 * since (none ran, or one ran and FAILED), `evaluateVerifyGate` appends a soft
 * advisory line to the systemMessage (capped, never blocks); unaffected turns
 * keep the prior message unchanged.
 */
export async function runStopHookHandlerAsync(
  stdinJson: string
): Promise<string> {
  try {
    const unerrDir = join(process.cwd(), ".unerr");

    const resolved = resolveCurrentSessionTurn(unerrDir);
    if (!resolved) {
      // No tracked events this turn — confirm unerr ran instead of a silent
      // "{}". No silent passthrough remains in this handler.
      return runStopHookAsync(stdinJson, async () =>
        enrich(stopPresenceLine(null))
      );
    }

    // Turn-end transcript claim — record only a lightweight pointer (session +
    // turn) to the local queue; the daemon's transcript materializer does the
    // streaming read + cloud push off the hot path, so the Stop hook never
    // blocks on a large transcript. Best-effort; never throws.
    enqueueTranscriptClaim({
      unerrDir,
      repoCwd: process.cwd(),
      sessionId: resolved.sessionId,
      agent: resolved.agent,
      turn: resolved.currentTurn,
    });

    const line = renderStopReportLive(
      unerrDir,
      resolved.sessionId,
      resolved.currentTurn,
      { nativeSessionId: resolved.nativeSessionId }
    );
    const notices = renderNoticesRed(gatherNotices());
    const combined = [line, notices]
      .filter((s) => s.trim().length > 0)
      .join("\n");
    // Always surface something: when the rich receipt is empty (honest-zero
    // turn) fall back to the one-line presence marker — never a silent "{}".
    const message =
      combined.trim().length > 0
        ? combined
        : stopPresenceLine(resolved.currentTurn);

    // Verification awareness (W4) — unchecked edits earn a soft advisory line
    // (capped); everything else about this turn's message is untouched.
    const verifyGate = evaluateVerifyGate(
      unerrDir,
      process.cwd(),
      resolved.currentTurn
    );
    const messageWithVerify = verifyGate
      ? `${message}\n${verifyGate.line}`
      : message;

    return runStopHookAsync(stdinJson, async () => enrich(messageWithVerify));
  } catch {
    // Even on an internal error, prefer a presence line over a silent "{}".
    return runStopHookAsync(stdinJson, async () =>
      enrich(stopPresenceLine(null))
    );
  }
}

/**
 * SubagentStop hook entry. Same as `runStopHookHandlerAsync`: transcript
 * claim and the close-out economy line fire identically to the Stop hook.
 */
export async function runSubagentStopHookHandlerAsync(
  stdinJson: string
): Promise<string> {
  try {
    const unerrDir = join(process.cwd(), ".unerr");

    const resolved = resolveCurrentSessionTurn(unerrDir);
    if (!resolved)
      // No tracked events this turn — confirm unerr ran instead of a silent
      // "{}". No silent passthrough remains in this handler.
      return runStopHookAsync(stdinJson, async () =>
        enrich(stopPresenceLine(null))
      );

    enqueueTranscriptClaim({
      unerrDir,
      repoCwd: process.cwd(),
      sessionId: resolved.sessionId,
      agent: resolved.agent,
      turn: resolved.currentTurn,
    });

    const line = renderStopReportLive(
      unerrDir,
      resolved.sessionId,
      resolved.currentTurn,
      { nativeSessionId: resolved.nativeSessionId }
    );
    const notices = renderNoticesRed(gatherNotices());
    const combined = [line, notices]
      .filter((s) => s.trim().length > 0)
      .join("\n");
    // Always surface something: when the rich receipt is empty (honest-zero
    // turn) fall back to the one-line presence marker — never a silent "{}".
    const message =
      combined.trim().length > 0
        ? combined
        : stopPresenceLine(resolved.currentTurn);

    return runStopHookAsync(stdinJson, async () => enrich(message));
  } catch {
    // Even on an internal error, prefer a presence line over a silent "{}".
    return runStopHookAsync(stdinJson, async () =>
      enrich(stopPresenceLine(null))
    );
  }
}
