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
import { parseDelegationIntent } from "../intelligence/delegation.js";
import { gatherNotices, renderNoticesRed } from "../notices/status-notices.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { renderStopReportLive } from "../proxy/turn-report.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { readNamedEvents } from "../tracking/named-events.js";
import { emitSavingsEvent } from "../tracking/savings-events.js";
import { resolveExecSessionContext } from "../tracking/session-records.js";
import { enqueueTranscriptClaim } from "../tracking/transcript-claim.js";
import { spawnUnerr } from "../utils/self-spawn.js";
import { enrich, runStopHookAsync } from "./hook-runner.js";
import {
  type PersistOptions,
  STOP_PERSIST_WORKER_TIMEOUT_MS,
  persistSentinels,
  readClosingMessageFromTranscript,
} from "./sentinel-persist.js";
import { scrapeSentinels } from "./sentinel-scrape.js";

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
 * T7.9 — persist `unerr-save:` sentinels WITHOUT blocking the economy line.
 *
 * The Stop hook used to await the UDS writes (sequential, ≤400ms each — ~1.6s
 * worst case for 4 markers) before the close-out line could render. Now it
 * scrapes locally (one sync file read, sub-millisecond) only to decide whether
 * there is anything to persist, then hands the actual UDS writes to a detached
 * `unerr hook stop-persist --transcript <path>` worker and returns immediately.
 * The worker re-reads the transcript from argv — detached children get no
 * stdin — and outlives this short-lived hook subprocess via unref().
 *
 * Accepted race: a sub-second follow-up prompt may recall before the
 * just-spawned worker lands its writes; the saves surface one turn later.
 * Returns true when a worker was spawned. Never throws.
 */
