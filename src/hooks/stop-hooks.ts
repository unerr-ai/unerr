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

import { spawn } from "node:child_process";
import { join } from "node:path";
import { renderStopReportLive } from "../proxy/turn-report.js";
import { readNamedEvents } from "../tracking/named-events.js";
import {
  type HookHandler,
  enrich,
  passthrough,
  runStopHookAsync,
} from "./hook-runner.js";
import {
  type PersistOptions,
  STOP_PERSIST_WORKER_TIMEOUT_MS,
  persistSentinels,
  readClosingMessageFromTranscript,
} from "./sentinel-persist.js";
import { scrapeSentinels } from "./sentinel-scrape.js";

const passthroughHandler: HookHandler = () => passthrough();

/**
 * Resolve the live session id + current (max) turn from the on-disk named-event
 * stream. The most recently appended event names the active session; the
 * current turn is the largest turn index seen for that session. Returns null
 * when there are no events yet (nothing to summarise).
 */
export function resolveCurrentSessionTurn(
  unerrDir: string
): { sessionId: string; currentTurn: number } | null {
  const events = readNamedEvents(unerrDir, {});
  if (events.length === 0) return null;

  // Append order ⇒ the last event belongs to the active session.
  const sessionId = events[events.length - 1]!.session_id;
  if (!sessionId) return null;

  let currentTurn = 0;
  for (const ev of events) {
    if (ev.session_id === sessionId && ev.turn > currentTurn) {
      currentTurn = ev.turn;
    }
  }
  return { sessionId, currentTurn };
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

    // argv[1] is dist/cli.js (the unerr entrypoint this hook is running as).
    const cliPath = process.argv[1];
    if (!cliPath) return false;
    const child = spawn(
      process.execPath,
      [cliPath, "hook", "stop-persist", "--transcript", transcriptPath],
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
 * Stop hook entry. Scrapes + persists any `unerr-save:` sentinels from the
 * closing message, then computes the close-out line for the active session/turn
 * and returns it as a user-facing systemMessage. On any error — or when there's
 * nothing worth surfacing — returns "{}" so the agent never sees a malformed
 * hook response.
 */
export async function runStopHookHandlerAsync(
  stdinJson: string
): Promise<string> {
  try {
    // Write-capture (T7.9) is handed to a detached worker — the economy line
    // renders immediately instead of waiting on sequential UDS writes.
    spawnStopPersistWorker(stdinJson);

    const unerrDir = join(process.cwd(), ".unerr");
    const resolved = resolveCurrentSessionTurn(unerrDir);
    if (!resolved)
      return runStopHookAsync(stdinJson, async () => passthrough());

    const line = renderStopReportLive(
      unerrDir,
      resolved.sessionId,
      resolved.currentTurn
    );
    if (!line || line.trim().length === 0) {
      return runStopHookAsync(stdinJson, async () => passthrough());
    }

    return runStopHookAsync(stdinJson, async () => enrich(line));
  } catch {
    return runStopHookAsync(stdinJson, async () =>
      passthroughHandler({} as never)
    );
  }
}
