/**
 * unerr cloud — the review_finding events stream (P9,
 * .internal/reviewer-architecture.md §16.6.2).
 *
 * One `StreamDrainer` that reads the local findings store
 * (`.unerr/state/review-findings.json`, written by `src/review/findings-store.ts`)
 * and pushes each finding as a `review_finding` ingest event to
 * `POST /ingest/events`. The cloud upserts it by `finding_key` into its mutable
 * `review_findings` table (lifecycle store) AND lands the analytics row in
 * ClickHouse. Telemetry pushes on ALL plans (free included) — the push itself is
 * never gated; `canPushTelemetry` (the `cloud_ingest: false` force-disable) is
 * the only suppression, applied centrally by `drainStream`.
 *
 * Incremental by the `updatedAt` watermark (the store has no rowid): the cursor
 * holds the highest `updatedAt` epoch-ms drained, and each tick reads findings
 * updated strictly after it. A re-surfaced / resolved / dismissed finding bumps
 * `updatedAt`, so its state change re-drains. `event_id` is keyed on
 * (finding_key, state) so a finding re-pushed in the same state dedups, while a
 * state transition pushes a fresh event.
 *
 * HR-2: the wire carries the firewall-safe names `target_file` / `entity_id`
 * (NOT `file_path` / `entity_key`, which are denylisted), descriptive evidence
 * lines only (never source), and `sanitizeDetail` is the second line of defense.
 *
 * @sem domain=cloud role=drainer
 */

import {
  INGEST_MAX_EVENTS_PER_BATCH,
  IngestEvent,
} from "@unerr-ai/contracts/events";
import { isReviewEnabled } from "../../review/feature-flag.js";
import type { StoredFinding } from "../../review/findings-store.js";
import type { BatchAck, CloudResult } from "../client.js";
import { deterministicId } from "../event-id.js";
import type { CursorPos } from "../push-cursor.js";
import {
  type DrainerContext,
  type DrainerSet,
  type StreamBatch,
  type StreamDrainer,
  fitBatch,
} from "../push-drainer.js";
import { EVENTS_SCHEMA_VERSION, buildEnvelope } from "./envelope.js";

/** Endpoint cap — sourced from the contract (`INGEST_MAX_EVENTS_PER_BATCH`). */
const EVENTS_BATCH_CAP = INGEST_MAX_EVENTS_PER_BATCH;

/** The findings store file, relative to a repo's `.unerr` dir. */
const FINDINGS_FILE = "state/review-findings.json";

/**
 * Build the `review_finding` detail tail from one stored finding. Only the
 * firewall-safe, descriptive fields reach the wire; `evidence`/`target_file` are
 * not denylisted (and `sanitizeDetail` clips them), `entity_id` is already the
 * opaque hashed id from the store. Undefined-valued keys are omitted so the tail
 * stays compact.
 */
function findingDetail(f: StoredFinding): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    finding_key: f.findingKey,
    checker_id: f.checkerId,
    tier: f.tier,
    kind: f.kind,
    severity: f.severity,
    title: f.title,
    action: f.action,
    state: f.state,
  };
  if (f.evidence.length > 0) detail.evidence = f.evidence;
  if (f.targetFile !== undefined) detail.target_file = f.targetFile;
  if (f.startLine !== undefined) detail.start_line = f.startLine;
  if (f.entityId !== undefined) detail.entity_id = f.entityId;
  if (f.commitRef !== undefined) detail.commit_ref = f.commitRef;
  if (f.branch !== undefined) detail.branch = f.branch;
  if (f.tokensPrevented !== undefined)
    detail.tokens_prevented = f.tokensPrevented;
  return detail;
}

/**
 * Build the review_finding drainer for one repo. Reads the findings store JSON
 * (no DB handle to open, nothing to dispose) and drains findings updated after
 * the cursor. Returns no drainer when the store does not exist yet (the repo has
 * produced no review findings).
 *
 * @sem domain=cloud role=drainer
 */
export async function buildReviewDrainers(
  ctx: DrainerContext
): Promise<DrainerSet> {
  const { join, dirname } = await import("node:path");
  const { existsSync, readFileSync } = await import("node:fs");
  // Master switch (OFF by default while benchmarked): no drainer means review
  // findings are never pushed to the cloud. ctx.unerrDir is `<root>/.unerr`, so
  // its parent is the repo root the flag's config lookup keys on.
  if (!isReviewEnabled(dirname(ctx.unerrDir))) return { drainers: [] };
  const storePath = join(ctx.unerrDir, FINDINGS_FILE);
  if (!existsSync(storePath)) return { drainers: [] };

  /** Read + parse the store fresh each tick (it is rewritten by review passes). */
  const readFindings = (): StoredFinding[] => {
    try {
      const parsed = JSON.parse(readFileSync(storePath, "utf-8"));
      const findings = parsed?.findings;
      if (!findings || typeof findings !== "object") return [];
      return Object.values(findings) as StoredFinding[];
    } catch {
      // Corrupt / mid-write store → nothing this tick; retry next.
      return [];
    }
  };

  const drainer: StreamDrainer = {
    key: "events:review_finding",
    schema: IngestEvent,
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const since = from.lastId ?? 0;
      const pending = readFindings()
        .map((f) => ({ f, ts: Date.parse(f.updatedAt) }))
        .filter(({ ts }) => Number.isFinite(ts) && ts > since)
        .sort((a, b) => a.ts - b.ts);
      if (pending.length === 0) return null;

      const fitted = fitBatch(pending, EVENTS_BATCH_CAP);
      const last = fitted[fitted.length - 1];
      if (last === undefined) return null;

      const rows = fitted.map(({ f }) => ({
        type: "review_finding",
        ...buildEnvelope({
          schemaVersion: EVENTS_SCHEMA_VERSION,
          repo: ctx.repoId,
          // Key on (finding_key, state) so a re-push in the same state dedups,
          // but a lifecycle transition (open→resolved/dismissed) is a new event.
          eventId: deterministicId(
            ctx.repoId,
            "review_finding",
            `${f.findingKey}:${f.state}`
          ),
          ts: f.updatedAt,
          source: ctx.source,
          detail: findingDetail(f),
        }),
      }));

      const maxTs = fitted
        .map(({ ts }) => ts)
        .reduce((a, b) => Math.max(a, b), since);
      return { rows, next: { lastId: maxTs } };
    },
    push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.ingestEvents(rows);
    },
  };

  return { drainers: [drainer] };
}
