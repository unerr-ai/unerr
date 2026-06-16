/**
 * unerr cloud — the router-telemetry trace stream (C1).
 *
 * One `StreamDrainer` that reads the append-only `router/metrics.jsonl`
 * (one model/tool-routing decision per line) and pushes short routing labels to
 * `POST /ingest/router`. The cursor is a line index (`lastIndex`). The file
 * ROTATES daily (RouterTelemetryRecorder.rotate), so a shrink below the cursor
 * means the file rolled — the cursor resets to 0 and re-drains. Router rows have
 * no stable id, so `event_id` is derived from enough row fields PLUS the
 * absolute line index to be both unique and deterministic on a re-drain.
 *
 * See `unerr-web-service/docs/CLI_API.md` (ingest/router) for the wire shape.
 */

import {
  RouterRecord,
  TRACE_MAX_ROUTER_PER_BATCH,
} from "@unerr-ai/contracts/traces";
import type { RouterTelemetryRecord } from "../../proxy/router-telemetry.js";
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

/** Endpoint cap — sourced from the contract (`TRACE_MAX_ROUTER_PER_BATCH`). */
const ROUTER_BATCH_CAP = TRACE_MAX_ROUTER_PER_BATCH;

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

/**
 * Build the single router drainer for one repo. The file is re-read each tick;
 * the cursor slices from the last consumed line index and resets to 0 on a
 * daily rotation (file shrank below the cursor).
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildRouterDrainers(
  ctx: DrainerContext
): Promise<{ drainers: StreamDrainer[]; dispose?: () => void }> {
  const { join } = await import("node:path");
  const path = join(ctx.unerrDir, "router", "metrics.jsonl");

  const drainer: StreamDrainer = {
    key: "router",
    schema: RouterRecord,
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const lines = await readJsonlLines(path);
      let start = from.lastIndex ?? 0;
      // File shrank below the cursor → daily rotation rolled it; re-drain.
      if (start > lines.length) start = 0;
      const pending = lines.slice(start);
      if (pending.length === 0) return null;

      const mapped: Array<{ row: unknown; lineCount: number }> = [];
      let skippedLeading = 0;
      let absIndex = start;
      for (const line of pending) {
        const lineAbsIndex = absIndex;
        absIndex += 1;
        let rec: RouterTelemetryRecord;
        try {
          rec = JSON.parse(line) as RouterTelemetryRecord;
        } catch {
          const prev = mapped[mapped.length - 1];
          if (prev === undefined) skippedLeading += 1;
          else prev.lineCount += 1;
          continue;
        }
        mapped.push({
          lineCount: 1 + (mapped.length === 0 ? skippedLeading : 0),
          row: {
            ...buildEnvelope({
              schemaVersion: TRACE_SCHEMA_VERSION,
              repo: ctx.repoId,
              eventId: deterministicId(
                ctx.repoId,
                "router",
                String(rec.ts),
                String(rec.sessionId ?? ""),
                String(rec.toolName ?? ""),
                String(lineAbsIndex)
              ),
              ts: rec.ts,
              source: ctx.source,
              sessionId: rec.sessionId,
              detail: {},
            }),
            policy:
              typeof rec.wasMaskedReason === "string"
                ? rec.wasMaskedReason.slice(0, 64)
                : undefined,
            reason:
              typeof rec.outcome === "string"
                ? rec.outcome.slice(0, 128)
                : undefined,
            score: undefined,
          },
        });
      }
      if (mapped.length === 0) {
        // Only corrupt lines pending — see ledger.ts for why null is correct.
        return null;
      }

      const fitted = fitBatch(mapped, ROUTER_BATCH_CAP);
      const rows = fitted.map((m) => m.row);
      const consumedLines = fitted.reduce((n, m) => n + m.lineCount, 0);
      return { rows, next: { lastIndex: start + consumedLines } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.ingestRouter(rows);
    },
  };

  return { drainers: [drainer] };
}
