/**
 * unerr cloud — the repo-state / drift sync stream (C2).
 *
 * One `StreamDrainer` (`"state:drift"`) that reports repo DRIFT to
 * `POST /sync/state` via `ctx.client.syncState(repoId, state, drift)`
 * (cap 5000/push).
 *
 * state[] IS INTENTIONALLY EMPTY for now. The `state[]` half carries per-file
 * content hashes + co-change membership (`RepoStateRecord`), which needs a
 * local content-hash source the CLI does not yet produce. When that source
 * lands, populate `state[]` here and pass `repo` to `syncState` (already done).
 * Until then this is a drift-only push, which the contract allows without the
 * `?repo=` requirement.
 *
 * drift[] source: the NOTE-anchor drift in the per-repo `facts.db` `notes`
 * relation. A note whose anchor disappeared has `anchor_missing == true`; that
 * maps to `drift_kind: "anchor_lost"`. The cursor tracks `lastId` = the max
 * `anchor_missing_since` (epoch-ms) watermark drained. The upsert key is a
 * deterministic UUID over (repoId, "drift", note_id, "anchor_lost").
 *
 * HR-2: the drift `anchor` (`anchor_type:anchor_value`) is the note's address,
 * not file contents — the contract permits it. No path or file body is sent.
 *
 * See `unerr-web-service/docs/CLI_API.md` (sync/state) for the wire shape.
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

/** Endpoint cap: at most 5000 drift records per push. */
const STATE_BATCH_CAP = 5000;

/** Coerce an epoch-ms Float into ISO-8601, or undefined when not finite. */
function toIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

/**
 * Build the single `state:drift` drainer for one repo. Opens a read-only second
 * connection to `facts.db` once (WAL-safe); `dispose` closes it. Returns no
 * drainer if the DB does not exist yet.
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildStateDrainers(
  ctx: DrainerContext
): Promise<{ drainers: StreamDrainer[]; dispose?: () => Promise<void> }> {
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const dbPath = join(ctx.unerrDir, "facts.db");
  if (!existsSync(dbPath)) return { drainers: [] };

  const db: CozoDb = await openCozoRead(dbPath);

  const drainer: StreamDrainer = {
    key: "state:drift",
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const since = from.lastId ?? 0;
      // Notes whose anchor disappeared (anchor_missing == true), past the
      // watermark, oldest-first. `detected_at` = anchor_missing_since when set,
      // else last_seen_at as a fallback instant.
      const result = await db.run(
        `?[note_id, anchor_type, anchor_value, anchor_missing_since, last_seen_at] :=
           *notes{note_id, anchor_type, anchor_value, anchor_missing,
                  anchor_missing_since, last_seen_at},
           anchor_missing == true,
           anchor_missing_since > $since
         :order +anchor_missing_since
         :limit ${STATE_BATCH_CAP}`,
        { since }
      );
      const raw = result.rows as unknown[][];
      if (raw.length === 0) return null;

      const mapped = raw.map((r) => {
        const noteId = String(r[0]);
        const missingSince = typeof r[3] === "number" ? r[3] : 0;
        const lastSeen = typeof r[4] === "number" ? r[4] : 0;
        const detectedAt =
          toIso(missingSince > 0 ? missingSince : lastSeen) ??
          new Date(0).toISOString();
        return {
          client_drift_id: deterministicId(
            ctx.repoId,
            "drift",
            noteId,
            "anchor_lost"
          ),
          anchor: `${String(r[1])}:${String(r[2])}`,
          drift_kind: "anchor_lost",
          repo: ctx.repoId,
          detected_at: detectedAt,
          _watermark: missingSince > 0 ? missingSince : since,
        };
      });

      const fitted = fitBatch(mapped, STATE_BATCH_CAP);
      const maxWatermark = fitted.reduce(
        (m, f) => Math.max(m, f._watermark),
        since
      );
      const rows = fitted.map(({ _watermark, ...wire }) => wire);
      return { rows, next: { lastId: maxWatermark } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      // state[] stays empty (no local content-hash source yet); drift-only push.
      return ctx.client.syncState(ctx.repoId, [], rows);
    },
  };

  return {
    drainers: [drainer],
    dispose: async () => {
      db.close?.();
    },
  };
}
