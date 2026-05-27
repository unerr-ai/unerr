/**
 * Blast-radius control-channel protocol (P0.4).
 *
 * The single source of truth for the `unerr/blast_radius` request/response shape
 * exchanged over the per-repo UDS socket (`.unerr/state/proxy.sock`). The proxy
 * answers it (see proxy.ts UDS handler); the pre-edit hook (P0.5) builds the
 * request and parses the response. Both sides import THIS module so the wire
 * contract can never drift between producer and consumer.
 *
 * Transport: a lightweight JSON-RPC method intercepted before MCP tool dispatch
 * — the hook connects, sends one frame, reads one response, disconnects, with no
 * MCP `initialize` handshake (mirrors the `unerr/ping` precedent in transport-mux).
 */

import { isAbsolute, relative } from "node:path";
import {
  type BoundaryViolation,
  computeBoundaryViolations,
} from "../intelligence/boundary-check.js";
import {
  type CascadeWarning,
  DEFAULT_EDIT_IMPACT_CONFIG,
  type EditImpactGraph,
  computeEditImpact,
} from "../intelligence/edit-impact.js";

/** JSON-RPC method name for the blast-radius control query. */
export const BLAST_RADIUS_METHOD = "unerr/blast_radius";

/** Request params for {@link BLAST_RADIUS_METHOD}. */
export interface BlastRadiusRequestParams {
  /** Absolute or repo-relative path of the file about to be edited. */
  file_path?: string;
  /** Pre-edit content (Claude Code `old_string`), if available. */
  old_content?: string | null;
  /** Post-edit content (Claude Code `new_string`), if available. */
  new_content?: string | null;
  /** Override the minimum caller count that warrants a warning. */
  min_callers?: number;
  /** Override whether test-file callers count toward the threshold. */
  include_tests?: boolean;
}

/** Result payload for {@link BLAST_RADIUS_METHOD}. */
export interface BlastRadiusResult {
  /** Signature changes whose callers must be updated in the same change (P0/P1). */
  warnings: CascadeWarning[];
  /** Relative imports in the new content that cross a community boundary (P2.1). */
  boundary_violations: BoundaryViolation[];
}

/**
 * Answer a blast-radius request against the warm in-process graph. "Blast radius
 * of an edit" spans two questions, answered in one round-trip: which callers are
 * at risk from a signature change ({@link computeEditImpact}) and which new
 * imports cross an architecture boundary ({@link computeBoundaryViolations}).
 *
 * Always resolves to a well-formed result — empty arrays on a missing file path
 * or absent graph — so the hook never special-cases a degraded proxy. Cascade
 * needs the graph (caller resolution); the boundary check is purely path-based
 * (declared layer rules) so it runs whenever there's content, graph or not.
 */
export async function handleBlastRadiusRequest(
  graph: EditImpactGraph | null,
  params: BlastRadiusRequestParams | undefined,
  projectRoot: string = process.cwd()
): Promise<BlastRadiusResult> {
  const rawPath = params?.file_path;
  if (!rawPath || !graph) return { warnings: [], boundary_violations: [] };

  // Claude Code's PreToolUse `tool_input.file_path` is ALWAYS absolute, but the
  // layer rules (computeBoundaryViolations) and entity keys (computeEditImpact)
  // are repo-relative — produced by `relative(projectRoot, abs)` at index time
  // (local-indexer.ts). Normalize absolute → repo-relative with the SAME
  // conversion so the documented "absolute or repo-relative" file_path contract
  // actually holds. Without this, an absolute path prefix-matches no rule and
  // resolves to no entity, so every real edit degrades to the static nudge — the
  // graph-backed signal never fires. A path outside the repo relativizes to a
  // "../"-prefixed form that matches no rule/entity (correct: no signal for
  // out-of-tree files).
  const filePath = isAbsolute(rawPath)
    ? relative(projectRoot, rawPath)
    : rawPath;

  const warnings = await computeEditImpact(
    graph,
    filePath,
    params?.old_content ?? null,
    params?.new_content ?? null,
    {
      minCallersToWarn:
        params?.min_callers ?? DEFAULT_EDIT_IMPACT_CONFIG.minCallersToWarn,
      includeTests:
        params?.include_tests ?? DEFAULT_EDIT_IMPACT_CONFIG.includeTests,
    }
  );

  // Boundary check is path-based (declared layer rules) — no graph needed.
  const boundary_violations: BoundaryViolation[] = computeBoundaryViolations(
    filePath,
    params?.new_content ?? null
  );

  return { warnings, boundary_violations };
}

/**
 * Structural sink for {@link recordBlastRadiusTelemetry} — satisfied by
 * `BehaviorEventWriter`. Declared locally so this module stays decoupled from
 * `src/tracking/`; proxy.ts owns the concrete writer and passes it in.
 */
export interface BlastRadiusTelemetrySink {
  readonly sessionId: string;
  record(input: {
    session_id: string;
    type: "cascade_guard" | "boundary_violation_flagged";
    tool: null;
    entity_key: string | null;
    response_bytes: null;
    detail: Record<string, unknown>;
  }): void;
}

/**
 * Emit the pre-edit guard firings as behavior events so the dashboard's
 * behavior-event panes render them. The caller-cascade signal (D2) and the
 * architecture-boundary signal (D3) are distinct behaviors; each fires its own
 * row only when it actually fires. Best-effort — every error is swallowed so
 * telemetry never blocks the control-channel reply.
 */
export function recordBlastRadiusTelemetry(
  sink: BlastRadiusTelemetrySink,
  result: BlastRadiusResult,
  filePath: string | null
): void {
  try {
    if (result.warnings.length > 0) {
      sink.record({
        session_id: sink.sessionId,
        type: "cascade_guard",
        tool: null,
        entity_key: filePath,
        response_bytes: null,
        detail: {
          warnings: result.warnings.length,
          total_at_risk: result.warnings[0]?.blast_radius.total_at_risk ?? 0,
          change_types: [...new Set(result.warnings.map((w) => w.change_type))],
          ...(filePath ? { file_path: filePath } : {}),
        },
      });
    }
    if (result.boundary_violations.length > 0) {
      sink.record({
        session_id: sink.sessionId,
        type: "boundary_violation_flagged",
        tool: null,
        entity_key: filePath,
        response_bytes: null,
        detail: {
          violations: result.boundary_violations.length,
          target_layers: [
            ...new Set(result.boundary_violations.map((b) => b.target_layer)),
          ],
          ...(filePath ? { file_path: filePath } : {}),
        },
      });
    }
  } catch {
    /* best-effort — telemetry never blocks the reply */
  }
}
