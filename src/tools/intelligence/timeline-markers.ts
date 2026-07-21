/**
 * Timeline marker MCP tools (ST-2a).
 *
 * Four lightweight tools the agent emits inline as it works. Each call:
 *   1. Appends a regular `LedgerEntry` via `ShadowLedger.record()` with
 *      `tool: "mark_*"` — existing readers see it as a normal MCP call.
 *   2. Mirrors a row into `timeline.db.markers` for indexed lookup
 *      (open-threads, intent rail, future miners).
 *
 * The Layer 9 temporal-fact store was removed in the active-memory strip —
 * this module only writes the ledger + timeline.db and never depended on it.
 *
 * Text cap: all four markers accept ≤ 1400 chars (~2-3 sentences). The cap is
 * a generous storage ceiling, not a style guide — agents should still write
 * terse one-liners; the resume strip and dashboard truncate for display. The
 * old 80/140 caps rejected legitimate multi-sentence resolutions, which forced
 * agents into failed-call retry loops (raised 2026-05).
 */

import { randomUUID } from "node:crypto";
import { emit } from "../../events/enqueue.js";
import {
  parseBatchCallIntent,
  parseBulkEditIntent,
  parseDelegationIntent,
  tierForDelegationClass,
} from "../../intelligence/delegation.js";
import { tokenize } from "../../intelligence/search-index.js";
import { updateNudgeState } from "../../proxy/nudge-state.js";
import type { CozoTimelineStore } from "../../timeline/timeline-store.js";
import type { BehaviorEventInput } from "../../tracking/behavior-events.js";
import {
  emitBatchCallSavings,
  emitBulkEditSavings,
  emitDelegationSavings,
} from "../../tracking/savings-events.js";
import type { ShadowLedger } from "../../tracking/shadow-ledger.js";

export const MARKER_TOOLS = [
  "mark_intent",
  "mark_decision",
  "mark_blocker",
  "mark_resolution",
] as const;

export type MarkerToolName = (typeof MARKER_TOOLS)[number];

const MARKER_TOOL_SET: Set<string> = new Set(MARKER_TOOLS);

export function isMarkerTool(name: string): name is MarkerToolName {
  return MARKER_TOOL_SET.has(name);
}

/**
 * Generous storage ceiling shared by all four markers (~2-3 sentences). Inputs
 * up to this are accepted; render layers (resume strip, dashboard) truncate.
 * Exported so tests and the tool-description registry stay in lockstep.
 */
export const MARKER_TEXT_CAP = 1400;

const TEXT_CAP: Record<MarkerToolName, number> = {
  mark_intent: MARKER_TEXT_CAP,
  mark_decision: MARKER_TEXT_CAP,
  mark_blocker: MARKER_TEXT_CAP,
  mark_resolution: MARKER_TEXT_CAP,
};

export interface HandleMarkerDeps {
  ledger: ShadowLedger;
  store: CozoTimelineStore;
  branch: string;
  headSha: string;
  /**
   * Optional behavior-event writer. When present, a `mark_intent` whose text is a
   * delegation signal (`delegate <class>[ sweep]: …`, emitted by the unerr-delegate
   * skill) records a `delegated_edit` / `delegated_sweep` row — the deterministic
   * Lever C C6 telemetry emit point. Best-effort: a failure never fails the marker.
   */
  behaviorWriter?: { record(input: BehaviorEventInput): void };
}

