/**
 * unerr cloud — the transcripts trace stream (C1).
 *
 * The transcripts endpoint (`POST /ingest/transcripts`) carries the turn's
 * code-stripped reasoning prose. The per-turn prose store is the per-repo
 * `metrics.db` `agent_transcripts` table (written by
 * `src/tracking/transcript-materializer.ts`): one row per (session, turn, role)
 * with the turn's `text`. This drainer reads that table cursor-forward by the
 * AUTOINCREMENT `id` (mirroring the `sessions` drainer) and maps each row to a
 * wire record:
 *   {
 *     ...envelope,              // repo, event_id, ts, source, session_id, turn
 *     speaker?,                 // 'agent' | 'user' (mapped from the stored role)
 *     trace_text,               // clipTranscriptText(text): code-stripped, ≤16 KB
 *     tokens_in?,
 *     tokens_out?,
 *   }
 * `trace_text` is a TOP-LEVEL wire field (not in `detail`) so it keeps the full
 * ≤16 KB — `sanitizeDetail` would clip a `detail` string to 512 chars.
 *
 * HR-2: prose leaves the machine; raw code does NOT. `clipTranscriptText` runs
 * `stripCodeFromText` BEFORE the wire — the client strip is the first line of
 * defense, the server stripper the backstop. A turn over 16 KB sends a clipped
 * tail rather than being rejected whole; current local transcripts (~10 K chars)
 * fit untouched, so the clip is a guard, not routine loss (B2-clip).
 *
 * See `unerr-web-service/docs/CLI_API.md` (ingest/transcripts).
 */

import {
  TRACE_MAX_TRACE_TEXT,
  TRACE_MAX_TRANSCRIPTS_PER_BATCH,
  TranscriptRecord,
} from "@unerr-ai/contracts/traces";
import type Database from "better-sqlite3";
import type { BatchAck, CloudResult } from "../client.js";
import { deterministicId } from "../event-id.js";
import type { CursorPos } from "../push-cursor.js";
import type {
  DrainerContext,
  StreamBatch,
  StreamDrainer,
} from "../push-drainer.js";
import { stripCodeFromText } from "../strip-code.js";
import { TRACE_SCHEMA_VERSION, buildEnvelope } from "./envelope.js";

/** Endpoint cap — sourced from the contract (`TRACE_MAX_TRANSCRIPTS_PER_BATCH`). */
export const TRANSCRIPTS_BATCH_CAP = TRACE_MAX_TRANSCRIPTS_PER_BATCH;

/** Max trace_text length on the wire — sourced from the contract (`TRACE_MAX_TRACE_TEXT`, 16 KB). */
export const TRANSCRIPT_TEXT_CAP = TRACE_MAX_TRACE_TEXT;

/**
 * Clip a turn's reasoning prose for the wire: strip embedded code (HR-2) then
 * cap at 16 KB, keeping the LEADING 16 KB. The strip runs first so a code-block
 * collapse never pushes real prose past the cap; clipping after the strip means
 * the 16 KB the server sees is already code-free.
 *
 * // @sem domain=cloud role=drainer
 */
export function clipTranscriptText(text: string): string {
  return stripCodeFromText(text).slice(0, TRANSCRIPT_TEXT_CAP);
}

/**
 * Map a stored transcript `role` (`user` / `assistant` / `system`) to the wire
 * `speaker` enum (`agent` / `user` / `tool`). `assistant` is the agent's own
 * reasoning; `user` passes through; anything else (e.g. `system`) is omitted so
 * no out-of-enum value reaches the wire.
 */
function speakerFromRole(role: unknown): "agent" | "user" | undefined {
  if (role === "assistant") return "agent";
  if (role === "user") return "user";
  return undefined;
}

/** A non-empty string or undefined. */
function strOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A non-negative integer or undefined. */
function intOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

/**
 * Build the single transcripts drainer for one repo. Opens `metrics.db`
 * READONLY once; `dispose` closes it. Returns no drainer when the DB does not
 * exist yet (the repo has produced no transcript telemetry). The cursor tracks
 * `lastId` = the `agent_transcripts` AUTOINCREMENT `id`; each `read()` slices a
 * batch of rows past it.
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildTranscriptDrainers(
  ctx: DrainerContext
): Promise<{ drainers: StreamDrainer[]; dispose?: () => void }> {
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const dbPath = join(ctx.unerrDir, "metrics.db");
  if (!existsSync(dbPath)) return { drainers: [] };

  const DatabaseCtor = (await import("better-sqlite3")).default;
  const db: Database.Database = new DatabaseCtor(dbPath, {
    readonly: true,
    fileMustExist: true,
  });

  // Only rows that carry prose are drainable: the transcripts stream exists to
  // ship `trace_text`. Filtering text-less rows in SQL guarantees every fetched
  // row yields a wire record, so a returned batch is never all-empty — which
  // matters because the drain loop treats an empty-rows batch as "nothing left"
  // and does NOT advance the cursor (it would stall on a run of text-less rows).
  const select = db.prepare(
    "SELECT * FROM agent_transcripts WHERE id > ? AND text IS NOT NULL AND text != '' ORDER BY id ASC LIMIT ?"
  );

  const drainer: StreamDrainer = {
    key: "transcripts",
    schema: TranscriptRecord,
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const lastId = from.lastId ?? 0;
      const dbRows = select.all(lastId, TRANSCRIPTS_BATCH_CAP) as Array<
        Record<string, unknown>
      >;
      if (dbRows.length === 0) return null;

      let maxId = lastId;
      const rows: unknown[] = [];
      for (const r of dbRows) {
        maxId = Math.max(maxId, Number(r.id));

        // Defensive: the SQL filter already excludes null/empty text.
        const text = strOrUndefined(r.text);
        if (text === undefined) continue;

        const sessionId = strOrUndefined(r.session_id);
        const turn =
          typeof r.turn === "number" && Number.isFinite(r.turn)
            ? Math.trunc(r.turn)
            : undefined;
        const record: Record<string, unknown> = {
          ...buildEnvelope({
            schemaVersion: TRACE_SCHEMA_VERSION,
            repo: ctx.repoId,
            eventId: deterministicId(
              ctx.repoId,
              "transcript",
              sessionId ?? "",
              String(turn ?? 0),
              String(r.role ?? "")
            ),
            ts: strOrUndefined(r.ts) ?? new Date().toISOString(),
            source: ctx.source,
            agent: strOrUndefined(r.agent),
            sessionId,
            turn,
            detail: {},
          }),
          // HR-2: strip embedded code, then clip to ≤16 KB, BEFORE the wire.
          trace_text: clipTranscriptText(text),
        };
        const speaker = speakerFromRole(r.role);
        if (speaker !== undefined) record.speaker = speaker;
        const tokensIn = intOrUndefined(r.tokens_input);
        if (tokensIn !== undefined) record.tokens_in = tokensIn;
        const tokensOut = intOrUndefined(r.tokens_output);
        if (tokensOut !== undefined) record.tokens_out = tokensOut;

        rows.push(record);
      }

      // Every fetched row carries text (SQL-filtered), so `rows` is non-empty
      // here; the cursor advances to the highest id in the batch.
      return { rows, next: { lastId: maxId } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.ingestTranscripts(rows);
    },
  };

  return { drainers: [drainer], dispose: () => db.close() };
}
