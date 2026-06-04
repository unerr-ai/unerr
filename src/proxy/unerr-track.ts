/**
 * `unerr_track` op-union translation (Phase-2 Sprint 8).
 *
 * The six session-write tools (4 markers + record_fact + recall_facts) all
 * return state that drives nothing THIS turn, so they were consolidated into a
 * single op-union tool per the user's 6→1 decision (Anthropic-endorsed: "fewer
 * tools with an action parameter"). On hook-capable agents the writes are
 * hook-scraped (Sprint 7), so `unerr_track` is primarily the hook-less-agent
 * fallback + the explicit high-fidelity save path.
 *
 * This module is the pure translation layer: `unerr_track({op, …})` → the legacy
 * `(name, args)` pair. The proxy dispatch reassigns its `name`/`args` to the
 * translation result and falls through to the SAME marker/fact branches — so
 * there is ONE execution path (no behavioural fork). The legacy tool names stay
 * dispatchable by name for UDS hooks + hook-less agents, but they are no longer
 * MCP catalog members — so `runBoundaryValidation` (which looks a name up in
 * TOOL_DEFINITIONS) no-ops for them. This module therefore OWNS each op's
 * required-field validation: `validateOp` mirrors the required[] the legacy
 * schemas used to declare, and translation returns `{error}` before dispatch
 * when a field is missing. (op-union-selection-eval.test.ts asserts coverage.)
 */

/** The six ops the union multiplexes. */
export type TrackOp =
  | "intent"
  | "decision"
  | "blocker"
  | "resolution"
  | "fact"
  | "recall";

/** The canonical op vocabulary, in schema order. The model's selection space
 *  MUST equal this exactly (the unerr_track schema `op` enum) — an advertised
 *  op the translation can't route, or a routable op the schema hides, is a
 *  selection-accuracy bug (asserted by op-union-selection-eval.test.ts). */
export const TRACK_OPS: readonly TrackOp[] = [
  "intent",
  "decision",
  "blocker",
  "resolution",
  "fact",
  "recall",
];

const VALID_OPS: ReadonlySet<string> = new Set<TrackOp>(TRACK_OPS);

/** op → the legacy tool name its args translate to. */
const OP_TO_TOOL: Readonly<Record<TrackOp, string>> = {
  intent: "mark_intent",
  decision: "mark_decision",
  blocker: "mark_blocker",
  resolution: "mark_resolution",
  fact: "record_fact",
  recall: "recall_facts",
};

export type TrackTranslation =
  | { name: string; args: Record<string, unknown> }
  | { error: string };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/**
 * The flat-surface fields each op requires, in the union's own vocabulary
 * (text/blocker_ref/scope/target/fact_type). Mirrors the required[] the legacy
 * marker/fact schemas declared, re-homed here because those names left the MCP
 * catalog (so runBoundaryValidation no longer validates them).
 */
const OP_REQUIRED: Readonly<Record<TrackOp, readonly string[]>> = {
  intent: ["text"],
  decision: ["text"],
  blocker: ["text"],
  resolution: ["blocker_ref", "text"],
  fact: ["text", "fact_type", "scope", "target"],
  recall: ["scope"],
};

/**
 * Validate that every field `op` requires is a present, non-empty string.
 * Returns the error message (naming the missing fields in the union's
 * vocabulary) or null. Empty/whitespace counts as missing — the same
 * silent-empty-filter failure mode the legacy boundary validator guarded.
 */
function validateOp(op: TrackOp, raw: Record<string, unknown>): string | null {
  const missing = OP_REQUIRED[op].filter((f) => str(raw[f]) === undefined);
  if (missing.length === 0) return null;
  return `unerr_track op:'${op}' missing required field(s): ${missing.join(", ")}. Pass them on the unerr_track call.`;
}

/**
 * Translate `unerr_track` arguments into the legacy `(name, args)` pair. Returns
 * `{error}` only for a missing/invalid `op` — every other field is forwarded and
 * the legacy boundary validation reports any per-op required-field gap with the
 * precise tool message. Pure + total: never throws.
 */
export function translateUnerrTrack(
  raw: Record<string, unknown>
): TrackTranslation {
  const op = str(raw.op);
  if (!op || !VALID_OPS.has(op)) {
    return {
      error: `unerr_track: op is required and must be one of intent, decision, blocker, resolution, fact, recall (got ${JSON.stringify(raw.op)})`,
    };
  }
  const opValidation = validateOp(op as TrackOp, raw);
  if (opValidation) return { error: opValidation };
  const name = OP_TO_TOOL[op as TrackOp];

  // Per-op arg shaping. Only forward the fields each legacy tool reads; the
  // union exposes a flat {text, blocker_ref, scope, target, fact_type} surface
  // (plus `alternatives` for decisions) and we map it onto the legacy shapes.
  switch (op as TrackOp) {
    case "intent":
      return { name, args: { text: raw.text } };
    case "decision":
      return {
        name,
        args: {
          text: raw.text,
          ...(Array.isArray(raw.alternatives)
            ? { alternatives: raw.alternatives }
            : {}),
        },
      };
    case "blocker":
      return {
        name,
        args: {
          text: raw.text,
          // `target` doubles as the optional file path for a blocker.
          ...(str(raw.target) ? { file_path: raw.target } : {}),
        },
      };
    case "resolution":
      return { name, args: { blocker_ref: raw.blocker_ref, text: raw.text } };
    case "fact":
      return {
        name,
        args: {
          content: raw.text,
          fact_type: raw.fact_type,
          scope: raw.scope,
          // `target` is the fact's subject/entity.
          subject: raw.target,
        },
      };
    case "recall":
      return {
        name,
        args: {
          scope: raw.scope,
          ...(str(raw.fact_type) ? { fact_type: raw.fact_type } : {}),
          // Pagination lever — the recall wire-cap hint names it
          // (`ur|pg unerr_track op:'recall' +N — limit:X`), so the agent
          // pastes it back here and it must reach the legacy handler.
          ...(typeof raw.limit === "number" && raw.limit > 0
            ? { limit: raw.limit }
            : {}),
        },
      };
  }
}
