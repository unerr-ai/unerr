/**
 * unerr cloud — the ClickHouse events streams (C1).
 *
 * Five `StreamDrainer`s, one per metrics.db table, that read code-free
 * aggregate rows from the per-repo `metrics.db` and push them to
 * `POST /ingest/events`. Each drainer keeps its own cursor (`events:<table>`)
 * and reads incrementally by rowid (or by `written_at` for session summaries,
 * which has no rowid). The metrics.db connection is opened READONLY once in the
 * builder and shared across the five drainers; `dispose` closes it.
 *
 * HR-2: only the declared, code-free columns reach `detail` — path/entity
 * columns (`file`, `entity`, `command`, `tee_file`) are never sent, and the
 * shared `sanitizeDetail` firewall is the second line of defense.
 *
 * C3 edge classification: the `behavior` drainer additionally surfaces the
 * agent-tagged classification fields from a behavior_events row's `detail` JSON
 * (see `classificationDetail` + `C3_DETAIL_KEYS`). The four field groups
 * (`decision_event`, `edit_event`, `task_completion`, `line_survival_rollup`)
 * ride the existing `behavior` event `type` rather than inventing new event
 * types — counts/enums/booleans only, plus the hashed `entity_id`.
 *
 * PRODUCER STATUS (C3): `decision_event` / `edit_event` / `task_completion`
 * have a live local producer — the agent already records behavior_events
 * mid-turn (cascade_guard, caller_check_enforced, …) and tags the detail JSON
 * with these fields. `line_survival_rollup` (authored_by / cohort_days /
 * lines_authored / lines_still_present) needs a periodic git-arithmetic pass
 * (git blame the 30/90-day cohort, count surviving authored lines) that does
 * NOT exist locally yet — only its wire + drainer path is plumbed here. Until a
 * producer writes a behavior_events row carrying those four keys, the rollup
 * stays empty on the dashboard. See C3 in
 * `unerr-web-service/docs/UNERR_CLI_INTEGRATION_PLAN.md`.
 *
 * See `unerr-web-service/docs/CLI_API.md` (ingest/events) for the wire shape.
 */

import type Database from "better-sqlite3";
import type { BatchAck, CloudResult } from "../client.js";
import { deterministicId } from "../event-id.js";
import type { CursorPos } from "../push-cursor.js";
import {
  type DrainerContext,
  type StreamBatch,
  type StreamDrainer,
  fitBatch,
} from "../push-drainer.js";
import {
  EVENTS_SCHEMA_VERSION,
  buildEnvelope,
  hashEntityKey,
} from "./envelope.js";

/** Endpoint cap: at most 100 events per push. */
const EVENTS_BATCH_CAP = 100;

/** Coerce a metrics.db ts_iso/ts pair into an ISO-8601 string for the wire. */
function rowTs(row: { ts_iso?: unknown; ts?: unknown }): string {
  if (typeof row.ts_iso === "string" && row.ts_iso.length > 0)
    return row.ts_iso;
  if (typeof row.ts === "number") return new Date(row.ts).toISOString();
  return new Date().toISOString();
}

/** Drop undefined-valued keys so the detail tail stays compact. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * The C3 edge-classification keys the agent tags onto a behavior_events row's
 * `detail` JSON, grouped by field group. Only these declared keys are copied to
 * the wire — every other key in the local `detail` JSON is dropped here so a
 * future free-form behavior detail can never leak. Each is a count, an enum, or
 * a boolean: all pass the HR-2 firewall unchanged. (`entity_key` is NOT in this
 * list — it is denylisted; the behavior mapper hashes it to `entity_id`.)
 */
const C3_DETAIL_KEYS = [
  // decision_event — "who's steering", "right tool right task"
  "direction", // enum: human | collab | llm
  "task_type", // enum: feature | bugfix | refactor | … (short label)
  "alternatives_count", // int ≥ 0
  "stakes", // enum: low | medium | high
  // edit_event — "code that stuck" inputs
  "agent_authored", // bool
  "lines_added", // int ≥ 0
  "lines_removed", // int ≥ 0
  "reviewed_before_apply", // bool
  // task_completion — "iterations to done"
  "iterations", // int ≥ 0
  "outcome", // enum: merged | abandoned | reverted
  "accepted_without_edit", // bool
  // line_survival_rollup — "code that stuck"
  "authored_by", // enum: ai | human
  "cohort_days", // int: 30 | 90
  "lines_authored", // int ≥ 0
  "lines_still_present", // int ≥ 0
] as const;

