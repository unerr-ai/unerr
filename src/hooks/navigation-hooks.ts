/**
 * PreToolUse + PostToolUse hooks for Read/Grep/Glob/Write/Edit.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Handlers return agent-agnostic HookResults; adapters format for each agent.
 *
 * Design: NEVER block — always allow, only advise or enrich.
 */

import { join } from "node:path";
import type { BoundaryViolation } from "../intelligence/boundary-check.js";
import { lookupCoChangePartners } from "../intelligence/cochange-index.js";
import type { CascadeWarning } from "../intelligence/edit-impact.js";
import { splitStableVolatile } from "../proxy/prefix-order.js";
import { formatReviewFindings } from "../review/format.js";
import { recordEdit } from "../tracking/session-edit-log.js";
import { initFileLog, startupLog } from "../utils/startup-log.js";
import { queryBlastRadius } from "./blast-radius-client.js";
import {
  queryConventions,
  renderConventionsBlock,
} from "./conventions-client.js";
import { shouldEmitOnce } from "./hook-dedup.js";
import {
  type AsyncHookHandler,
  type HookHandler,
  deny,
  enrich,
  nudge,
  passthrough,
  runPostToolUseHook,
  runPostToolUseHookAsync,
  runPreToolUseHook,
  runPreToolUseHookAsync,
} from "./hook-runner.js";
import { queryReviewEdit } from "./review-client.js";

/** Dedup TTL for deny decisions. Per Anthropic #43189/#47565, denying
 *  the same call twice in a row causes 10x retry loops — after the
 *  first deny we fall back to a nudge so the agent moves on. 5 minutes
 *  is long enough that the same prompt won't re-deny, short enough
 *  that a genuinely new session/task still gets the deny treatment. */
const DENY_ONCE_TTL_MS = 5 * 60 * 1000;

/** Append a co-change clause to a base hint when the index has partners
 *  for the given file. Best-effort: returns the base hint unchanged on
 *  any read error or empty result. */
function appendCoChangeClause(base: string, filePath: string): string {
  try {
    const unerrDir = join(process.cwd(), ".unerr");
    const partners = lookupCoChangePartners(unerrDir, filePath, 3);
    if (partners.length === 0) return base;
    return `${base}; commonly co-changed with: ${partners.join(", ")}`;
  } catch {
    return base;
  }
}

// ── Helper ───────────────────────────────────────────────────────────

/** Extract file path from normalized tool input. */
function extractFilePath(input: Record<string, unknown>): string | undefined {
  const fp = (input.file_path ?? input.path ?? input.filePath) as
    | string
    | undefined;
  return typeof fp === "string" && fp.length > 0 ? fp : undefined;
}

/** Check if file is a code file (not config/docs/binary). */
function isCodeFile(filePath: string): boolean {
  return !/\.(md|json|ya?ml|toml|txt|lock|css|html|svg|png|jpg|pdf)$/i.test(
    filePath
  );
}

// R4 (Sprint 2 — token-overhead): the big instructional banners teach the
// toolset, but only the FIRST time matter. Re-emitting the full multi-line text
// on every hook firing was ~1.4k tok/turn of pure re-read-amplified ceremony
// (every round-trip re-bills the accumulated prefix). `onceVerbose` emits the
// full banner once per working session, then collapses to a terse, still-
// actionable one-liner that names the file + tool. The long TTL spans a session;
// the per-file 30s `shouldEmitOnce` default is a separate, orthogonal gate.
const VERBOSE_BANNER_TTL_MS = 2 * 60 * 60 * 1000; // ~one working session

/** Init the per-repo file log once per hook process, best-effort. */
let _leverLogInit = false;
function recordCeremonySuppressed(banner: string): void {
  // Never write telemetry into the dev repo's events.jsonl during the suite.
  if (process.env.VITEST) return;
  try {
    if (!_leverLogInit) {
      initFileLog(process.cwd());
      _leverLogInit = true;
    }
    // Powers the additive dashboard levers card (T5.3). File-only — the hook's
    // stdout is the agent's JSON contract; never write telemetry there.
    startupLog.fileOnly("telemetry", "ceremony_suppressed", { banner });
  } catch {
    // Telemetry is never load-bearing — a logging failure must not break a hook.
  }
}

function onceVerbose(key: string, full: string, terse: string): string {
  if (shouldEmitOnce(`verbose:${key}`, VERBOSE_BANNER_TTL_MS)) return full;
  // Banner already emitted in full this session → served terse = suppressed.
  recordCeremonySuppressed(key);
  return terse;
}