export interface MarkerCallResult {
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Dispatch a marker tool call. Returns an MCP-shaped response: a success
 * body (`{ok}`, plus `marker_id` for mark_blocker so the agent can pass it
 * as `blocker_ref` to mark_resolution) or an `{error}` body — callers
 * forward this directly back to the agent.
 */
export async function handleMarkerCall(
  toolName: MarkerToolName,
  args: Record<string, unknown>,
  deps: HandleMarkerDeps
): Promise<MarkerCallResult> {
  const text = String(args.text ?? "").trim();
  const cap = TEXT_CAP[toolName];
  if (text.length === 0) {
    return errorResult(`${toolName}: text is required`);
  }
  if (text.length > cap) {
    return errorResult(
      `${toolName}: text is ${text.length} chars, exceeds ${cap}-char cap — shorten to ≤${cap}.`
    );
  }

  const argsToPersist: Record<string, unknown> = { text };
  let blockerRef = "";
  let filePath = "";

  if (toolName === "mark_decision") {
    const alts = args.alternatives;
    if (Array.isArray(alts) && alts.length > 0) {
      argsToPersist.alternatives = alts
        .map((v) => String(v))
        .slice(0, 5)
        .map((v) => (v.length > 80 ? `${v.slice(0, 80)}…` : v));
    }
  }

  if (toolName === "mark_blocker") {
    const fp = args.file_path;
    if (typeof fp === "string" && fp.length > 0) {
      filePath = fp.length > 200 ? `${fp.slice(0, 200)}…` : fp;
      argsToPersist.file_path = filePath;
    }
  }

  if (toolName === "mark_resolution") {
    const ref = String(args.blocker_ref ?? "").trim();
    if (ref.length === 0) {
      return errorResult(
        "mark_resolution: blocker_ref required (the marker_id returned by mark_blocker)"
      );
    }
    blockerRef = ref;
    argsToPersist.blocker_ref = blockerRef;
  }

  const entry = deps.ledger.record(
    toolName,
    argsToPersist,
    { ok: true },
    deps.branch,
    deps.headSha
  );

  // Read redacted values back from the ledger row — `ShadowLedger.record()`
  // ran the redactor on args_summary, so these are guaranteed scrubbed before
  // they land in timeline.db. (Bug fix: previously we wrote the raw input text,
  // leaking secrets into the markers relation.)
  const persistedArgs = entry.args_summary as Record<string, unknown>;
  const redactedText =
    typeof persistedArgs.text === "string" ? persistedArgs.text : text;
  const redactedFilePath =
    typeof persistedArgs.file_path === "string"
      ? persistedArgs.file_path
      : filePath;
  const redactedBlockerRef =
    typeof persistedArgs.blocker_ref === "string"
      ? persistedArgs.blocker_ref
      : blockerRef;

  try {
    await deps.store.insertMarker({
      marker_id: entry.id,
      type: toolName,
      text: redactedText,
      session_id: entry.session_id,
      turn_id: entry.turn_id ?? "",
      ts: Date.parse(entry.ts),
      blocker_ref: redactedBlockerRef,
      file_path: redactedFilePath,
    });
  } catch (err: unknown) {
    process.stderr.write(
      `[unerr:timeline-markers] WARN: insertMarker failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    // Continue: ledger row already persisted, miners can still recover from it.
  }

  // Cap A-1: synthesize a trajectory trace when a blocker is resolved.
  // Fire-and-forget; a failure here never fails the marker call.
  // Use the validated raw `blockerRef` (not `redactedBlockerRef`) because
  // the blocker_ref is a system-generated 12-hex marker ID, not user content.
  // The ledger args_summary roundtrip is intentional for `text`/`file_path`
  // (which can contain secrets), but running a marker ID through the redactor
  // creates an invisible failure mode: if a future regex ever matches a hex
  // string, redactedBlockerRef would differ from the stored marker_id,
  // getMarkerById would return null, and synthesizeTrace would exit silently
  // with no WARN and no trace row — exactly the live symptom observed.
  if (toolName === "mark_resolution" && blockerRef.length > 0) {
    synthesizeTrace(
      blockerRef,
      redactedText,
      entry.id,
      entry.session_id,
      Date.parse(entry.ts),
      deps.ledger,
      deps.store,
      deps.behaviorWriter
    ).catch((err: unknown) => {
      process.stderr.write(
        `[unerr:trace] WARN: synthesizeTrace failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    });
  }

  // L1 — mirror the marker into the unified per-repo event store as one
  // contract-shaped `timeline` event so `unerrd` drains it to the cloud. The
  // marker kind is the tool name without its `mark_` prefix (intent/decision/
  // blocker/resolution), each a valid TIMELINE_KINDS member. Marker prose is the
  // developer's own words — NOT a path — so `label`/`note_text` are not gated;
  // `label` is the prose truncated to the contract's 256-char ceiling, and
  // `note_text` carries the full redacted prose (capped at SYNC_MAX_FACT_TEXT,
  // already enforced by the 1400-char input cap above). emit() is a fire-and-
  // forget no-op when no process context is configured, so it never throws.
  const kind = toolName.slice("mark_".length);
  emit({
    type: "timeline",
    detail: {
      client_entry_id: entry.id,
      kind,
      label:
        redactedText.length > 256 ? redactedText.slice(0, 256) : redactedText,
      note_text: redactedText,
    },
    ...(entry.turn_id ? { turn_id: entry.turn_id } : {}),
  });

  // Compliance telemetry: pair every successful mark_intent with the
  // required-count tick the prompt hook emits (#109). Best-effort —
  // counter drift is preferable to crashing the marker call.
  if (toolName === "mark_intent") {
    try {
      updateNudgeState(process.cwd(), (s) => {
        s.mark_intent_compliant_count += 1;
      });
    } catch {
      /* best effort */
    }

    // Lever C (C6): a delegation intent records aggregated telemetry. The
    // delegable class + sweep flag come from the marker text the unerr-delegate
    // skill emits; no per-developer detail is stored.
    if (deps.behaviorWriter) {
      const intent = parseDelegationIntent(redactedText);
      if (intent) {
        try {
          deps.behaviorWriter.record({
            session_id: entry.session_id,
            native_session_id: null,
            tool_use_id: null,
            type: intent.sweep ? "delegated_sweep" : "delegated_edit",
            tool: "mark_intent",
            entity_key: null,
            response_bytes: null,
            detail: { class: intent.class, sweep: intent.sweep },
          });
          // Issue 5 — light up the model-tier savings family so a delegation is
          // VISIBLE in telemetry, not just inferable. The class routes to a tier
          // (tests/mechanical_refactor → middle, the rest → cheapest worker);
          // this writes harness_subagent_model + delegated_to_junior (+
          // recon_in_cheap_subagent / worker_batch_parallel when they apply),
          // the dormant kinds the activation audit needs to see delegation fire.
          emitDelegationSavings(deps.behaviorWriter, {
            session_id: entry.session_id,
            delegable_class: intent.class,
            sweep: intent.sweep,
            tier: tierForDelegationClass(intent.class),
          });
        } catch {
          /* best effort */
        }
      }

      // Issue 4 — batch-work savings. A `bulk-edit` marker (one command/script
      // or a worker loop replaced an N-file frontier loop) and a `batch-call`
      // marker (N targets in one call instead of N round-trips) are mutually
      // exclusive with delegation and with each other; each lights its own
      // dormant kind so the activation audit sees batching fire.
      try {
        const bulk = parseBulkEditIntent(redactedText);
        if (bulk) {
          emitBulkEditSavings(deps.behaviorWriter, {
            session_id: entry.session_id,
            mode: bulk.mode,
            files: bulk.files,
          });
        }
        const batch = parseBatchCallIntent(redactedText);
        if (batch) {
          emitBatchCallSavings(deps.behaviorWriter, {
            session_id: entry.session_id,
            targets: batch.targets,
          });
        }
      } catch {
        /* best effort */
      }
    }
  }

