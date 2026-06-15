/**
 * Review control-channel protocol (P1 — Surface A, in-flight).
 *
 * Single source of truth for the `unerr/review_edit` request/response shape
 * exchanged over the per-repo UDS socket (`.unerr/state/proxy.sock`). The proxy
 * answers it (see proxy.ts UDS handler) by running the full {@link ReviewEngine}
 * against the warm in-process graph; the post-edit hook builds the request and
 * formats the findings into `ur|<tag>` lines. Both sides import THIS module so
 * the wire contract can never drift — the same discipline as
 * `blast-radius-protocol.ts`, of which this is the post-edit, whole-engine
 * sibling (blast-radius is the pre-edit, two-check subset).
 *
 * Transport: a lightweight JSON-RPC method intercepted before MCP tool dispatch
 * (mirrors `unerr/blast_radius` and `unerr/ping`): connect, one frame, one
 * response, disconnect — no MCP `initialize` handshake.
 */

import { isAbsolute, relative } from "node:path";
import type { EditImpactGraph } from "../intelligence/edit-impact.js";
import { defaultCheckers } from "../review/checkers/index.js";
import { ReviewEngine } from "../review/engine.js";
import { buildSynthesisBlock } from "../review/synthesis.js";
import {
  type ChangeEntity,
  DEFAULT_REVIEW_CONFIG,
  type ReviewFinding,
  type ReviewGraph,
  type ReviewNotes,
  type ReviewRules,
  type ReviewSearch,
  type Severity,
} from "../review/types.js";

/** JSON-RPC method name for the in-flight review query. */
export const REVIEW_EDIT_METHOD = "unerr/review_edit";

/** Request params for {@link REVIEW_EDIT_METHOD}. */
export interface ReviewEditRequestParams {
  /** Absolute or repo-relative path of the file just edited. */
  file_path?: string;
  /** Pre-edit content (Claude Code `old_string`), if available. */
  old_content?: string | null;
  /** Post-edit content (Claude Code `new_string`), if available. */
  new_content?: string | null;
  /** Floor severity to surface in-flight (defaults to "medium" — low/info are commit-gate concerns). */
  min_severity?: Severity;
}

/** Result payload for {@link REVIEW_EDIT_METHOD}. */
export interface ReviewEditResult {
  /**
   * All findings at or above the floor, deduped and sorted by severity desc.
   * Tier-1 are rendered as `ur|<tag>` verdicts; Tier-2 (`needsModel`) are also
   * present here for telemetry but are NOT rendered as verdicts — see
   * {@link ReviewEditResult.evidenceBlock}.
   */
  findings: ReviewFinding[];
  /** Count of findings produced but below the floor. */
  suppressed: number;
  /**
   * Tier-2 host-synthesis evidence block (P4) — the concrete graph evidence the
   * host model elaborates on (fix-or-flag), routed through the agent-as-LLM
   * seam. `null` when there are no Tier-2 findings (no block → no Tier-2, §9.3).
   */
  evidenceBlock: string | null;
  /** True when nothing survived gating — an evidenced-clean edit. */
  clean: boolean;
}

/** Dependencies the proxy injects; all optional so the wire path degrades gracefully. */
export interface ReviewEditDeps {
  notes?: ReviewNotes | null;
  rules?: ReviewRules | null;
  search?: ReviewSearch | null;
  intent?: string | null;
  /**
   * Repo root used to normalize an absolute `file_path` to the repo-relative
   * form the graph + checkers key on. Defaults to `process.cwd()` (the proxy's
   * root). See the normalization note in {@link handleReviewEditRequest}.
   */
  projectRoot?: string;
}

const EMPTY_RESULT: ReviewEditResult = {
  findings: [],
  suppressed: 0,
  evidenceBlock: null,
  clean: true,
};

/**
 * Structural guard for a {@link ReviewEditResult} arriving over the wire —
 * CROSS_REPO_INTELLIGENCE Sprint 8.2 routes a foreign-file post-edit review to
 * the owning peer, whose reply is untyped `unknown`. Validates the findings
 * array + the clean flag so a malformed/partial peer reply degrades to a home
 * compute instead of being trusted blindly.
 */
export function isReviewEditResult(value: unknown): value is ReviewEditResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.findings) && typeof v.clean === "boolean";
}

/**
 * Run the review engine over a single in-flight edit against the warm graph.
 *
 * L0 change extraction for one edit: the touched file becomes one `ChangeFile`,
 * and every entity the graph reports in that file becomes a `modified`
 * `ChangeEntity` carrying the whole-file old/new content (the signature-change
 * primitive is name-scoped, so whole-file content is the correct input — same
 * contract `computeEditImpact` relies on). Added/deleted-only checkers stay
 * quiet in-flight (no reliable per-entity diff here); they fire at the commit
 * gate (Surface B) where the full diff is available.
 *
 * Always resolves to a well-formed result — empty + clean on a missing path or
 * absent graph — so the hook never special-cases a degraded proxy.
 */
export async function handleReviewEditRequest(
  graph: (EditImpactGraph & Partial<ReviewGraph>) | null,
  params: ReviewEditRequestParams | undefined,
  deps: ReviewEditDeps = {}
): Promise<ReviewEditResult> {
  const rawPath = params?.file_path;
  if (!rawPath || !graph) return EMPTY_RESULT;

  // Claude Code's PostToolUse `tool_input.file_path` is ALWAYS absolute, but the
  // graph keys entities by repo-relative path and the checkers' layer rules are
  // repo-relative prefixes. Normalize absolute → repo-relative with the SAME
  // conversion the indexer uses (relative(projectRoot, abs)). Without this,
  // getEntitiesByFile finds no entities and path-based checkers match no rule,
  // so every real edit returns a clean/empty review — the reviewer never fires.
  const projectRoot = deps.projectRoot ?? process.cwd();
  const filePath = isAbsolute(rawPath)
    ? relative(projectRoot, rawPath)
    : rawPath;

  const reviewGraph = graph as ReviewGraph;
  const oldContent = params?.old_content ?? null;
  const newContent = params?.new_content ?? null;

  const inFile = await reviewGraph.getEntitiesByFile(filePath);
  const entities: ChangeEntity[] = inFile.map((e) => ({
    kind: "modified",
    entityKey: e.key,
    name: e.name,
    filePath,
    oldBody: oldContent,
    newBody: newContent,
    line: e.start_line,
  }));

  const engine = new ReviewEngine();
  engine.registerAll(defaultCheckers());

  const report = await engine.run(
    {
      changeSet: {
        entities,
        files: [{ path: filePath, kind: "modified", oldContent, newContent }],
        source: "in_flight",
      },
      graph: reviewGraph,
      notes: deps.notes ?? null,
      drift: null,
      rules: deps.rules ?? null,
      search: deps.search ?? null,
      intent: deps.intent ?? null,
      config: DEFAULT_REVIEW_CONFIG,
    },
    { minSeverity: params?.min_severity ?? "medium" }
  );

  return {
    findings: report.findings,
    suppressed: report.suppressed,
    // Tier-2 findings (if any) become one evidence block routed through the
    // agent-as-LLM seam; null when there are none (silence, never a guess).
    evidenceBlock: buildSynthesisBlock(report.findings) || null,
    clean: report.clean,
  };
}