// ── PreToolUse Handlers (agent-agnostic) ─────────────────────────────

// Read routing (conditional deny). Built-in Read serves exactly ONE
// legitimate purpose: the pre-Edit gate. Claude Code's Edit/Write require a
// built-in Read of the file first (file-level + mtime check) and `file_read`
// (MCP) does NOT satisfy that gate — only the built-in Read tool or a bare
// single-file `cat`/`head`/`sed -n` flips Claude Code's internal read-tracking.
// A *targeted* Read (offset/limit) is that pre-Edit pattern: one call returns
// the byte-exact `old_string` window AND satisfies the gate. A *full-file*
// Read with no offset/limit is almost always exploration — and exploration
// must route through file_read/unerr_context (graph-backed; conventions, facts,
// and drift auto-injected). So: allow targeted reads + non-code reads silently;
// deny-once + redirect full-file CODE reads. Deny only the first attempt per
// file (then nudge) to avoid the #43189/#47565 double-deny retry loop.
const preReadHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath) return passthrough();

  const hasOffset = input.offset !== undefined;
  const hasLimit = input.limit !== undefined;
  const isTargeted = hasOffset || hasLimit;

  // Targeted Read (offset/limit) = the legitimate pre-Edit pattern on every
  // agent — satisfies the Edit gate and returns the exact lines. Allow silently.
  if (isTargeted) return passthrough();

  // Non-code files (docs, json, yaml, images, lockfiles) — built-in Read is the
  // sanctioned path; file_read's graph value (conventions/drift/callers) is
  // code-specific. Reading these whole is normal. Allow silently.
  if (!isCodeFile(filePath)) return passthrough();

  // Full-file CODE Read with no offset/limit → wasteful exploration. Redirect.
  // (OWN_EDIT_TOOL.md T-N1: the deny STAYS, but the rationale is no longer the
  // Edit gate — edits run through file_edit, which needs no prior Read at all.
  // Full-file reads are discouraged because they re-bill the whole file on every
  // later cached turn; the legitimate escape is naming that you need the WHOLE
  // file, not the gate.)
  const isClaudeCode = normalized.agentName === "claude-code";
  const editClause = isClaudeCode
    ? `\n- About to EDIT "${filePath}"? Call \`file_edit({file_path:"${filePath}", old_string, new_string})\` — the unerr edit path needs no prior Read.`
    : "";
  const reason = `Read("${filePath}") full-file is wasteful — route code exploration through unerr instead:\n- Understand the file: \`file_read({file_path:"${filePath}"})\` (auto-injects conventions, facts, drift)\n- Task-scoped recon in one call (anchored notes + blast radius + conventions): \`unerr_context({prompt:"<what you are about to do>"})\`\n- File structure first: \`file_outline("${filePath}")\`\n- One symbol's profile/body: \`search_code({query:'<name>', detail:true})\`\n- Genuinely need the ENTIRE file? Re-call Read — this redirect fires once per file.${editClause}`;

  // Deny the first full-file read per file; nudge (collapsing to terse after the
  // first verbose banner) on repeats within the dedup window — so re-issuing the
  // same full-file Read passes when the agent truly needs the whole file.
  if (shouldEmitOnce(`deny:Read:${filePath}`, DENY_ONCE_TTL_MS)) {
    return deny(reason);
  }
  return nudge(
    onceVerbose(
      "read-routing",
      reason,
      `Read full-file "${filePath}" — file_read({file_path:"${filePath}"}) to understand, file_edit to change it, or re-call Read if you truly need the whole file.`
    )
  );
};

const preGrepHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.regex ?? input.query) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();

  const looksLikeFunctionSearch = /^[a-zA-Z_]\w*$/.test(pattern);
  const looksLikeImportSearch = /import|require|from\s/.test(pattern);

  if (looksLikeFunctionSearch) {
    // High-confidence drift: an identifier-shaped pattern in Grep has a
    // direct graph-tool replacement. Deny the first attempt to force a
    // redirect to search_code; subsequent attempts in the same window
    // fall back to a nudge so the agent doesn't get stuck retrying.
    const reason = `Grep("${pattern}") — use \`search_code("${pattern}")\` (graph-indexed, <5ms, zero false positives) or \`get_references("${pattern}")\` for callers. Text grep matches comments/strings; graph tools are precise.`;
    if (shouldEmitOnce(`deny:Grep:${pattern}`, DENY_ONCE_TTL_MS)) {
      return deny(reason);
    }
    return nudge(reason);
  }

  if (looksLikeImportSearch) {
    return nudge(
      "STOP: Use `file_outline` instead of Grep for import/dependency tracing. It returns a file's structured entities + imports + exports in <5ms — more reliable than grepping for import statements."
    );
  }

  return nudge(
    "REQUIRED: This project has unerr graph tools indexed. Use `search_code` for code entity searches (faster, more accurate than Grep). Use `get_references` for finding callers."
  );
};

const preGlobHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.glob ?? input.path) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();

  // Same deny-once policy as Grep: Glob has a clean graph-tool
  // replacement (search_code), so the first attempt gets denied to
  // force the redirect. Subsequent attempts in the dedup window nudge
  // instead, so the agent never enters a deny-retry loop.
  const reason = `Glob("${pattern}") — use \`search_code("${pattern}")\` (graph-indexed, finds entities across the whole codebase in <5ms) or \`file_outline\` for structure. Glob+Grep is a multi-step pattern; search_code does it in one call.`;
  if (shouldEmitOnce(`deny:Glob:${pattern}`, DENY_ONCE_TTL_MS)) {
    return deny(reason);
  }
  return nudge(reason);
};

const preWriteHandler: HookHandler = (normalized) => {
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath)) return passthrough();

  return nudge(
    onceVerbose(
      "write-check",
      `Before writing "${filePath}", check for unintended side effects:\n- \`get_references({key:"<symbol>", direction:"callers"})\` on any functions you're modifying — ensure callers still work after your changes; test files in the caller list are the tests to run`,
      `Writing "${filePath}" — run get_references({direction:"callers"}) on changed entities before finishing; test files in the caller list are the tests to run.`
    )
  );
};

const preEditHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath)) return passthrough();

  const oldStr = input.old_string as string | undefined;
  const hasSignatureChange =
    oldStr &&
    /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?class\s+\w+/.test(
      oldStr.trim()
    );

  if (hasSignatureChange) {
    return nudge(
      `You're editing a function/class signature in "${filePath}". This may break callers.\n- \`get_references({direction:"callers"})\` on the entity you're modifying — all callers must be updated to match, and test files in the caller list are the tests to run`
    );
  }

  return nudge(
    `Before editing "${filePath}":\n- \`get_references\` on any entity you're changing — ensure callers won't break`
  );
};

/**
 * Render computed cascade warnings into a pre-edit nudge. Each warning already
 * carries an actionable, site-naming `suggestion` from the engine; this frames
 * them with the change type and the get_references next step. Reframed away
 * from "break silently" — the real risk is callers left un-updated, stated
 * plainly with concrete counts.
 */
