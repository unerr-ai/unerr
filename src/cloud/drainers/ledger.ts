/**
 * unerr cloud — the shadow-ledger trace stream (C1).
 *
 * One `StreamDrainer` that reads the append-only `ledger/shadow.jsonl`
 * (one tool call per line, no rotation) and pushes code-free tool-call metadata
 * to `POST /ingest/ledger`. The cursor is a line index (`lastIndex` = lines
 * already consumed); each tick reads the whole file, splits on newlines, and
 * slices from the cursor. If the file shrank below the cursor (truncated), the
 * cursor resets to 0 and re-drains — the deterministic `event_id` lets the
 * server dedup the re-sent rows.
 *
 * HR-2: only the KEY NAMES of `args_summary` leave the machine (as
 * `args_shape`), never the raw arg values. See `CLI_API.md` (ingest/ledger).
 */

import {
  LedgerRecord,
  TRACE_MAX_LEDGER_PER_BATCH,
} from "@unerr-ai/contracts/traces";
import type { LedgerEntry } from "../../tracking/shadow-ledger.js";
import type { BatchAck, CloudResult } from "../client.js";
import { deterministicId } from "../event-id.js";
import type { CursorPos } from "../push-cursor.js";
import {
  type DrainerContext,
  type StreamBatch,
  type StreamDrainer,
  fitBatch,
} from "../push-drainer.js";
import { TRACE_SCHEMA_VERSION, buildEnvelope } from "./envelope.js";

/** Endpoint cap — sourced from the contract (`TRACE_MAX_LEDGER_PER_BATCH`). */
const LEDGER_BATCH_CAP = TRACE_MAX_LEDGER_PER_BATCH;

/** Read every non-empty line of a jsonl file, or `[]` if it doesn't exist. */
async function readJsonlLines(path: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.trim().length > 0);
}

/** Whether a result_summary signals an error outcome. */
function resultStatus(result: Record<string, unknown> | undefined): string {
  if (result && Object.prototype.hasOwnProperty.call(result, "error"))
    return "error";
  return "ok";
}

/**
 * Build the single ledger drainer for one repo. The file is re-read each tick
 * (it is append-only and small relative to a turn); the cursor slices from the
 * last consumed line index.
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildLedgerDrainers(
  ctx: DrainerContext
): Promise<{ drainers: StreamDrainer[]; dispose?: () => void }> {
  const { join } = await import("node:path");
  const path = join(ctx.unerrDir, "ledger", "shadow.jsonl");

  const drainer: StreamDrainer = {
    key: "ledger",
    schema: LedgerRecord,
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const lines = await readJsonlLines(path);
      let start = from.lastIndex ?? 0;
      // File shrank below the cursor (truncated/rotated) → reset and re-drain.
      if (start > lines.length) start = 0;
      const pending = lines.slice(start);
      if (pending.length === 0) return null;

      // Map each pending line to a wire row, tracking how many source lines
      // each mapped row consumed (a corrupt line maps to no row but is still
      // consumed, so the cursor never stalls on bad input).
      const mapped: Array<{ row: unknown; lineCount: number }> = [];
      let skippedLeading = 0;
      for (const line of pending) {
        let entry: LedgerEntry;
        try {
          entry = JSON.parse(line) as LedgerEntry;
        } catch {
          const prev = mapped[mapped.length - 1];
          if (prev === undefined) skippedLeading += 1;
          else prev.lineCount += 1;
          continue;
        }
        const argsSummary = entry.args_summary ?? {};
        const argsShape = Object.keys(argsSummary).join(",").slice(0, 256);
        mapped.push({
          lineCount: 1 + (mapped.length === 0 ? skippedLeading : 0),
          row: {
            ...buildEnvelope({
              schemaVersion: TRACE_SCHEMA_VERSION,
              repo: ctx.repoId,
              eventId: deterministicId(ctx.repoId, "ledger", String(entry.id)),
              ts: entry.ts,
              source: ctx.source,
              sessionId: entry.session_id,
              detail: {},
            }),
            tool: entry.tool,
            args_shape: argsShape,
            result_status: resultStatus(entry.result_summary),
          },
        });
      }
      if (mapped.length === 0) {
        // Only corrupt lines pending. `drainStream` treats an empty-rows batch
        // as "nothing left" and does NOT advance the cursor, so returning a
        // cursor here would not stick — return null and let these (rare,
        // self-written) lines be re-scanned next tick; they parse-fail fast.
        return null;
      }

      // Fit AFTER mapping so the byte budget reflects the wire rows. The cursor
      // advances by the source lines that produced the fitted rows.
      const fitted = fitBatch(mapped, LEDGER_BATCH_CAP);
      const rows = fitted.map((m) => m.row);
      const consumedLines = fitted.reduce((n, m) => n + m.lineCount, 0);
      return { rows, next: { lastIndex: start + consumedLines } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.ingestLedger(rows);
    },
  };

  return { drainers: [drainer] };
}
