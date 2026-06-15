/**
 * unerr cloud — the per-session metadata sync stream (C2).
 *
 * One `StreamDrainer` (`"sessions"`) that reads code-free per-session rollups
 * from the per-repo `metrics.db` `session_history` table and pushes them to
 * `POST /ingest/sessions`. That endpoint upserts ONE session object per request
 * (not an array), so each `read()` returns a batch of exactly one row and
 * `push()` forwards `rows[0]` to `ctx.client.ingestSession`. The cursor tracks
 * `lastId` = the table's AUTOINCREMENT `id`; the SELECT reads the next row past
 * it (`WHERE id > ? ORDER BY id ASC LIMIT 1`).
 *
 * HR-2: only the declared totals/counts columns reach the wire — no file,
 * entity, or prose column is read. The upsert key is `session_id`, so no
 * client-side id is needed.
 *
 * See `unerr-web-service/docs/CLI_API.md` (ingest/sessions) for the wire shape.
 */

import type Database from "better-sqlite3";
import type { BatchAck, CloudResult } from "../client.js";
import type { CursorPos } from "../push-cursor.js";
import type {
  DrainerContext,
  StreamBatch,
  StreamDrainer,
} from "../push-drainer.js";

/**
 * Coerce a `session_history` started_at/ended_at value into ISO-8601. The proxy
 * writes these as ISO strings already (`new Date(...).toISOString()`), but a
 * numeric epoch-ms is also accepted so a future writer shift does not corrupt
 * the wire.
 */
function toIso(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

/** Positive integer or undefined — drops zero/negative/non-numeric counts. */
function intOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/** A non-empty string or undefined. */
function strOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Build the single `sessions` drainer for one repo. Opens `metrics.db` READONLY
 * once; `dispose` closes it. Returns no drainer if the DB does not exist yet
 * (the repo has produced no session telemetry).
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildSessionsDrainers(
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

  const select = db.prepare(
    "SELECT * FROM session_history WHERE id > ? ORDER BY id ASC LIMIT 1"
  );

  const drainer: StreamDrainer = {
    key: "sessions",
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const lastId = from.lastId ?? 0;
      const row = select.get(lastId) as Record<string, unknown> | undefined;
      if (!row) return null;

      const startedAt = toIso(row.started_at);
      if (!startedAt) {
        // started_at is required by the wire; skip a corrupt row by advancing
        // the cursor past it rather than stalling the whole stream.
        return { rows: [], next: { lastId: Number(row.id) } };
      }

      const session: Record<string, unknown> = {
        session_id: row.session_id,
        repo: ctx.repoId,
        source: ctx.source,
        started_at: startedAt,
      };
      const agent = strOrUndefined(row.agent_name);
      if (agent !== undefined) session.agent = agent;
      const modelId = strOrUndefined(row.model_id);
      if (modelId !== undefined) session.model_id = modelId;
      const endedAt = toIso(row.ended_at);
      if (endedAt !== undefined) session.ended_at = endedAt;
      const toolCalls = intOrUndefined(row.tool_calls);
      if (toolCalls !== undefined) session.tool_calls = toolCalls;
      const tokensSaved = intOrUndefined(row.tokens_saved);
      if (tokensSaved !== undefined) session.tokens_saved = tokensSaved;
      // metrics.db has no tokens_in / tokens_out columns; only tokens_processed
      // exists and the wire has no matching field — so it is intentionally
      // omitted (no lossy remap to tokens_in/out).

      return { rows: [session], next: { lastId: Number(row.id) } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.ingestSession(rows[0]);
    },
  };

  return { drainers: [drainer], dispose: () => db.close() };
}