function formatCascadeNudge(
  warnings: CascadeWarning[],
  filePath: string
): string {
  const lines: string[] = [];
  lines.push(
    `⚡ unerr · cascade guard: editing "${filePath}" changes ${warnings.length} signature(s) with callers that must be updated in the same change:`
  );
  for (const w of warnings) {
    const direct = w.blast_radius.direct_callers.length;
    const tests = w.blast_radius.test_files.length;
    // Distinct files the callers live in — the honest analogue of the
    // "across N services" framing, computed from the caller sites we have.
    const files = new Set(
      [...w.blast_radius.direct_callers, ...w.blast_radius.test_files].map(
        (c) => c.file
      )
    );
    lines.push(
      `- ${w.changed_entity} (${w.change_type}): ${w.blast_radius.total_at_risk} caller(s) at risk across ${files.size} file(s) — ${direct} source, ${tests} test. ${w.suggestion} call get_references({key:'${w.changed_entity_key}', direction:'callers'}) and update every caller before finishing.`
    );
    // CROSS_REPO_INTELLIGENCE Sprint 6.1: name the peer repos that import this
    // entity so the cascade isn't shipped while callers in another repo go
    // unupdated. Names the repos + counts; the agent updates them via the same
    // get_references({scope:'workspace'}) cross-repo path.
    if (w.cross_repo && w.cross_repo.peers.length > 0) {
      const repos = w.cross_repo.peers
        .map((p) => `${p.label} (${p.callers})`)
        .join(", ");
      lines.push(
        `  · plus ${w.cross_repo.total_peer_callers} caller(s) in ${w.cross_repo.peers.length} peer repo(s): ${repos} — run get_references({key:'${w.changed_entity_key}', direction:'callers', scope:'workspace'}) and update those repos too.`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Render computed architecture-boundary crossings into advisory pre-edit lines
 * (P2.1). Each crossing names the actual import and the two communities it
 * spans, plus the engine's actionable suggestion. This WARNS — it never blocks
 * — and is additive to the repo's CI boundary guards (e.g. bridge-isolation):
 * it surfaces a crossing at edit time, before the commit.
 */
function formatBoundaryNudge(violations: BoundaryViolation[]): string {
  const lines: string[] = [];
  lines.push(
    `Editing "${violations[0]!.source_file}" adds ${violations.length} import(s) that cross an architecture boundary:`
  );
  for (const v of violations) {
    lines.push(
      `- ${v.import} — "${v.source_layer}" → "${v.target_layer}". ${v.suggestion}`
    );
  }
  return lines.join("\n");
}

/**
 * Async pre-edit handler: query the proxy's warm graph for the full blast
 * radius of this edit — callers at risk from a signature change AND new imports
 * that cross an architecture boundary — and inject concrete, site-naming nudges.
 * Degrades to the static {@link preEditHandler} nudge when the proxy is
 * unreachable (null) or reports nothing actionable, so behaviour is never worse
 * than today and the edit is never blocked or stalled.
 */
const preEditHandlerAsync: AsyncHookHandler = async (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath)) return passthrough();

  const result = await queryBlastRadius({
    file_path: filePath,
    old_content: (input.old_string as string | undefined) ?? null,
    new_content: (input.new_string as string | undefined) ?? null,
  });

  const warnings = result?.warnings ?? [];
  const boundary = result?.boundary_violations ?? [];

  // null = proxy unreachable/slow; empty on both = nothing actionable from the
  // graph. Either way, fall back to the static nudge (no regression).
  if (!result || (warnings.length === 0 && boundary.length === 0)) {
    return preEditHandler(normalized);
  }

  const sections: string[] = [];
  if (warnings.length > 0) {
    const cascade = formatCascadeNudge(warnings, filePath);
    // Graph-confirmed caller cascade → escalate to deny-once. A signature
    // change with real callers at risk is exactly when
    // get_references({direction:'callers'}) must run BEFORE the edit. An
    // advisory nudge here fires on every edit and is demonstrably ignored
    // (observed ~4 get_references calls against ~147 Edits in 12h); deny is the
    // only lever that drove Grep/Glob/WebFetch adoption to 100% displacement.
    // Deny the first attempt to force the caller sweep, then nudge on the retry
    // so the agent never enters a deny loop (#43189/#47565). Gated on
    // warnings.length>0 — it never fires on edits the graph can't tie to real
    // callers, so there is no blanket-deny noise. Boundary-only edits (warn,
    // never block) stay a nudge below.
    const entityKeys = warnings
      .map((w) => w.changed_entity_key)
      .sort()
      .join(",");
    if (
      shouldEmitOnce(`deny:Edit:${filePath}:${entityKeys}`, DENY_ONCE_TTL_MS)
    ) {
      return deny(
        `${cascade}\n\nThis Edit is blocked once: run get_references({direction:'callers'}) on the entit${
          warnings.length > 1 ? "ies" : "y"
        } above NOW, update every caller in the same change, then re-attempt the Edit (it will proceed).`
      );
    }
    sections.push(cascade);
  }
  if (boundary.length > 0) {
    sections.push(formatBoundaryNudge(boundary));
  }
  return nudge(sections.join("\n\n"));
};

// ── PostToolUse Handlers (agent-agnostic) ────────────────────────────

const postReadHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath)) return passthrough();
  // The read-preference line carries no file-specific content, so emit it once
  // per session — not once per distinct file. Re-billing the identical nudge on
  // every code-file read was pure per-operation tax (#9). File-specific
  // blast-radius signal rides the post-EDIT hook, which keeps its per-file dedup.
  if (!shouldEmitOnce("read-pref:session", VERBOSE_BANNER_TTL_MS))
    return passthrough();

  const isClaudeCode = normalized.agentName === "claude-code";
  if (isClaudeCode) {
    return enrich(
      "ur|fct To change this file call file_edit (no built-in Read needed); to understand it use `file_read` (auto-injects facts/drift)."
    );
  }
  return enrich(
    "ur|fct Prefer `file_read` over built-in Read — it auto-injects conventions, facts, drift."
  );
};

/** Conventions injection (T7.4) dedup window — long enough that one block per
 *  working session is the norm, short enough that a genuinely new session the
 *  next day re-injects. Keyed session-wide (not per-file), unlike the per-file
 *  read nudge. */
