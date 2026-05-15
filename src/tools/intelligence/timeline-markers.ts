/**
 * Timeline marker MCP tools (ST-2a).
 *
 * Four lightweight tools the agent emits inline as it works. Each call:
 *   1. Appends a regular `LedgerEntry` via `ShadowLedger.record()` with
 *      `tool: "mark_*"` — existing readers see it as a normal MCP call.
 *   2. Mirrors a row into `timeline.db.markers` for indexed lookup
 *      (open-threads, intent rail, future miners).
 *
 * Layer 9 modules (`session-narrative`, `session-pattern-analyzer`,
 * `fact-generator`, `temporal-facts`) are NOT touched. They remain agnostic to
 * markers — if Layer 9 wants to prefer marker `text` over its scraped 30 s
 * window later, that's a separate change owned by Layer 9.
 *
 * Text caps:
 *   mark_intent      ≤  80 chars
 *   mark_decision    ≤ 140 chars
 *   mark_blocker     ≤ 140 chars
 *   mark_resolution  ≤ 140 chars
 */

import type { CozoTimelineStore } from "../../timeline/timeline-store.js";
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

const TEXT_CAP: Record<MarkerToolName, number> = {
  mark_intent: 80,
  mark_decision: 140,
  mark_blocker: 140,
  mark_resolution: 140,
};

export interface HandleMarkerDeps {
  ledger: ShadowLedger;
  store: CozoTimelineStore;
  branch: string;
  headSha: string;
}

export interface MarkerCallResult {
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Dispatch a marker tool call. Returns an MCP-shaped response either with a
 * success body (`{ok, marker_id, turn_id}`) or an `{error}` body — callers
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
    return errorResult(`${toolName}: text exceeds ${cap}-char limit`);
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

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          marker_id: entry.id,
          turn_id: entry.turn_id ?? null,
          type: toolName,
        }),
      },
    ],
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
