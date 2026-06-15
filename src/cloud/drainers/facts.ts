/**
 * unerr cloud — the memory-facts sync stream (C2).
 *
 * One `StreamDrainer` (`"facts"`) that reads the developer's ACTIVE memory
 * notes from the per-repo `facts.db` `notes` relation and pushes them to
 * `POST /sync/facts` via `ctx.client.syncFacts` (cap 500/push). The cursor
 * tracks `lastId` = the max `last_seen_at` (epoch-ms) watermark drained.
 *
 * HR-2: a note's prose (`content`) IS allowed to leave the machine — it is the
 * developer's own words, not source code — but is capped at 2 KB. The note
 * anchor (`anchor_type:anchor_value`, e.g. `f:src/a.ts`) is the note's address,
 * not file contents; the contract permits it. The dedup/upsert key is a
 * deterministic UUID over (repoId, "facts", note_id) so a redrain dedups.
 *
 * See `unerr-web-service/docs/CLI_API.md` (sync/facts) for the wire shape.
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

/** Endpoint cap: at most 500 facts per push. */
const FACTS_BATCH_CAP = 500;

/** Coerce an epoch-ms Float into ISO-8601, or undefined when not finite. */
function toIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

/**
 * Build the single `facts` drainer for one repo. Opens a read-only second
 * connection to `facts.db` once (WAL-safe); `dispose` closes it. Returns no
 * drainer if the DB does not exist yet.
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildFactsDrainers(
  ctx: DrainerContext
): Promise<{ drainers: StreamDrainer[]; dispose?: () => Promise<void> }> {
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const dbPath = join(ctx.unerrDir, "facts.db");
  if (!existsSync(dbPath)) return { drainers: [] };

  const db: CozoDb = await openCozoRead(dbPath);

  const drainer: StreamDrainer = {
    key: "facts",
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const since = from.lastId ?? 0;
      // Only ACTIVE notes (inactive == false), seen strictly after the
      // watermark, oldest-first so the cursor advances monotonically.
      const result = await db.run(
        `?[note_id, kind, anchor_type, anchor_value, polarity, content, created_at, last_seen_at] :=
           *notes{note_id, kind, anchor_type, anchor_value, polarity, content,
                  created_at, last_seen_at, inactive},
           inactive == false,
           last_seen_at > $since
         :order +last_seen_at
         :limit ${FACTS_BATCH_CAP}`,
        { since }
      );
      const raw = result.rows as unknown[][];
      if (raw.length === 0) return null;

      const mapped = raw.map((r) => {
        const noteId = String(r[0]);
        return {
          client_fact_id: deterministicId(ctx.repoId, "facts", noteId),
          kind: String(r[1]),
          anchor: `${String(r[2])}:${String(r[3])}`,
          polarity: String(r[4]),
          fact_text: String(r[5]).slice(0, 2048),
          repo: ctx.repoId,
          created_at: toIso(r[6]),
          // last_seen_at (r[7]) is the cursor watermark, not a wire field.
          _last_seen_at: typeof r[7] === "number" ? r[7] : since,
        };
      });

      const fitted = fitBatch(mapped, FACTS_BATCH_CAP);
      const maxSeen = fitted.reduce(
        (m, f) => Math.max(m, f._last_seen_at),
        since
      );
      // Strip the internal watermark field before it reaches the wire.
      const rows = fitted.map(({ _last_seen_at, ...wire }) => wire);
      return { rows, next: { lastId: maxSeen } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.syncFacts(rows);
    },
  };

  return {
    drainers: [drainer],
    dispose: async () => {
      db.close?.();
    },
  };
}