const CONVENTIONS_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Async post-read handler (Sprint 7, T7.4). Superset of {@link postReadHandler}:
 * on the first code-file read of a session it ALSO fetches the project's
 * detected conventions over UDS and injects a compact block — replacing the
 * standalone `get_conventions` round-trip (the tool is hidden for agents that
 * accept tool-time context; the injection is their zero-round-trip path). The
 * static read-preference nudge keeps its own per-file dedup. Best-effort: a
 * down/slow proxy yields no conventions block and the nudge still fires.
 */
const postReadHandlerAsync: AsyncHookHandler = async (normalized) => {
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath)) return passthrough();

  // Conventions block — once per session, regardless of which file triggered it.
  let conventionsBlock: string | null = null;
  if (shouldEmitOnce("conventions:session", CONVENTIONS_SESSION_TTL_MS)) {
    try {
      const convs = await queryConventions();
      if (convs) conventionsBlock = renderConventionsBlock(convs);
    } catch {
      conventionsBlock = null;
    }
  }

  // Static read-preference nudge — generic, so once per session (not per file),
  // matching the sync postReadHandler (#9). The conventions block above is
  // already session-scoped.
  let nudgeLine: string | null = null;
  if (shouldEmitOnce("read-pref:session", VERBOSE_BANNER_TTL_MS)) {
    nudgeLine =
      normalized.agentName === "claude-code"
        ? "ur|fct To change this file call file_edit (no built-in Read needed); to understand it use `file_read` (auto-injects facts/drift)."
        : "ur|fct Prefer `file_read` over built-in Read — it auto-injects conventions, facts, drift.";
  }

  // T2.4 — keep the STABLE region (conventions: legend-like, slow-changing)
  // ahead of the VOLATILE region (the per-file read nudge), so the cacheable
  // prefix stays contiguous and the provider prompt cache can hold it. The
  // conventions block is byte-stable per project (orderConventions); the nudge
  // is per-file so it is volatile.
  const { stable, volatile } = splitStableVolatile([
    ...(conventionsBlock
      ? [{ kind: "conventions", text: conventionsBlock }]
      : []),
    ...(nudgeLine ? [{ kind: "notes", text: nudgeLine }] : []),
  ]);

  const parts = [...stable, ...volatile]
    .map((b) => b.text)
    .filter((t) => t.length > 0);
  if (parts.length === 0) return passthrough();
  return enrich(parts.join("\n\n"));
};

const postGrepHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.regex ?? input.query) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();

  const looksLikeFunctionSearch = /^[a-zA-Z_]\w*$/.test(pattern);

  if (looksLikeFunctionSearch) {
    return enrich(
      `You just grepped for "${pattern}". For structured results, try:\n` +
        `- \`get_references "${pattern}"\` — finds ALL callers including indirect references (no false positives from comments/strings)\n` +
        `- \`search_code({query:"${pattern}", detail:true})\` — resolves the entity with its full signature, body, and metadata\n` +
        `- \`search_code "${pattern}"\` — ranked results across the entire codebase in <5ms`
    );
  }

  return enrich(
    "You just grepped for a pattern. For structured code navigation, unerr graph tools are faster and more accurate:\n" +
      "- `search_code` for entity-level search (functions, classes, types)\n" +
      "- `get_references` for reference tracing (no false positives)"
  );
};

const postGlobHandler: HookHandler = () => {
  return enrich(
    "You just found files via Glob. For efficient exploration of matched files:\n" +
      "- `file_outline` on each file — see all entities, imports, and exports without reading full contents (<5ms)\n" +
      "- `search_code` — search for specific entities across all matched files in one call"
  );
};

const postWriteHandler: HookHandler = (normalized) => {
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath)) return passthrough();
  if (!shouldEmitOnce(`Write:${filePath}`)) return passthrough();

  const base = `ur|fct Wrote ${filePath} — get_references on exports to check blast radius`;
  return enrich(appendCoChangeClause(base, filePath));
};

const postEditHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath)) return passthrough();

  // P2.2: record every edit (before the co-change dedup, which would skip a
  // repeat) so the session-end scan can reconcile callers. Best-effort — a
  // failed append never affects the hook result.
  recordEdit(join(process.cwd(), ".unerr"), {
    ts: new Date().toISOString(),
    file_path: filePath,
    old_content: (input.old_string as string | undefined) ?? null,
    new_content: (input.new_string as string | undefined) ?? null,
  });

  if (!shouldEmitOnce(`Edit:${filePath}`)) return passthrough();

  const base = `ur|fct Edited ${filePath} — get_references to check callers of changed entities`;
  return enrich(appendCoChangeClause(base, filePath));
};

