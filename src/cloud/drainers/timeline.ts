/**
 * unerr cloud — the timeline sync streams (C2).
 *
 * Two `StreamDrainer`s that read turn boundaries and session markers from the
 * per-repo `timeline.db` and push them to `POST /sync/timeline` via
 * `ctx.client.syncTimeline` (cap 500/push each):
 *
 *   - `"timeline:turns"`   ← the `turns` relation,   cursor = max started_at.
 *   - `"timeline:markers"` ← the `markers` relation, cursor = max ts.
 *
 * Each row's upsert key is a deterministic UUID over (repoId, "timeline",
 * <row id>) so a redrain dedups. HR-2: a marker's `file_path` is a path and is
 * NEVER sent (omitted). A marker's `text` is the developer's own prose and is
 * allowed, capped at 2 KB (`note_text`) / 256 chars (`label`).
 *
 * The `intents` relation is intentionally NOT drained here: an intent is
 * cross-session (no single `session_id`), and the wire `timeline[]` record
 * requires one. Intents await a separate mapping.
 *
 * See `unerr-web-service/docs/CLI_API.md` (sync/timeline) for the wire shape.
 */

import type { CozoDb } from "../../intelligence/cozo-schema.js";
import type { BatchAck, CloudResult } from "../client.js";
import { deterministicId } from "../event-id.js";
import type { CursorPos } from "../push-cursor.js";
import {
  type DrainerContext,
  type StreamBatch,
  type StreamDrainer,
  fitBatch,
} from "../push-drainer.js";
import { openCozoRead } from "./cozo-read.js";

/** Endpoint cap: at most 500 timeline entries per push. */
const TIMELINE_BATCH_CAP = 500;

/** Coerce an epoch-ms Float into ISO-8601, or undefined when not finite. */
function toIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

/** Map a marker `type` to the wire `kind` enum. */
function markerKind(
  type: string
): "blocker" | "intent" | "decision" | "marker" {
  switch (type) {
    case "mark_blocker":
      return "blocker";
    case "mark_intent":
      return "intent";
    case "mark_decision":
      return "decision";
    default:
      return "marker";
  }
}

/** The `turns` drainer — one wire `turn` entry per closed turn. */
function makeTurnsDrainer(ctx: DrainerContext, db: CozoDb): StreamDrainer {
  return {
    key: "timeline:turns",
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const since = from.lastId ?? 0;
      const result = await db.run(
        `?[turn_id, session_id, started_at, title, tool_count, file_count] :=
           *turns{turn_id, session_id, started_at, title, tool_count, file_count},
           started_at > $since
         :order +started_at
         :limit ${TIMELINE_BATCH_CAP}`,
        { since }
      );
      const raw = result.rows as unknown[][];
      if (raw.length === 0) return null;

      const mapped = raw.map((r) => {
        const startedAt = typeof r[2] === "number" ? r[2] : since;
        return {
          client_entry_id: deterministicId(
            ctx.repoId,
            "timeline",
            String(r[0])
          ),
          session_id: String(r[1]),
          kind: "turn",
          label: (typeof r[3] === "string" && r[3].length > 0
            ? r[3]
            : "turn"
          ).slice(0, 256),
          repo: ctx.repoId,
          ts: toIso(startedAt),
          _started_at: startedAt,
        };
      });

      const fitted = fitBatch(mapped, TIMELINE_BATCH_CAP);
      const maxTs = fitted.reduce((m, f) => Math.max(m, f._started_at), since);
      const rows = fitted.map(({ _started_at, ...wire }) => wire);
      return { rows, next: { lastId: maxTs } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.syncTimeline(rows);
    },
  };
}

/** The `markers` drainer — one wire entry per intent/decision/blocker/marker. */
function makeMarkersDrainer(ctx: DrainerContext, db: CozoDb): StreamDrainer {
  return {
    key: "timeline:markers",
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const since = from.lastId ?? 0;
      const result = await db.run(
        `?[marker_id, type, text, session_id, ts] :=
           *markers{marker_id, type, text, session_id, ts},
           ts > $since
         :order +ts
         :limit ${TIMELINE_BATCH_CAP}`,
        { since }
      );
      const raw = result.rows as unknown[][];
      if (raw.length === 0) return null;

      const mapped = raw.map((r) => {
        const ts = typeof r[4] === "number" ? r[4] : since;
        const text = String(r[2]);
        // NOTE: markers.file_path is a path — NEVER read or sent (omitted).
        return {
          client_entry_id: deterministicId(
            ctx.repoId,
            "timeline",
            String(r[0])
          ),
          session_id: String(r[3]),
          kind: markerKind(String(r[1])),
          label: text.slice(0, 256),
          note_text: text.slice(0, 2048),
          repo: ctx.repoId,
          ts: toIso(ts),
          _ts: ts,
        };
      });

      const fitted = fitBatch(mapped, TIMELINE_BATCH_CAP);
      const maxTs = fitted.reduce((m, f) => Math.max(m, f._ts), since);
      const rows = fitted.map(({ _ts, ...wire }) => wire);
      return { rows, next: { lastId: maxTs } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.syncTimeline(rows);
    },
  };
}

/**
 * Build the two timeline drainers for one repo. Opens a read-only second
 * connection to `timeline.db` once (WAL-safe); `dispose` closes it. Returns no
 * drainers if the DB does not exist yet.
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildTimelineDrainers(
  ctx: DrainerContext
): Promise<{ drainers: StreamDrainer[]; dispose?: () => Promise<void> }> {
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const dbPath = join(ctx.unerrDir, "timeline.db");
  if (!existsSync(dbPath)) return { drainers: [] };

  const db: CozoDb = await openCozoRead(dbPath);

  const drainers: StreamDrainer[] = [
    makeTurnsDrainer(ctx, db),
    makeMarkersDrainer(ctx, db),
  ];

  return {
    drainers,
    dispose: async () => {
      db.close?.();
    },
  };
}