  // Wire payload: the agent acts on `marker_id` ONLY for mark_blocker — it
  // passes that id back as `blocker_ref` to mark_resolution. For the other
  // three markers the id/turn_id/type are resume-strip telemetry the
  // dashboard reads from timeline.db + shadow.jsonl, so they stay off the
  // agent wire.
  const wire: { ok: true; marker_id?: string } =
    toolName === "mark_blocker"
      ? { ok: true, marker_id: entry.id }
      : { ok: true };
  return {
    content: [{ type: "text", text: JSON.stringify(wire) }],
  };
}

function errorResult(msg: string): MarkerCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: msg }),
      },
    ],
  };
}

/**
 * Synthesize and persist a trajectory trace when a blocker is resolved. Derives
 * dead_ends from the ledger span between the blocker and resolution entries so
 * the agent pays zero extra cost — the data is already recorded.
 * @sem domain=intelligence
 */
async function synthesizeTrace(
  blockerRef: string,
  unlockText: string,
  resolutionEntryId: string,
  sessionId: string,
  resolvedAt: number,
  ledger: ShadowLedger,
  store: CozoTimelineStore,
  behaviorWriter?: { record(input: BehaviorEventInput): void }
): Promise<void> {
  // Look up the blocker marker for situation text + code anchor.
  const blockerMarker = await store.getMarkerById(blockerRef);
  if (!blockerMarker) {
    // Observability (Fix A3): this stop used to be silent, which made a capture
    // regression look identical to "no past incidents". Log the skipped trace so
    // a future getMarkerById miss is caught immediately instead of hours later.
    process.stderr.write(
      `[unerr:trace] WARN: blocker ${blockerRef} not found — trace skipped\n`
    );
    return;
  }

  const situation = blockerMarker.text;
  const anchor = blockerMarker.file_path;

  // Extract dead_ends from ledger entries between blocker and resolution.
  // Use the in-memory buffer (last 100 entries) — sufficient for normal spans.
  const allEntries = ledger.getRecentEntries(100);
  const blockerIdx = allEntries.findIndex((e) => e.id === blockerRef);
  const spanEntries = blockerIdx === -1 ? [] : allEntries.slice(blockerIdx + 1);

  const touched = new Set<string>();
  for (const e of spanEntries) {
    if (e.id === resolutionEntryId) continue; // exclude the resolution itself
    const summary = e.args_summary as Record<string, unknown>;
    const fp = summary?.file_path;
    if (typeof fp === "string" && fp.length > 0) touched.add(fp);
    const ek = summary?.entity ?? summary?.key;
    if (typeof ek === "string" && ek.length > 0) touched.add(ek);
  }
  // The anchor is the resolved location — not a dead end.
  if (anchor.length > 0) touched.delete(anchor);
  const deadEnds = [...touched];

  // Tokenize the situation for symptom-match retrieval.
  // Reuses search-index tokenize (the same function that builds search_tokens).
  const tokens = tokenize(situation);

  // Persist trace + inverted token index.
  const traceId = randomUUID();
  await store.insertTrace({
    trace_id: traceId,
    situation,
    dead_ends: JSON.stringify(deadEnds),
    unlock: unlockText,
    anchor,
    session_id: sessionId,
    resolved_at: resolvedAt,
  });
  await store.insertTraceTokens(traceId, tokens);

  // Cap A reporting: surface the capture so the receipt's Remembered recap
  // shows a trajectory trace was stored this session. Best-effort — a writer
  // failure never fails trace persistence.
  try {
    behaviorWriter?.record({
      session_id: sessionId,
      native_session_id: null,
      tool_use_id: null,
      type: "trace_captured",
      tool: "mark_resolution",
      entity_key: anchor.length > 0 ? anchor : null,
      response_bytes: null,
      detail: {
        dead_ends: deadEnds.length,
        ...(anchor.length > 0 ? { anchor } : {}),
      },
    });
  } catch {
    /* best effort */
  }
}