/**
 * Project the C3 classification fields out of a behavior_events row's parsed
 * `detail` JSON. Copies ONLY the declared {@link C3_DETAIL_KEYS} (allow-list,
 * not pass-through) so an unrelated free-form behavior detail never rides along.
 * Returns the picked fields plus a hashed `entity_id` (the opaque, firewall-safe
 * stand-in for the row's denylisted `entity_key`). Empty when the row carried no
 * C3 detail — the behavior mapper then emits only its base fields.
 *
 * // @sem domain=cloud role=drainer
 */
function classificationDetail(
  row: Record<string, unknown>
): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};
  if (typeof row.detail === "string" && row.detail.length > 0) {
    try {
      const j = JSON.parse(row.detail) as unknown;
      if (j !== null && typeof j === "object" && !Array.isArray(j))
        parsed = j as Record<string, unknown>;
    } catch {
      // corrupt detail JSON — emit only the base behavior fields.
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of C3_DETAIL_KEYS) {
    const v = parsed[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  // Hash the denylisted entity_key into an opaque, group-stable id.
  const entityId = hashEntityKey(
    typeof row.entity_key === "string" ? row.entity_key : null
  );
  if (entityId !== undefined) out.entity_id = entityId;
  return out;
}

interface RowidTable {
  /** Wire `type` for every row in this table. */
  type: string;
  /** Cursor key, e.g. `"events:token_flow"`. */
  key: string;
  /** metrics.db table name. */
  table: string;
  /** Maps one SQLite row → the `detail` tail (required fields enforced here). */
  detail(row: Record<string, unknown>): Record<string, unknown>;
}

/** The four rowid-incremental tables (read `WHERE id > ? ORDER BY id ASC`). */
const ROWID_TABLES: RowidTable[] = [
  {
    type: "token_flow",
    key: "events:token_flow",
    table: "token_flow_events",
    detail: (r) =>
      compact({
        mechanism: r.mechanism,
        tool: r.tool,
        tokens_saved: r.tokens_saved,
      }),
  },
  {
    type: "compression",
    key: "events:compression",
    table: "compression_events",
    detail: (r) => {
      const orig =
        typeof r.original_tokens === "number" ? r.original_tokens : undefined;
      const deliv =
        typeof r.delivered_tokens === "number" ? r.delivered_tokens : undefined;
      const tokensSaved =
        orig !== undefined && deliv !== undefined ? orig - deliv : undefined;
      return compact({
        category: r.category,
        mechanism: r.mechanism,
        raw_bytes: r.raw_bytes,
        compressed_bytes: r.compressed_bytes,
        saved_pct: r.saved_pct,
        cache_hit:
          typeof r.cache_hit === "number" ? r.cache_hit === 1 : undefined,
        tokens_saved: tokensSaved,
      });
    },
  },
  {
    type: "behavior",
    key: "events:behavior",
    table: "behavior_events",
    // Base behavior fields + the C3 edge-classification tail when the agent
    // tagged this row's detail JSON. `entity_key` is hashed → `entity_id`
    // inside classificationDetail; the raw key never reaches the wire.
    detail: (r) =>
      compact({
        kind: r.type,
        tool: r.tool,
        response_bytes: r.response_bytes,
        ...classificationDetail(r),
      }),
  },
  {
    type: "file_read",
    key: "events:file_read",
    table: "file_read_events",
    // NEVER send `file` / `entity` columns — they are paths (denylisted).
    detail: (r) =>
      compact({
        mode: r.mode,
        total_lines: r.total_lines,
        returned_lines: r.returned_lines,
        saved_pct: r.saved_pct,
        token_estimate: r.token_estimate,
      }),
  },
];

/**
 * A rowid-incremental drainer: reads up to 100 rows past `from.lastId` and maps
 * each to a wire envelope. Cursor advances to the max rowid pushed.
 */
function makeRowidDrainer(
  ctx: DrainerContext,
  db: Database.Database,
  spec: RowidTable
): StreamDrainer {
  const select = db.prepare(
    `SELECT * FROM ${spec.table} WHERE id > ? ORDER BY id ASC LIMIT ${EVENTS_BATCH_CAP}`
  );
  return {
    key: spec.key,
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const lastId = from.lastId ?? 0;
      const raw = select.all(lastId) as Array<Record<string, unknown>>;
      if (raw.length === 0) return null;
      const fitted = fitBatch(raw, EVENTS_BATCH_CAP);
      const lastRow = fitted[fitted.length - 1];
      if (lastRow === undefined) return null;
      const rows = fitted.map((r) => ({
        type: spec.type,
        ...buildEnvelope({
          schemaVersion: EVENTS_SCHEMA_VERSION,
          repo: ctx.repoId,
          agent: typeof r.agent === "string" ? r.agent : undefined,
          eventId: deterministicId(ctx.repoId, spec.table, String(r.id)),
          ts: rowTs(r),
          source: ctx.source,
          sessionId:
            typeof r.session_id === "string" ? r.session_id : undefined,
          turn: typeof r.turn === "number" ? r.turn : undefined,
          detail: spec.detail(r),
        }),
      }));
      const maxId = Number(lastRow.id);
      return { rows, next: { lastId: maxId } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.ingestEvents(rows);
    },
  };
}

/**
 * The session-summary drainer. `session_summaries` has no AUTOINCREMENT rowid;
 * its monotonic key is the ISO `written_at` column. The cursor stores that
 * instant as epoch-ms in `lastId`; the SELECT compares the ISO form (ISO-8601
 * sorts lexically = chronologically). `event_id` is keyed on `session_id` so a
 * re-drain of the same summary dedups.
 */
function makeSessionSummaryDrainer(
  ctx: DrainerContext,
  db: Database.Database
): StreamDrainer {
  const select = db.prepare(
    `SELECT * FROM session_summaries WHERE written_at > ? ORDER BY written_at ASC LIMIT ${EVENTS_BATCH_CAP}`
  );
  return {
    key: "events:session_summary",
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const sinceIso =
        from.lastId !== undefined ? new Date(from.lastId).toISOString() : "";
      const raw = select.all(sinceIso) as Array<Record<string, unknown>>;
      if (raw.length === 0) return null;
      const fitted = fitBatch(raw, EVENTS_BATCH_CAP);
      const rows = fitted.map((r) => {
        // NOTE: session_summaries has no tokens_saved / model_id columns
        // (see metrics-store.ts SCHEMA). Only the present columns are mapped;
        // token_estimate → tokens_processed.
        const detail = compact({
          duration_ms: r.duration_ms,
          tool_calls: r.tool_calls,
          tokens_processed: r.token_estimate,
        });
        return {
          type: "session_summary",
          ...buildEnvelope({
            schemaVersion: EVENTS_SCHEMA_VERSION,
            repo: ctx.repoId,
            eventId: deterministicId(
              ctx.repoId,
              "session_summaries",
              String(r.session_id)
            ),
            ts: rowTs(
              // session_summaries has no ts_iso/ts — use written_at.
              { ts_iso: r.written_at as string }
            ),
            source: ctx.source,
            sessionId:
              typeof r.session_id === "string" ? r.session_id : undefined,
            detail,
          }),
        };
      });
      const maxWritten = fitted
        .map((r) => Date.parse(String(r.written_at)))
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => Math.max(a, b), from.lastId ?? 0);
      return { rows, next: { lastId: maxWritten } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.ingestEvents(rows);
    },
  };
}

/**
 * Build the five events drainers for one repo. Opens `metrics.db` READONLY once
 * and shares the connection; `dispose` closes it. If the DB does not exist yet
 * (the repo has produced no telemetry), returns no drainers.
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildEventsDrainers(
  ctx: DrainerContext
): Promise<{ drainers: StreamDrainer[]; dispose?: () => void }> {
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const dbPath = join(ctx.unerrDir, "metrics.db");
  if (!existsSync(dbPath)) return { drainers: [] };

  const DatabaseCtor = (await import("better-sqlite3")).default;
  const db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });

  const drainers: StreamDrainer[] = [
    ...ROWID_TABLES.map((spec) => makeRowidDrainer(ctx, db, spec)),
    makeSessionSummaryDrainer(ctx, db),
  ];

  return {
    drainers,
    dispose: () => db.close(),
  };
}
