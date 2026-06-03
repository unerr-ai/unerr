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
import { renderStopReportLive } from "../proxy/turn-footer.js";
import { readNamedEvents } from "../tracking/named-events.js";
import {
  type HookHandler,
  enrich,
  passthrough,
  runStopHookAsync,
} from "./hook-runner.js";
import {
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
 * T7.9 — scrape `unerr-save:` sentinels from the agent's closing message and
 * persist them fire-and-forget. The transcript path rides the Stop stdin
 * payload (Claude Code); other agents omit it and this is a no-op. Awaited so
 * the UDS writes flush before the short-lived hook subprocess exits; time-boxed
 * per save so it can't stall. Never throws — a failed scrape never blocks the
 * economy line.
 */
async function scrapeAndPersistSaves(stdinJson: string): Promise<number> {
  try {
    const raw = JSON.parse(stdinJson) as { transcript_path?: unknown };
    const transcriptPath =
      typeof raw.transcript_path === "string" ? raw.transcript_path : undefined;
    const closing = readClosingMessageFromTranscript(transcriptPath);
    if (!closing) return 0;
    const saves = scrapeSentinels(closing);
    if (saves.length === 0) return 0;
    return await persistSentinels(saves);
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
    // Write-capture (T7.9) runs first + awaited, so saves flush before exit.
    await scrapeAndPersistSaves(stdinJson);

    const unerrDir = join(process.cwd(), ".unerr");
    const resolved = resolveCurrentSessionTurn(unerrDir);
    if (!resolved) return runStopHookAsync(stdinJson, async () => passthrough());

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
