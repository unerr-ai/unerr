/**
 * `unerr_context` — the warm MCP twin of the `unerr recon` CLI command
 * (Sprint 1b).
 *
 * `unerr recon` (src/commands/recon.ts) collapses the discovery fan-out
 * (search_code → get_references → get_conventions) into ONE subprocess so the
 * agent pays one round-trip instead of several. But shelling out has its own
 * cost — a fresh process, a fresh CozoDB open. `unerr_context` runs the SAME
 * `composeRecon` orchestration in-process against the already-loaded graph, so
 * the agent gets the bundle over the live MCP transport with zero spawn cost.
 *
 * Everything routes through `QueryRouter.executeRaw` so `composeRecon` receives
 * the raw structured shapes — not the columnar/json wire strings `execute()`
 * emits.
 *
 * This module is deliberately decoupled from the proxy wiring: the caller
 * injects `runRaw` (QueryRouter.executeRaw), so the orchestration is
 * unit-testable with fakes.
 */

import {
  type BundleSavingsModel,
  type ReconRunner,
  SWEEP_SEARCH_LIMIT,
  composeRecon,
  modelBundleSavings,
  reconEntityCount,
  reconFileSpread,
  renderReconDigest,
  renderReconText,
} from "../intelligence/recon.js";
import { classifyTaskSize } from "../intelligence/task-size.js";
import { initFileLog, startupLog } from "../utils/startup-log.js";

/** MCP tool-result shape (mirrors the sibling proxy handlers). */
export interface UnerrContextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface UnerrContextDeps {
  /**
   * Raw local tool execution (`QueryRouter.executeRaw`) — returns structured
   * shapes for search_code / get_references / get_conventions, NOT wire strings.
   */
  runRaw: ReconRunner;
  /** Repo cwd — used to init the telemetry log before the lever emit. */
  repoCwd: string;
  /**
   * E4 Layer A sink — persist the modeled bundle savings (a `context_bundle`
   * compression_event + the matching token_flow_event that feeds the
   * SavingsOriginSplit "context bundling / round-trip avoidance" origin). The
   * `model` carries the Layer-B manifest (delivered/expand keys) for the
   * post-hoc reconciliation. Optional + injected so the handler stays
   * unit-testable with a fake; the proxy wires the real DB writers. Failures
   * are swallowed by the caller — telemetry is never load-bearing.
   */
  recordBundleSavings?: (model: BundleSavingsModel) => void;
}

let _leverLogInit = false;

/**
 * Emit the `recon_cli_served` lever so the dashboard's token-overhead panel
 * counts warm-path recon adoption alongside the CLI path. `source:"mcp_warm"`
 * lets a future split distinguish the two without a new msg key. Telemetry is
 * never load-bearing — failures are swallowed, and VITEST runs never write.
 */
function recordReconServed(
  fields: {
    sections: number;
    tokens: number;
    task_size: string;
    digest: boolean;
    file_spread: number;
    entity_count: number;
  },
  repoCwd: string
): void {
  if (process.env.VITEST) return;
  try {
    if (!_leverLogInit) {
      initFileLog(repoCwd);
      _leverLogInit = true;
    }
    startupLog.fileOnly("telemetry", "recon_cli_served", {
      ...fields,
      source: "mcp_warm",
    });
  } catch {
    /* telemetry never load-bearing */
  }
}

function errorResult(message: string): UnerrContextResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Handle one `unerr_context` call. Args mirror `unerr recon`:
 *   - `prompt`          (required) — what the agent is about to do, verbatim.
 *   - `budget`          (optional) — whole-bundle token budget; defaults to recon's 4000.
 *   - `digest`          (optional) — force the flat large-sweep digest render.
 *   - `response_format` (optional) — 'detailed' inlines verbatim focus bodies;
 *                        'concise' returns names+signatures+callers only. Default
 *                        is derived from task size server-side (agents can't be
 *                        trusted to set it, and Gemini strips a schema `default`).
 */