export function spawnStopPersistWorker(stdinJson: string): boolean {
  try {
    const raw = JSON.parse(stdinJson) as { transcript_path?: unknown };
    const transcriptPath =
      typeof raw.transcript_path === "string" ? raw.transcript_path : undefined;
    if (!transcriptPath) return false;
    const closing = readClosingMessageFromTranscript(transcriptPath);
    if (!closing || scrapeSentinels(closing).length === 0) return false;

    const child = spawnUnerr(
      ["hook", "stop-persist", "--transcript", transcriptPath],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Worker body for `unerr hook stop-persist` — runs in the detached child.
 * Re-reads the transcript named on argv, scrapes the closing message, and
 * persists every sentinel over UDS with the relaxed worker timeout (no IDE
 * hook deadline applies here). Returns the count acked. Never throws.
 */
export async function runStopPersistWorkerAsync(
  transcriptPath: string,
  options: PersistOptions = {}
): Promise<number> {
  try {
    const closing = readClosingMessageFromTranscript(transcriptPath);
    if (!closing) return 0;
    const saves = scrapeSentinels(closing);
    if (saves.length === 0) return 0;
    return await persistSentinels(saves, {
      timeoutMs: STOP_PERSIST_WORKER_TIMEOUT_MS,
      ...options,
    });
  } catch {
    return 0;
  }
}

/**
 * Issue 5 leak detector — `subtasks_serialized_by_master`. The prompt hook arms
 * `delegable_nudge_pending` when it routes a delegable task to `unerr-delegate`.
 * At turn end this checks the close-out: if the agent emitted a `delegate`
 * marker it acted on the nudge (no leak); if the pending flag is still set and
 * no delegate marker landed, the master kept the delegable work itself — a leak
 * the activation dashboard should see. Records one event, then clears the flag
 * so the same un-acted nudge fires the leak at most once. The closing message is
 * the one the persist worker already scrapes (sub-millisecond sync read), so
 * this adds no transcript re-read on the hot path beyond that. Best-effort —
 * never throws, returns true only when a leak row was emitted.
 */
export function detectSerializedByMasterLeak(
  stdinJson: string,
  unerrDir: string
): boolean {
  try {
    const cwd = process.cwd();
    if (!readNudgeState(cwd).delegable_nudge_pending) return false;

    // Did the close-out carry a `delegate <class>` marker?
    let delegated = false;
    try {
      const raw = JSON.parse(stdinJson) as { transcript_path?: unknown };
      const tp =
        typeof raw.transcript_path === "string"
          ? raw.transcript_path
          : undefined;
      const closing = tp ? readClosingMessageFromTranscript(tp) : null;
      if (closing) {
        delegated = scrapeSentinels(closing).some(
          (s) =>
            s.kind === "marker" &&
            s.op === "intent" &&
            parseDelegationIntent(s.text) !== null
        );
      }
    } catch {
      /* treat an unreadable transcript as "no marker" */
    }

    // The turn is over — disarm the flag regardless of outcome.
    updateNudgeState(cwd, (s) => {
      s.delegable_nudge_pending = false;
    });
    if (delegated) return false; // acted on — not a leak

    const ctx = resolveExecSessionContext(unerrDir);
    if (!ctx.session_id) return false;
    const writer = new BehaviorEventWriter(unerrDir, ctx.session_id, {
      agent: ctx.agent,
    });
    return emitSavingsEvent(writer, "subtasks_serialized_by_master", {
      session_id: ctx.session_id,
      ...(ctx.turn > 0 ? { turn: ctx.turn } : {}),
      tool: "unerr-delegate",
      note: "delegable nudge fired but the master kept the work",
    });
  } catch {
    return false;
  }
}

/**
 * Planner-mode close-out — when the prompt hook opened the task tracker this
 * turn (tracker_open_pending set), return a reminder to mark finished tasks
 * completed and clear stale ones, then disarm the flag so it fires at most once
 * per opening. Master-only (a sub-agent shares cwd and would false-clear it).
 * Best-effort — returns "" on any error.
 */
export function buildTrackerCloseReminder(cwd: string): string {
  try {
    if (!readNudgeState(cwd).tracker_open_pending) return "";
    updateNudgeState(cwd, (s) => {
      s.tracker_open_pending = false;
      s.tracker_close_reminder_count += 1;
    });
    return "ur|act close the tracker — you opened tracker tasks this turn: TaskUpdate every finished task to completed, and delete or complete any stale task, so the list is clean before the turn ends.";
  } catch {
    return "";
  }
}

/**
 * Stop hook entry. Scrapes + persists any `unerr-save:` sentinels from the
 * closing message, then computes the close-out line for the active session/turn
 * and returns it as a user-facing systemMessage. When the turn has no rich
 * receipt (honest-zero) or an internal error occurs, it falls back to a one-line
 * presence marker (`stopPresenceLine`) instead of a silent "{}" — every turn
 * confirms unerr is active. Only truly unparseable stdin still yields "{}".
 */
export async function runStopHookHandlerAsync(
  stdinJson: string
): Promise<string> {
  try {
    // Write-capture (T7.9) is handed to a detached worker — the economy line
    // renders immediately instead of waiting on sequential UDS writes.
    spawnStopPersistWorker(stdinJson);

    const unerrDir = join(process.cwd(), ".unerr");

    // Issue 5 leak — a delegable nudge fired this turn but the master kept the
    // work (no `delegate` marker in the close-out). Best-effort, off the line.
    detectSerializedByMasterLeak(stdinJson, unerrDir);
    const trackerCloseLine = buildTrackerCloseReminder(process.cwd());
    const resolved = resolveCurrentSessionTurn(unerrDir);
    if (!resolved) {
      // No tracked events this turn — confirm unerr ran instead of a silent
      // "{}". No silent passthrough remains in this handler.
      const presence = stopPresenceLine(null);
      const presenceMessage = trackerCloseLine
        ? `${presence}\n${trackerCloseLine}`
        : presence;
      return runStopHookAsync(stdinJson, async () => enrich(presenceMessage));
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

    const finalMessage = trackerCloseLine
      ? `${message}\n${trackerCloseLine}`
      : message;

    return runStopHookAsync(stdinJson, async () => enrich(finalMessage));
  } catch {
    // Even on an internal error, prefer a presence line over a silent "{}".
    return runStopHookAsync(stdinJson, async () =>
      enrich(stopPresenceLine(null))
    );
  }
}

/**
 * SubagentStop hook entry. Same as `runStopHookHandlerAsync` but OMITS the
 * master-only `detectSerializedByMasterLeak` call: a sub-agent shares the
 * master's cwd, so running the leak detector here would false-fire
 * `subtasks_serialized_by_master` and wipe the master's pending flag mid-turn.
 * Everything else — sentinel persist worker, transcript claim, and the
 * close-out economy line — fires identically to the Stop hook.
 *
 * @sem domain=agent-hooks
 */
export async function runSubagentStopHookHandlerAsync(
  stdinJson: string
): Promise<string> {
  try {
    spawnStopPersistWorker(stdinJson);

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