/**
 * Async post-edit handler (P1 — Surface A, in-flight review). Records the edit
 * (same as the sync path, so session-end reconcile is unaffected), then asks the
 * proxy's warm graph to run the full review engine over the edit and injects any
 * findings as `ur|<tag>` lines ahead of the co-change fact. Degrades to the
 * co-change nudge alone when the proxy is unreachable or the edit reviews clean,
 * so behaviour is never worse than the sync {@link postEditHandler}. Never
 * blocks — review findings are advisory context the agent acts on before close.
 */
const postEditHandlerAsync: AsyncHookHandler = async (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath)) return passthrough();

  const oldContent = (input.old_string as string | undefined) ?? null;
  const newContent = (input.new_string as string | undefined) ?? null;

  // Record every edit (best-effort) so the session-end scan can reconcile
  // callers — identical to the sync path, before any dedup that would skip it.
  recordEdit(join(process.cwd(), ".unerr"), {
    ts: new Date().toISOString(),
    file_path: filePath,
    old_content: oldContent,
    new_content: newContent,
  });

  // Query the review engine over UDS. null = proxy unreachable → review block
  // is empty and we fall through to the co-change nudge (no regression).
  const review = await queryReviewEdit({
    file_path: filePath,
    old_content: oldContent,
    new_content: newContent,
  });
  const reviewBlock =
    review && !review.clean
      ? formatReviewFindings(review.findings, review.suppressed)
      : "";
  // Tier-2 host-synthesis evidence block (P4): the host model elaborates on
  // unerr's evidence (fix-or-flag) before close. Empty unless a Tier-2 finding
  // fired — rendered after the Tier-1 verdicts, never as a verdict itself.
  const evidenceBlock = review?.evidenceBlock ?? "";

  // Co-change fact: deduped per file like the sync path (one per file per window).
  const base = shouldEmitOnce(`Edit:${filePath}`)
    ? appendCoChangeClause(
        `ur|fct Edited ${filePath} — get_references to check callers of changed entities`,
        filePath
      )
    : "";

  // Tier-1 verdicts lead; the Tier-2 evidence block follows; the co-change fact last.
  const sections = [reviewBlock, evidenceBlock, base].filter(
    (s) => s.length > 0
  );
  if (sections.length === 0) return passthrough();
  return enrich(sections.join("\n"));
};

// ── Public API ───────────────────────────────────────────────────────
// These maintain the same function signatures for backward compatibility
// with hook.ts CLI commands.

export function runPreReadHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preReadHandler);
}

export function runPreGrepHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preGrepHandler);
}

export function runPreGlobHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preGlobHandler);
}

export function runPreWriteHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preWriteHandler);
}

export function runPreEditHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preEditHandler);
}

/**
 * Async pre-edit hook: graph-backed cascade warning over UDS, with static-nudge
 * degradation. This is what the `unerr hook pre-edit` CLI command runs; the sync
 * {@link runPreEditHook} is retained as the degradation target and for callers
 * that can't await.
 */
export function runPreEditHookAsync(stdinJson: string): Promise<string> {
  return runPreToolUseHookAsync(stdinJson, preEditHandlerAsync);
}

export function runPostReadHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postReadHandler);
}

/**
 * Async post-read hook: the static read nudge PLUS a once-per-session
 * conventions injection over UDS (T7.4). This is what the `unerr hook
 * post-read` CLI command runs; the sync {@link runPostReadHook} is retained as
 * the degradation target for callers that can't await.
 */
export function runPostReadHookAsync(stdinJson: string): Promise<string> {
  return runPostToolUseHookAsync(stdinJson, postReadHandlerAsync);
}

export function runPostGrepHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postGrepHandler);
}

export function runPostGlobHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postGlobHandler);
}

export function runPostWriteHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postWriteHandler);
}

export function runPostEditHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postEditHandler);
}

/**
 * Async post-edit hook: graph-backed review over UDS, with co-change-nudge
 * degradation. This is what the `unerr hook post-edit` CLI command runs; the
 * sync {@link runPostEditHook} is retained as the degradation target and for
 * callers that can't await.
 */
export function runPostEditHookAsync(stdinJson: string): Promise<string> {
  return runPostToolUseHookAsync(stdinJson, postEditHandlerAsync);
}