export async function handleUnerrContextProxy(
  args: Record<string, unknown>,
  deps: UnerrContextDeps
): Promise<UnerrContextResult> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return errorResult(
      "unerr_context requires a `prompt` string — pass what you are about to do (e.g. 'add a retry to fetchUser')"
    );
  }
  // Accept the standard `token_budget` param (every other tool uses it); keep
  // `budget` as a back-compat alias. token_budget wins when both are present.
  const budgetArg =
    typeof args.token_budget === "number" && args.token_budget > 0
      ? args.token_budget
      : typeof args.budget === "number" && args.budget > 0
        ? args.budget
        : undefined;
  const budget = budgetArg;
  const explicitDigest = args.digest === true;
  const explicitFormat =
    args.response_format === "concise" || args.response_format === "detailed"
      ? (args.response_format as "concise" | "detailed")
      : undefined;
  // Speculative expand ring (E2): pre-inline the top callers' bodies. Opt-in —
  // only worth the tokens when the edit actually touches callers.
  const expand = args.expand === true;

  const runner: ReconRunner = deps.runRaw;

  // Size-gate exactly as the CLI does: classify from the prompt to pick search
  // width, then re-classify with the realized entity count so the verdict (and
  // digest choice) reflect what recon actually found, not just the verbs.
  const preVerdict = classifyTaskSize(prompt);
  const searchLimit =
    preVerdict.size === "large_sweep" ? SWEEP_SEARCH_LIMIT : undefined;

  // Lean default (concise): composeRecon inlines the SINGLE top focus body for
  // any targeted edit (a focus entity was locked), so a single-entity edit never
  // needs a separate file_read drill; only a large sweep renders as a flat index
  // digest. Full bodies (up to MAX_FOCUS_BODIES) are opt-in via include_body:true.
  // An explicit response_format always wins.
  const includeBody = args.include_body === true;
  const responseFormat: "concise" | "detailed" =
    explicitFormat ?? (includeBody ? "detailed" : "concise");

  let bundle: Awaited<ReturnType<typeof composeRecon>>;
  try {
    bundle = await composeRecon({
      prompt,
      runner,
      ...(budget !== undefined ? { budget } : {}),
      searchLimit,
      responseFormat,
      expand,
      // External `want` fan-out: composeRecon walks it ONLY when a real
      // downstream-MCP gateway is injected here as `mcpSources`. There is no
      // toggle — capability is presence, not a flag (this runs on the user's
      // machine; nobody flips switches). No downstream gateway exists yet, so
      // none is injected and `want` is not advertised on the tool. When the
      // gateway lands, inject it here and add `want` back to the schema in the
      // same change — the composeRecon seam is already built and tested.
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`unerr_context failed to compose recon bundle: ${msg}`);
  }

  const entityCount = reconEntityCount(bundle);
  const verdict = classifyTaskSize(prompt, { entityCount });
  const files = reconFileSpread(bundle);
  // Digest ⟺ no focus bodies were inlined. The digest collapses bodies to
  // file:line ranges, so rendering it over an inlined body throws the body away
  // and forces the agent to re-read it (the W4 no-op). A 'detailed' bundle and a
  // 'concise' bundle that realized as a focused edit (composeRecon's
  // focused-footprint floor) both carry bodies → render verbatim. An explicit
  // digest:true still forces the flat render regardless.
  const hasFocusBodies = bundle.sections.some(
    (s) =>
      s.tool === "focus_bodies" && Array.isArray(s.data) && s.data.length > 0
  );
  const useDigest =
    explicitDigest || (responseFormat === "concise" && !hasFocusBodies);
  let text = useDigest ? renderReconDigest(bundle) : renderReconText(bundle);
  // Lean index (no body inlined) → name the drill step so the agent pulls the
  // one body it will edit instead of re-searching. Only when a focus entity
  // exists (else the line names no target — a signal without an action is noise).
  if (useDigest && bundle.focusKey) {
    const target = bundle.focusName ?? bundle.focusKey;
    text = `ur|act file_read({entity:'${target}'}) to read ${target} before editing\n\n${text}`;
  }

  recordReconServed(
    {
      sections: bundle.sections.length,
      tokens: bundle.totalTokens,
      task_size: verdict.size,
      digest: useDigest,
      file_spread: files.length,
      entity_count: entityCount,
    },
    deps.repoCwd
  );

  // E4 Layer A: model this bundle's round-trip savings and hand them to the
  // injected sink (compression_event + token_flow_event). Pure computation here;
  // the proxy owns the DB writes. Never load-bearing — a throwing sink is
  // swallowed so telemetry can never fail the recon call.
  if (deps.recordBundleSavings) {
    try {
      deps.recordBundleSavings(modelBundleSavings(bundle));
    } catch {
      /* telemetry never load-bearing */
    }
  }

  return { content: [{ type: "text", text }] };
}
